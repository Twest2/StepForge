'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const { progressBody } = require('../core/transfer-meter');
const { FolderStorage } = require('../core/folder-storage');

/*
 * What OneDrive, Dropbox and Nextcloud/WebDAV sync have in common: sign-in
 * kept in an OS-encrypted file (with an OS-user backup, like Google's),
 * cancellable requests with upload/download progress, and the folder layout
 * in core/folder-storage.js. Each service supplies its sign-in and a small
 * file backend. Google Drive has its own implementation in google-drive.js.
 */

const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
// Long enough for two-step verification or a password reset in the browser.
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

class CloudAccount {
  /**
   * `key` identifies the app registration or server the saved sign-in
   * belongs to; a sign-in saved for another key is not used.
   */
  constructor({ id, label, short = label, key, directory, safeStorage, openExternal, fetchImpl = globalThis.fetch, vault = null }) {
    Object.assign(this, { id, label, short, key, safeStorage, openExternal, vault });
    this.fetch = fetchImpl;
    this.file = path.join(directory, `${id}.credentials`);
    this.credentials = null;
    this.loadError = null;
    this.controllers = new Set();
    this.generation = 0;
    this.storage = new FolderStorage({ backend: this.backend(), cacheFile: path.join(directory, `${id}-files.json`) });
    this.loadFile();
  }

  /** Whether this build can sign in to the service. */
  get available() { return true; }

  /** Identifies the account's data for CloudSync's per-account state. */
  get clientId() { return `${this.id}:${this.credentials?.key || this.key || ''}`; }

  // ---- saved sign-in --------------------------------------------------------

