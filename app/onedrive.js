'use strict';

const { CloudAccount } = require('./cloud-account');
const { resolveCloudApps, ONEDRIVE_CLIENT_PATTERN } = require('./cloud-apps');

/*
 * OneDrive through Microsoft Graph. StepForge only asks for its own app
 * folder (Files.ReadWrite.AppFolder), which OneDrive shows as
 * Apps/StepForge. It can't see anything else in the user's OneDrive. Works
 * with personal and work or school accounts; some organizations require an
 * administrator to approve new apps first.
 */

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const APP_FOLDER = `${GRAPH}/me/drive/special/approot`;
const SCOPE = 'offline_access Files.ReadWrite.AppFolder User.Read';
const SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024;
// Upload-session chunks must be a multiple of 320 KiB.
const CHUNK_BYTES = 32 * 320 * 1024;

const itemPath = (file) => file.split('/').map(encodeURIComponent).join('/');

class OneDrive extends CloudAccount {
  constructor({ clientId = resolveCloudApps().onedriveClientId, ...options }) {
    super({ id: 'onedrive', label: 'OneDrive', key: clientId, ...options });
  }

  get available() { return ONEDRIVE_CLIENT_PATTERN.test(this.key || ''); }
  get tokenUrl() { return `${AUTHORITY}/token`; }
  refreshParams(refreshToken) { return { client_id: this.key, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE }; }

  async connect() {
    if (!this.available) throw new Error('OneDrive sign-in is unavailable in this build of StepForge. Please use a release with OneDrive sign-in enabled.');
    this.requireEncryption();
    const { code, verifier, redirectUri } = await this.browserSignIn({
      authorizeUrl: ({ redirectUri, state, challenge }) => `${AUTHORITY}/authorize?${new URLSearchParams({
        client_id: this.key, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: SCOPE,
        state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })}`,
    });
    const response = await this.tokenRequest(this.tokenUrl, { client_id: this.key, grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPE });
    const tokens = this.tokens(response);
    if (!tokens.refresh_token) throw new Error('Microsoft did not allow StepForge to stay signed in. Sign in again and accept the permissions.');
    this.finishSignIn(tokens);
    try { await this.loadProfile(); } catch (err) { this.disconnect(); throw err; }
    return this.status();
  }

  async loadProfile() {
    const credentials = this.credentials;
    const [drive, me] = await Promise.all([
      this.authorized(`${GRAPH}/me/drive?$select=id`),
      this.authorized(`${GRAPH}/me?$select=displayName,mail,userPrincipalName`).catch(() => ({})),
    ]);
    if (this.credentials !== credentials) throw new Error('OneDrive account changed.');
    if (!drive?.id) throw new Error('Microsoft did not return a OneDrive for this account.');
    Object.assign(credentials, { accountId: drive.id, email: me.mail || me.userPrincipalName || '', name: me.displayName || '' });
    this.save();
  }

  describeError(status, body) {
    const code = body?.error?.code;
    if (status === 403 && /accessDenied/i.test(code || '')) return 'OneDrive refused access. Your organization may need to approve StepForge.';
    return super.describeError(status, body);
  }

  backend() {
    const item = (file) => `${APP_FOLDER}:/${itemPath(file)}:`;
    // Uploads by path normally create the folder too; if not, make it and retry.
    const withFolder = async (file, action) => {
      try { return await action(); } catch (err) {
        if (err.status !== 404 || !file.includes('/')) throw err;
        try {
          await this.authorized(`${APP_FOLDER}/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.split('/')[0], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
        } catch (createErr) { if (createErr.status !== 409) throw createErr; }
        return action();
      }
    };
    return {
      list: async (folder) => {
        const files = [];
        let url = `${item(folder)}/children?${new URLSearchParams({ $select: 'name,size,lastModifiedDateTime,file', $top: '1000' })}`;
        try {
          while (url) {
            const page = await this.authorized(url);
            for (const entry of page.value || []) {
              if (entry.file) files.push({ name: entry.name, size: entry.size, modified: entry.lastModifiedDateTime });
            }
            url = page['@odata.nextLink'] || '';
            if (url && !url.startsWith(`${GRAPH}/`)) throw new Error('OneDrive returned an unexpected page link.');
          }
        } catch (err) {
          if (err.status === 404) return [];
          throw err;
        }
        return files;
      },
      put: async (file, data, { onProgress } = {}) => {
        if (data.length <= SIMPLE_UPLOAD_BYTES) {
          await withFolder(file, () => this.authorized(`${item(file)}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data, onProgress }));
          return;
        }
        const session = await withFolder(file, () => this.authorized(`${item(file)}/createUploadSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) }));
        const target = new URL(session?.uploadUrl || '');
        if (target.protocol !== 'https:') throw new Error('OneDrive returned an unexpected upload destination.');
        // The session URL carries its own authorization.
        for (let start = 0; start < data.length; start += CHUNK_BYTES) {
          const chunk = data.subarray(start, Math.min(data.length, start + CHUNK_BYTES));
          await this.request(target.href, { method: 'PUT', body: chunk,
            headers: { 'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${data.length}` },
            onProgress: onProgress && ((sent) => onProgress(start + sent)) });
        }
      },
      get: async (file, { onProgress } = {}) => {
        // Graph answers with a redirect to a short-lived download link.
        const result = await this.authorized(`${item(file)}/content`, { redirect: 'manual', location: true, binary: true, onProgress });
        if (Buffer.isBuffer(result)) return result;
        const target = new URL(result);
        if (target.protocol !== 'https:') throw new Error('OneDrive returned an unexpected download link.');
        return this.request(target.href, { binary: true, onProgress, redirect: 'follow' });
      },
      remove: async (file) => {
        try { await this.authorized(item(file), { method: 'DELETE' }); }
        catch (err) { if (err.status !== 404) throw err; }
      },
      quota: async () => {
        const drive = await this.authorized(`${GRAPH}/me/drive?$select=quota`);
        const limit = Number(drive?.quota?.total);
        const usage = Number(drive?.quota?.used);
        return { limit: limit > 0 ? limit : null, usage: Number.isFinite(usage) ? usage : null };
      },
    };
  }
}

module.exports = { OneDrive, SCOPE };
