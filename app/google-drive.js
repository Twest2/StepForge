'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const GOOGLE_OAUTH = require('./google-oauth-config.json');

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

class GoogleDrive {
  constructor({ directory, safeStorage, openExternal, clientId = GOOGLE_OAUTH.clientId, fetchImpl = globalThis.fetch }) {
    this.file = path.join(directory, 'google-drive.credentials');
    this.clientId = clientId;
    this.available = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId || '');
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.fetch = fetchImpl;
    this.credentials = null;
    this.loadError = null;
    this.controllers = new Set();
    this.generation = 0;
    try {
      if (fs.existsSync(this.file)) {
        this.requireEncryption();
        const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file)));
        if (this.available && stored.clientId === this.clientId) {
          this.credentials = stored;
          // Discard user-supplied secrets from pre-release builds.
          if (Object.hasOwn(stored, 'clientSecret')) { delete stored.clientSecret; this.save(); }
        } else {
          this.loadError = 'Please sign in again to connect this version of StepForge.';
        }
      }
    } catch {
      this.loadError = 'Stored Google credentials could not be unlocked. Disconnect and sign in again.';
    }
  }

  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Google sign-in requires an operating-system credential store. Unlock your keyring and restart StepForge.');
    }
  }

  save() {
    this.requireEncryption();
    atomicWriteFileSync(this.file, this.safeStorage.encryptString(JSON.stringify(this.credentials)));
    this.loadError = null;
  }

  status() {
    return { connected: Boolean(this.credentials?.refresh_token), available: this.available, email: this.credentials?.email || '', error: this.loadError };
  }

  cancel() {
    this.generation += 1;
    this.cancelLogin?.();
    for (const controller of this.controllers) controller.abort();
  }

  disconnect() {
    this.cancel();
    this.credentials = null;
    this.loadError = null;
    fs.rmSync(this.file, { force: true });
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        let reason = '';
        let description = '';
        
        try {
          const body = await response.json();
        
          reason = typeof body.error === 'string'
            ? body.error
            : body.error?.errors?.[0]?.reason;
        
          description = body.error_description || '';
        } catch {
          /* no raw response in errors */
        }
        const error = new Error(
          response.status === 401 || reason === 'invalid_grant'
            ? 'Google authorization expired or was revoked. Disconnect and sign in again.'
            : `Google Drive request failed (${response.status}${reason ? ': ' + reason : ''}${description ? ' — ' + description : ''}).`
        );
        error.status = response.status;
        throw error;
      }
      // Consume the body here so the deadline covers downloads as well as headers.
      if (options.method === 'DELETE') return null;
      if (options.uploadSession) {
        const location = new URL(response.headers.get('location') || '');
        if (location.origin !== 'https://www.googleapis.com' || !location.pathname.startsWith('/upload/drive/v3/')) {
          throw new Error('Google returned an unexpected upload destination.');
        }
        return location.href;
      }
      if (options.binary) {
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > MAX_ARCHIVE_BYTES) { controller.abort(); throw new Error('Cloud archive exceeds the 256 MB transfer limit.'); }
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      }
      return await response.json();
    } catch (err) {
      if (controller.signal.aborted && err.name === 'AbortError') throw new Error('Google Drive request was cancelled or timed out. Local guides are unchanged.');
      throw err;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async tokenRequest(params) {
    return this.request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
    });
  }

  async connect() {
    if (!this.available) throw new Error('Google sign-in is unavailable in this build of StepForge. Please use a release with Google sign-in enabled.');
    const clientId = this.clientId;
    if (this.cancelLogin) throw new Error('Google sign-in is already in progress.');
    if (this.credentials) throw new Error('Disconnect the current Google account before signing in again.');
    this.requireEncryption();
    const generation = this.generation;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    const server = http.createServer();
    let timer;
    try {
      const codePromise = new Promise((resolve, reject) => {
        this.cancelLogin = () => reject(new Error('Google sign-in cancelled.'));
        server.on('error', reject);
        server.on('request', (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) {
            res.writeHead(400).end('Invalid sign-in callback.');
            return;
          }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (url.searchParams.has('error') || !url.searchParams.get('code')) {
            res.end('Google sign-in was not completed. Return to StepForge.');
            reject(new Error('Google sign-in was denied or cancelled.'));
          } else {
            res.end('Authorization received. Return to StepForge to see the result.');
            resolve(url.searchParams.get('code'));
          }
        });
        timer = setTimeout(() => reject(new Error('Google sign-in timed out. Try again.')), 180000);
      });
      // Attach a rejection handler before awaiting browser/server startup.
      codePromise.catch(() => {});
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirectUri = `http://127.0.0.1:${server.address().port}/`;
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent select_account', state, code_challenge_method: 'S256',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
      if (generation !== this.generation) throw new Error('Google sign-in cancelled.');
      await this.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
      const code = await codePromise;
      const tokens = await this.tokenRequest({ client_id: clientId, code, code_verifier: verifier,
        redirect_uri: redirectUri, grant_type: 'authorization_code' });
      if (generation !== this.generation) throw new Error('Google sign-in cancelled.');
      if (!tokens.refresh_token || (tokens.scope && !tokens.scope.split(' ').includes(SCOPE))) throw new Error('Google did not grant offline Drive access. Sign in again and allow app storage access.');
      this.credentials = { ...tokens, clientId, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
      try { this.save(); } catch (err) { this.credentials = null; throw err; }
      return this.status();
    } finally {
      clearTimeout(timer);
      this.cancelLogin = null;
      server.close();
      server.closeAllConnections();
    }
  }

  async accessToken(force = false) {
    const credentials = this.credentials;
    if (!credentials?.refresh_token) throw new Error(this.loadError || 'Sign in to Google Drive first.');
    if (!force && credentials.access_token && credentials.expiresAt > Date.now() + 60000) return credentials.access_token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const tokens = await this.tokenRequest({ client_id: this.clientId,
          refresh_token: credentials.refresh_token, grant_type: 'refresh_token' });
        if (this.credentials !== credentials) throw new Error('Google account changed during authentication.');
        Object.assign(credentials, tokens, { expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 });
        this.save();
        return credentials.access_token;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async authorized(url, options = {}) {
    const generation = this.generation;
    const token = await this.accessToken();
    if (generation !== this.generation) throw new Error('Google Drive request cancelled.');
    try {
      return await this.request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (err.status !== 401) throw err;
      const refreshed = await this.accessToken(true);
      if (generation !== this.generation) throw new Error('Google Drive request cancelled.');
      return this.request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${refreshed}` } });
    }
  }

  async account() {
    if (this.credentials?.accountId) return this.credentials.accountId;
    const credentials = this.credentials;
    const info = await this.authorized(`${API}/about?fields=user(permissionId,emailAddress)`);
    if (credentials !== this.credentials) throw new Error('Google account changed.');
    if (!info.user?.permissionId) throw new Error('Google did not return an account identity.');
    credentials.accountId = info.user.permissionId;
    credentials.email = info.user.emailAddress || '';
    this.save();
    return credentials.accountId;
  }

  async listVersions() {
    const generation = this.generation;
    const files = [];
    let pageToken = '';
    do {
      if (generation !== this.generation) throw new Error('Google Drive request cancelled.');
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: "trashed = false and appProperties has { key='stepforge' and value='guide-v1' }",
        fields: 'nextPageToken,files(id,name,createdTime,size,appProperties)', pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      const page = await this.authorized(`${API}/files?${query}`);
      files.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async upload({ data, name, properties }) {
    const generation = this.generation;
    if (data.length > MAX_ARCHIVE_BYTES) throw new Error('Cloud archive exceeds the 256 MB transfer limit.');
    if (data.length > 5 * 1024 * 1024) {
      const session = await this.authorized('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,createdTime,appProperties', {
        method: 'POST', uploadSession: true,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.length) },
        body: JSON.stringify({ name, parents: ['appDataFolder'], appProperties: properties }),
      });
      if (generation !== this.generation) throw new Error('Google Drive upload cancelled.');
      return this.authorized(session, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
    }
    const boundary = `stepforge_${crypto.randomBytes(16).toString('hex')}`;
    const metadata = { name, parents: ['appDataFolder'], appProperties: properties };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.authorized('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,appProperties', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
  }

  download(id) { return this.authorized(`${API}/files/${encodeURIComponent(id)}?alt=media`, { binary: true }); }

  async test() {
    const checks = [];
    let probe;
    try {
      await this.accessToken(true);
      checks.push('Authentication and token refresh: passed');
      await this.listVersions();
      checks.push('Drive app storage access: passed');
      const bytes = crypto.randomBytes(32);
      probe = await this.upload({ data: bytes, name: 'StepForge connection test', properties: { stepforge: 'connection-test' } });
      checks.push('Test upload: passed');
      const downloaded = await this.download(probe.id);
      if (!bytes.equals(downloaded)) throw new Error('The test download did not match the uploaded data.');
      checks.push('Test download and integrity: passed');
    } catch (err) {
      checks.push(`Failed: ${err.message}`);
      return { ok: false, checks };
    } finally {
      if (probe) {
        try {
          await this.authorized(`${API}/files/${encodeURIComponent(probe.id)}`, { method: 'DELETE' });
          checks.push('Test file cleanup: passed');
        } catch { checks.push('Test file cleanup failed; a small test file remains in app storage.'); }
      }
    }
    return { ok: checks.every((line) => !line.includes('failed')), checks };
  }
}

module.exports = { GoogleDrive, SCOPE, MAX_ARCHIVE_BYTES };