  loadFile() {
    try {
      if (!fs.existsSync(this.file)) return;
      this.requireEncryption();
      const stored = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file)));
      if (this.available && this.accepts(stored)) {
        this.credentials = stored;
        this.loadError = null;
      } else {
        this.loadError = 'Please sign in again to connect this version of StepForge.';
      }
    } catch {
      this.loadError = `Stored ${this.label} sign-in could not be unlocked. Disconnect and sign in again.`;
    }
  }

  /** Whether saved credentials belong to this build's registration. */
  accepts(stored) { return Boolean(stored) && stored.key === this.key; }

  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error(`${this.label} sign-in requires an operating-system credential store. Unlock your keyring and restart StepForge.`);
    }
  }

  save() {
    this.requireEncryption();
    atomicWriteFileSync(this.file, this.safeStorage.encryptString(JSON.stringify(this.credentials)));
    this.loadError = null;
    void this.backup();
  }

  // The OS-user backup keeps the sign-in through an update or reinstall.
  async backup() {
    const credentials = this.credentials;
    const secret = credentials && JSON.stringify(credentials);
    if (!this.vault || !secret || this.vaulted === secret) return;
    try {
      await this.vault.write(this.key, secret);
      if (this.credentials === credentials) this.vaulted = secret;
    } catch { /* the encrypted primary file remains the source of credentials */ }
  }

  recover() {
    this.recovering ||= (async () => {
      if (!this.available || !this.vault) return false;
      if (!this.credentials) this.loadFile();
      if (this.credentials) { await this.backup(); return false; }
      let stored;
      try { stored = JSON.parse(await this.vault.read(this.key) || 'null'); } catch { return false; }
      if (this.credentials || this.signIn || !this.accepts(stored)) return false;
      this.credentials = stored;
      this.loadError = null;
      this.vaulted = JSON.stringify(stored);
      try { this.save(); } catch { /* keep the recovered sign-in for this session */ }
      return true;
    })();
    return this.recovering;
  }

  status() {
    return {
      connected: Boolean(this.credentials),
      available: this.available,
      email: this.credentials?.email || this.credentials?.name || '',
      photoLink: '',
      error: this.loadError,
    };
  }

  cancel() {
    this.generation += 1;
    this.signIn?.cancel();
    for (const controller of this.controllers) controller.abort();
  }

  disconnect() {
    this.cancel();
    this.credentials = null;
    this.loadError = null;
    this.vaulted = null;
    this.storage.clearCache();
    fs.rmSync(this.file, { force: true });
    return this.vault?.clear(this.key).catch(() => {});
  }

  /** Save a completed sign-in. */
  finishSignIn(credentials) {
    this.credentials = { ...credentials, key: this.key };
    try { this.save(); } catch (err) { this.credentials = null; throw err; }
    this.storage.clearCache();
    return this.status();
  }

  // ---- network --------------------------------------------------------------

  /** A readable error for a failed response. `body` is parsed JSON, text, or null. */
  describeError(status, body) {
    const reason = typeof body === 'string' ? '' : body?.error_summary || body?.error?.message || body?.error_description || body?.error?.code || '';
    return `${this.label} request failed (${status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}).`;
  }

  /**
   * Fetch with a deadline that covers the whole transfer. Options:
   * `onProgress(bytes)` for uploads (Buffer body) and binary downloads,
   * `binary` to return a Buffer, `text` for a string, `raw` for the Response,
   * `location` to return a redirect's target, `timeout` in milliseconds.
   */
  async request(url, options = {}) {
    const { onProgress, binary, text, raw, location, timeout, ...fetchOptions } = options;
    const controller = new AbortController();
    this.controllers.add(controller);
    const size = Buffer.isBuffer(fetchOptions.body) ? fetchOptions.body.length : 0;
    // Allow at least 64 KB/s for large transfers.
    const timer = setTimeout(() => controller.abort(), timeout || (binary ? 10 * 60000 : Math.max(60000, size / 64)));
    try {
      const init = { redirect: 'error', ...fetchOptions, signal: controller.signal };
      if (onProgress && Buffer.isBuffer(fetchOptions.body)) {
        init.body = progressBody(fetchOptions.body, onProgress);
        init.duplex = 'half';
        init.headers = { ...fetchOptions.headers, 'Content-Length': String(fetchOptions.body.length) };
      }
      let response;
      try { response = await this.fetch(url, init); }
      catch (err) {
        // fetch reports network failures as a TypeError.
        if (err.name === 'AbortError' || !(err instanceof TypeError)) throw err;
        const error = new Error(`Couldn’t reach ${this.label}. Check your internet connection and try again.`);
        error.transient = true;
        throw error;
      }
      if (raw) return response;
      // With `location` (and redirect: 'manual'), a redirect's target is returned.
      if (location && response.status >= 300 && response.status < 400) return response.headers.get('location') || '';
      if (!response.ok) {
        let body = null;
        try {
          const content = await response.text();
          try { body = JSON.parse(content); } catch { body = content; }
        } catch { /* no body */ }
        const error = new Error(response.status === 401 ? `${this.label} sign-in expired or was revoked. Disconnect and sign in again.`
          : response.status === 507 || /insufficient_space|quotaLimitReached/.test(JSON.stringify(body || ''))
            ? `Your ${this.label} storage is full. Free up space there, then try again.`
            : this.describeError(response.status, body));
        error.status = response.status;
        error.body = body;
        throw error;
      }
      if (binary) {
        const chunks = [];
        let length = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            length += chunk.length;
            if (length > MAX_TRANSFER_BYTES) { controller.abort(); throw new Error('Cloud archive exceeds the 256 MB transfer limit.'); }
            chunks.push(Buffer.from(chunk));
            onProgress?.(length);
          }
        }
        return Buffer.concat(chunks);
      }
      const content = await response.text();
      // Only JSON responses are parsed; WebDAV answers in plain text or XML.
      if (text || !/json/i.test(response.headers.get('content-type') || '')) return text ? content : content || null;
      return content ? JSON.parse(content) : null;
    } catch (err) {
      if (controller.signal.aborted && err.name === 'AbortError') throw new Error(`${this.label} request was cancelled or timed out. Local guides are unchanged.`);
      throw err;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async authorized(url, options = {}) {
    const generation = this.generation;
    if (!this.credentials) throw new Error(this.loadError || `Sign in to ${this.label} first.`);
    const headers = await this.authHeaders();
    if (generation !== this.generation) throw new Error(`${this.label} request cancelled.`);
    try {
      return await this.request(url, { ...options, headers: { ...options.headers, ...headers } });
    } catch (err) {
      if (err.status !== 401 || !this.refreshable) throw err;
      const refreshed = await this.authHeaders(true);
      if (generation !== this.generation) throw new Error(`${this.label} request cancelled.`);
      return this.request(url, { ...options, headers: { ...options.headers, ...refreshed } });
    }
  }

  // ---- OAuth with PKCE ------------------------------------------------------

  /**
   * Browser sign-in with a loopback redirect (RFC 8252). Listens on both
   * loopback addresses, since `localhost` can resolve to either. `ports` are
   * tried in order; 0 picks any free port. Returns { code, verifier, redirectUri }.
   */
  async browserSignIn({ authorizeUrl, ports = [0], host = 'localhost' }) {
    if (this.signIn) this.signIn.cancel();
    const generation = this.generation;
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    const servers = [];
    let timer;
    let rejectCode;
    const attempt = { cancel: () => rejectCode?.(new Error(`${this.label} sign-in cancelled.`)) };
    this.signIn = attempt;
    try {
      const code = new Promise((resolve, reject) => {
        rejectCode = reject;
        timer = setTimeout(() => reject(new Error(`${this.label} sign-in timed out. Try again.`)), SIGN_IN_TIMEOUT_MS);
        this.onCallback = (req, res) => {
          const url = new URL(req.url, 'http://localhost');
          if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) {
            res.writeHead(400).end('Invalid sign-in callback.');
            return;
          }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (url.searchParams.has('error') || !url.searchParams.get('code')) {
            res.end(`${this.label} sign-in was not completed. Return to StepForge.`);
            reject(new Error(`${this.label} sign-in was denied or cancelled.`));
          } else {
            res.end(`Signed in to ${this.label}. You can close this tab and go back to StepForge.`);
            resolve(url.searchParams.get('code'));
          }
        };
      });
      code.catch(() => {});
      const port = await this.listen(servers, ports);
      const redirectUri = `http://${host}:${port}/`;
      if (generation !== this.generation) throw new Error(`${this.label} sign-in cancelled.`);
      void Promise.resolve(this.openExternal(authorizeUrl({ redirectUri, state, challenge }))).catch(() => {});
      return { code: await code, verifier, redirectUri };
    } finally {
      clearTimeout(timer);
      if (this.signIn === attempt) this.signIn = null;
      for (const server of servers) { server.close(); server.closeAllConnections(); }
    }
  }

  async listen(servers, ports) {
    let lastError;
    for (const wanted of ports) {
      const primary = http.createServer((req, res) => this.onCallback(req, res));
      try {
        await new Promise((resolve, reject) => { primary.once('error', reject); primary.listen(wanted, '127.0.0.1', resolve); });
      } catch (err) { lastError = err; continue; }
      servers.push(primary);
      const port = primary.address().port;
      // Best effort: some systems have no IPv6 loopback.
      const secondary = http.createServer((req, res) => this.onCallback(req, res));
      await new Promise((resolve) => { secondary.once('error', resolve); secondary.listen(port, '::1', resolve); });
      if (secondary.listening) servers.push(secondary);
      return port;
    }
    throw new Error(ports.length > 1
      ? `StepForge couldn’t start ${this.label} sign-in because the ports it needs are in use. Close other apps and try again.`
      : lastError?.message || `Couldn’t start ${this.label} sign-in.`);
  }

  async tokenRequest(url, params) {
    return this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  }

  /** Keep what a token response returned, with its expiry time. */
  tokens(response, previous = {}) {
    if (!response?.access_token) throw new Error(`${this.label} did not return an access token. Try signing in again.`);
    return { ...previous, access_token: response.access_token, refresh_token: response.refresh_token || previous.refresh_token,
      expiresAt: Date.now() + Number(response.expires_in || 3600) * 1000 };
  }

  /** A current OAuth access token, refreshed when it's about to expire. */
  async accessToken(force = false) {
    const credentials = this.credentials;
    if (!credentials?.refresh_token) throw new Error(this.loadError || `Sign in to ${this.label} first.`);
    if (!force && credentials.access_token && credentials.expiresAt > Date.now() + 60000) return credentials.access_token;
    this.refreshing ||= (async () => {
      let response;
      try { response = await this.tokenRequest(this.tokenUrl, this.refreshParams(credentials.refresh_token)); }
      catch (err) {
        // A refused refresh token means signing in again; don't retry it.
        if (err.status === 400 || err.status === 401) throw new Error(`${this.label} sign-in expired or was revoked. Disconnect and sign in again.`);
        throw err;
      }
      if (this.credentials !== credentials) throw new Error(`${this.label} account changed during sign-in.`);
      Object.assign(credentials, this.tokens(response, credentials));
      this.save();
      return credentials.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  get refreshable() { return Boolean(this.tokenUrl); }

  async authHeaders(force = false) {
    return { Authorization: `Bearer ${await this.accessToken(force)}` };
  }

  // ---- storage (core/folder-storage.js) --------------------------------------

  listVersions() { return this.storage.listVersions(); }
  listDeletions() { return this.storage.listDeletions(); }
  listParts() { return this.storage.listParts(); }
  upload(file) { return this.storage.upload(file); }
  download(id, options) { return this.storage.download(id, options); }
  deleteFile(id) { return this.storage.deleteFile(id); }
  removeOrphans(options) { return this.storage.removeOrphans(options); }
  quota() { return this.storage.quota(); }

  async account() {
    if (!this.credentials) throw new Error(this.loadError || `Sign in to ${this.label} first.`);
    if (!this.credentials.accountId) await this.loadProfile();
    return this.credentials.accountId;
  }

  async test() {
    const checks = [];
    let probe;
    try {
      await this.authHeaders(true);
      checks.push('Sign-in: passed');
      await this.storage.objects();
      checks.push(`${this.label} storage access: passed`);
      const bytes = crypto.randomBytes(8 * 1024);
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
          await this.deleteFile(probe.id);
          checks.push('Test file cleanup: passed');
        } catch { checks.push('Test file cleanup failed; a small test file remains in StepForge’s folder.'); }
      }
    }
    return { ok: checks.every((line) => !line.includes('failed')), checks };
  }
}

module.exports = { CloudAccount, MAX_TRANSFER_BYTES };
