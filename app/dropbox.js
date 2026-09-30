'use strict';

const { CloudAccount } = require('./cloud-account');
const { resolveCloudApps, DROPBOX_KEY_PATTERN } = require('./cloud-apps');

/*
 * Dropbox with an "App folder" app: StepForge can only see Apps/StepForge in
 * the user's Dropbox. Sign-in is OAuth with PKCE, so there is no secret.
 */

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';
// Dropbox matches the redirect exactly, port included, so these three are
// registered with the app and tried in order.
const REDIRECT_PORTS = [38461, 38462, 38463];
// Larger files go up in pieces (Dropbox takes up to 150 MB in one request).
const SINGLE_UPLOAD_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 32 * 1024 * 1024;

// Dropbox-API-Arg is a header, so anything outside ASCII must be escaped.
const headerArg = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

class Dropbox extends CloudAccount {
  constructor({ appKey = resolveCloudApps().dropboxAppKey, ...options }) {
    super({ id: 'dropbox', label: 'Dropbox', key: appKey, ...options });
  }

  get available() { return DROPBOX_KEY_PATTERN.test(this.key || ''); }
  get tokenUrl() { return `${API}/oauth2/token`; }
  refreshParams(refreshToken) { return { client_id: this.key, grant_type: 'refresh_token', refresh_token: refreshToken }; }

  async connect() {
    if (!this.available) throw new Error('Dropbox sign-in is unavailable in this build of StepForge. Please use a release with Dropbox sign-in enabled.');
    this.requireEncryption();
    const { code, verifier, redirectUri } = await this.browserSignIn({
      ports: REDIRECT_PORTS,
      authorizeUrl: ({ redirectUri, state, challenge }) => `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
        client_id: this.key, response_type: 'code', redirect_uri: redirectUri, state, code_challenge: challenge,
        code_challenge_method: 'S256', token_access_type: 'offline' })}`,
    });
    const response = await this.tokenRequest(this.tokenUrl, { client_id: this.key, grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, code_verifier: verifier });
    const tokens = this.tokens(response);
    if (!tokens.refresh_token) throw new Error('Dropbox did not allow StepForge to stay signed in. Sign in again.');
    this.finishSignIn(tokens);
    try { await this.loadProfile(); } catch (err) { this.disconnect(); throw err; }
    return this.status();
  }

  async loadProfile() {
    const credentials = this.credentials;
    const account = await this.rpc('users/get_current_account');
    if (this.credentials !== credentials) throw new Error('Dropbox account changed.');
    if (!account?.account_id) throw new Error('Dropbox did not return an account identity.');
    Object.assign(credentials, { accountId: account.account_id, email: account.email || '', name: account.name?.display_name || '' });
    this.save();
  }

  describeError(status, body) {
    if (typeof body?.error_summary === 'string' && /insufficient_space/.test(body.error_summary)) return 'Your Dropbox is full. Free up space there, then try again.';
    return super.describeError(status, body);
  }

  // Dropbox reports a missing file as a 409 "not_found"; treat it as a 404.
  async call(url, options) {
    try { return await this.authorized(url, options); } catch (err) {
      if (err.status === 409 && /not_found/.test(err.body?.error_summary || '')) err.status = 404;
      throw err;
    }
  }

  rpc(endpoint, args = null) {
    return this.call(`${API}/2/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  }

  backend() {
    const content = (endpoint, arg, options = {}) => this.call(`${CONTENT}/2/${endpoint}`, { method: 'POST', ...options,
      headers: { ...options.headers, 'Dropbox-API-Arg': headerArg(arg) } });
    const octets = { 'Content-Type': 'application/octet-stream' };
    return {
      list: async (folder) => {
        const files = [];
        try {
          let page = await this.rpc('files/list_folder', { path: `/${folder}`, limit: 2000 });
          for (;;) {
            for (const entry of page.entries || []) {
              if (entry['.tag'] === 'file') files.push({ name: entry.name, size: entry.size, modified: entry.server_modified });
            }
            if (!page.has_more) break;
            page = await this.rpc('files/list_folder/continue', { cursor: page.cursor });
          }
        } catch (err) {
          if (err.status === 404) return [];
          throw err;
        }
        return files;
      },
      put: async (file, data, { onProgress } = {}) => {
        const commit = { path: `/${file}`, mode: 'overwrite', autorename: false, mute: true };
        if (data.length <= SINGLE_UPLOAD_BYTES) {
          await content('files/upload', commit, { headers: octets, body: data, onProgress });
          return;
        }
        const first = data.subarray(0, CHUNK_BYTES);
        const { session_id: sessionId } = await content('files/upload_session/start', { close: false }, { headers: octets, body: first, onProgress });
        let offset = first.length;
        while (offset < data.length) {
          const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK_BYTES));
          const last = offset + chunk.length >= data.length;
          const at = offset;
          const progress = onProgress && ((sent) => onProgress(at + sent));
          if (last) await content('files/upload_session/finish', { cursor: { session_id: sessionId, offset }, commit }, { headers: octets, body: chunk, onProgress: progress });
          else await content('files/upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, { headers: octets, body: chunk, onProgress: progress });
          offset += chunk.length;
        }
      },
      get: (file, { onProgress } = {}) => content('files/download', { path: `/${file}` }, { binary: true, onProgress }),
      remove: async (file) => {
        try { await this.rpc('files/delete_v2', { path: `/${file}` }); }
        catch (err) { if (err.status !== 404) throw err; }
      },
      quota: async () => {
        const space = await this.rpc('users/get_space_usage');
        const limit = Number(space?.allocation?.allocated);
        const usage = Number(space?.used);
        return { limit: limit > 0 ? limit : null, usage: Number.isFinite(usage) ? usage : null };
      },
    };
  }
}

module.exports = { Dropbox, REDIRECT_PORTS };
