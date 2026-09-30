'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync, writeJsonSync, readJsonIfExists, escapeXml } = require('../core/util');
const { normalizeServer } = require('./webdav');

/*
 * Publishing guides as Confluence pages, on Confluence Cloud or a Confluence
 * Data Center / Server site (the usual choice inside organizations and on
 * government networks).
 *
 * Sign-in, by site:
 *   Cloud        email address + API token (Basic auth)
 *   Data Center  personal access token (Bearer), or "Sign in with your
 *                browser": the site's own login page in a StepForge window,
 *                for single sign-on. Its cookies stay in StepForge's own
 *                Confluence session.
 *
 * Smart cards (CAC/PIV): a site that asks for a client certificate gets one
 * from the operating system's certificate store, the same way a browser
 * does, and the system shows its usual PIN prompt. Chromium only asks for a
 * certificate from a page, so when a request fails with
 * ERR_SSL_CLIENT_AUTH_CERT_NEEDED the site is opened once in a hidden
 * window (`openHiddenPage`) to make that handshake, then the request is
 * retried. Chromium remembers the choice for the session.
 *
 * All requests go to the site's own address and never follow redirects, so
 * a token can't be sent anywhere else.
 */

const CERT_NEEDED = /ERR_SSL_CLIENT_AUTH_CERT_NEEDED/;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function friendlyNetworkError(err, host) {
  const message = String(err?.message || err);
  if (/CLIENT_AUTH_CERT_NEEDED|BAD_SSL_CLIENT_AUTH_CERT|CLIENT_AUTH_CERT_TYPE_UNSUPPORTED/.test(message)) {
    return `${host} asked for your smart card (CAC) certificate, but none was accepted. Insert your card, check that your computer’s smart card software is working (your browser can open the site), and try again.`;
  }
  if (/CLIENT_AUTH_SIGNATURE_FAILED|CLIENT_AUTH_PRIVATE_KEY_ACCESS_DENIED|CLIENT_AUTH_NO_COMMON_ALGORITHMS/.test(message)) {
    return `Your smart card couldn’t sign in to ${host}. Check the card is inserted, enter your PIN when asked, and try again.`;
  }
  if (/CERT_AUTHORITY_INVALID|CERT_COMMON_NAME_INVALID|CERT_DATE_INVALID|CERT_INVALID/.test(message)) {
    return `StepForge doesn’t trust ${host}’s security certificate. If your organization uses its own certificates (for example DoD root certificates), they need to be installed on this computer, as they are for your browser.`;
  }
  return `Couldn’t reach ${host}. Check the address and your network connection.`;
}

/** The site address as typed, and whether it's Confluence Cloud. */
function normalizeSite(input) {
  const url = normalizeServer(input);
  const cloud = /\.atlassian\.net$/i.test(url.hostname);
  if (cloud) {
    url.pathname = '/wiki/';
  } else {
    // An address copied from a page, e.g. …/display/SPACE/Page or …/pages/viewpage.action?…
    url.pathname = url.pathname.replace(/\/(display|pages|spaces|wiki\/spaces|dashboard\.action|plugins)(\/.*)?$/, '/');
  }
  return { baseUrl: url.href.replace(/\/+$/, ''), cloud };
}

/**
 * The page to publish, from a Confluence export's rest-api folder. Exported
 * screenshots are named after step titles, which can hold private details;
 * on the site they're just step-001.png and so on.
 */
function pageFromExport(apiDir) {
  const request = JSON.parse(fs.readFileSync(path.join(apiDir, 'page-datacenter.json'), 'utf8'));
  let body = request.body.storage.value;
  const attachmentDir = path.join(apiDir, 'attachments');
  const attachments = (fs.existsSync(attachmentDir) ? fs.readdirSync(attachmentDir) : [])
    .filter((file) => /^\d{3}-.*\.png$/.test(file)).sort().map((file) => {
      const name = `step-${file.slice(0, 3)}.png`;
      body = body.split(`ri:filename="${escapeXml(file)}"`).join(`ri:filename="${name}"`);
      return { name, data: fs.readFileSync(path.join(attachmentDir, file)) };
    });
  return { title: request.title, body, attachments };
}

function multipart(fileName, data, contentType = 'image/png') {
  const boundary = `stepforge${crypto.randomBytes(12).toString('hex')}`;
  const safeName = fileName.replace(/["\r\n\\]/g, '_');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const minor = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="minorEdit"\r\n\r\ntrue\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, data, minor]), contentType: `multipart/form-data; boundary=${boundary}` };
}

class Confluence {
  /**
   * `fetchImpl` makes requests in StepForge's Confluence session (with its
   * cookies and client certificates). `openHiddenPage(url)` loads a page in
   * that session without showing it; `openLoginWindow(url, { signedIn })`
   * shows the site so the user can sign in, and closes once `signedIn()`
   * resolves true.
   */
  constructor({ directory, safeStorage, fetchImpl, openHiddenPage = async () => {}, openLoginWindow = async () => false, openExternal = async () => {}, onStatus = () => {} }) {
    Object.assign(this, { safeStorage, openHiddenPage, openLoginWindow, openExternal, onStatus });
    this.fetch = fetchImpl;
    this.file = path.join(directory, 'confluence.credentials');
    this.pagesFile = path.join(directory, 'confluence-pages.json');
    this.credentials = null;
    this.loadError = null;
    this.controllers = new Set();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      this.requireEncryption();
      this.credentials = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file)));
    } catch {
      this.loadError = 'Your saved Confluence sign-in couldn’t be unlocked. Disconnect and sign in again.';
    }
  }

  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Confluence sign-in requires an operating-system credential store. Unlock your keyring and restart StepForge.');
    }
  }

  save() {
    this.requireEncryption();
    atomicWriteFileSync(this.file, this.safeStorage.encryptString(JSON.stringify(this.credentials)));
    this.loadError = null;
    this.onStatus(this.status());
  }

  get host() {
    try { return new URL(this.credentials?.baseUrl || this.pending?.baseUrl).host; } catch { return 'Confluence'; }
  }

  status() {
    const c = this.credentials;
    return {
      connected: Boolean(c),
      error: this.loadError,
      site: c?.baseUrl || '',
      host: c ? this.host : '',
      cloud: Boolean(c?.cloud),
      method: c?.method || '',
      user: c?.user?.displayName || '',
      space: c?.space || null,
      parent: c?.parent || null,
    };
  }

  cancel() {
    for (const controller of this.controllers) controller.abort();
    this.signingIn?.cancel();
  }

  disconnect() {
    this.cancel();
    this.credentials = null;
    this.loadError = null;
    fs.rmSync(this.file, { force: true });
    this.onStatus(this.status());
    return this.status();
  }

  // ---- requests ---------------------------------------------------------------

  authHeaders(login = this.credentials) {
    if (!login) return {};
    if (login.method === 'cloud-token') return { Authorization: `Basic ${Buffer.from(`${login.email}:${login.token}`).toString('base64')}` };
    if (login.method === 'token') return { Authorization: `Bearer ${login.token}` };
    return {}; // browser sign-in: the session's cookies
  }

  /**
   * A request to the site. `target` is a path under the site address.
   * Options: json, body (Buffer), contentType, login (credentials to use),
   * timeout, allowMissing (404 → null).
   */
  async request(target, { method = 'GET', json, body, contentType, login = this.credentials, timeout = 60000, allowMissing = false } = {}, retried = false) {
    const base = login?.baseUrl;
    const url = new URL(`${base}${target}`);
    if (url.origin !== new URL(base).origin) throw new Error('StepForge only talks to your Confluence site.');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = { Accept: 'application/json', 'X-Atlassian-Token': 'no-check', ...this.authHeaders(login) };
    let payload = body;
    if (json !== undefined) { payload = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
    else if (contentType) headers['Content-Type'] = contentType;
    let response;
    try {
      response = await this.fetch(url.href, { method, headers, body: payload, redirect: 'manual', credentials: 'include', signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error('The Confluence request was cancelled or took too long.');
      if (CERT_NEEDED.test(err.message) && !retried) {
        // The site wants a smart card certificate: let a page make the handshake, then retry.
        await this.openHiddenPage(`${new URL(base).origin}/`);
        return this.request(target, { method, json, body, contentType, login, timeout, allowMissing }, true);
      }
      throw new Error(friendlyNetworkError(err, url.host));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new Error(login?.method === 'browser'
        ? 'Your Confluence sign-in has expired. Sign in again in Settings → Accounts → Confluence.'
        : 'Confluence sent StepForge to a sign-in page. Check your token, or use “Sign in with your browser”.'), { status: 401 });
    }
    if (response.status === 404 && allowMissing) return null;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const detail = data?.message || data?.errors?.[0]?.title || data?.errorMessage || '';
      const error = new Error(response.status === 401 ? 'Confluence didn’t accept the sign-in. Check the token, or sign in again.'
        : response.status === 403 ? `You don’t have permission to do that in Confluence${detail ? ` (${detail})` : ''}.`
          : `Confluence request failed (${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}).`);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    if (json === undefined && data === null && text && /<html/i.test(text)) {
      throw Object.assign(new Error('Confluence sent StepForge to a sign-in page. Sign in again.'), { status: 401 });
    }
    return data;
  }

  // ---- signing in -------------------------------------------------------------

  /** What kind of site an address is, and where its tokens are made. */
  probe(address) {
    const { baseUrl, cloud } = normalizeSite(address);
    return {
      baseUrl,
      cloud,
      tokenUrl: cloud ? 'https://id.atlassian.com/manage-profile/security/api-tokens' : `${baseUrl}/plugins/personalaccesstokens/usertokens.action`,
    };
  }

  async currentUser(login) {
    const user = await this.request('/rest/api/user/current', { login });
    if (!user || user.type === 'anonymous' || (!user.displayName && !user.accountId && !user.username)) {
      throw Object.assign(new Error('Confluence didn’t accept the sign-in.'), { status: 401 });
    }
    return { displayName: user.displayName || user.publicName || user.username || 'Confluence user', id: user.accountId || user.userKey || user.username || '' };
  }

  /** Sign in with a token: { address, token, email } (email for Cloud). */
  async connect({ address, token = '', email = '' }) {
    this.requireEncryption();
    const site = this.probe(address);
    if (!token.trim()) throw new Error(site.cloud ? 'Enter your Atlassian API token.' : 'Enter your personal access token.');
    if (site.cloud && !/^[^@\s]+@[^@\s]+$/.test(email.trim())) throw new Error('Enter the email address you sign in to Atlassian with.');
    const login = { baseUrl: site.baseUrl, cloud: site.cloud, method: site.cloud ? 'cloud-token' : 'token', token: token.trim(), email: email.trim() };
    const user = await this.currentUser(login);
    this.credentials = { ...login, user, space: null, parent: null };
    this.save();
    return this.status();
  }

  /**
   * Sign in on the site's own login page (single sign-on, smart card), for
   * Data Center sites without personal access tokens.
   */
  async connectWithBrowser({ address }) {
    this.requireEncryption();
    const site = this.probe(address);
    if (site.cloud) throw new Error('For Confluence Cloud, use your email address and an API token.');
    const login = { baseUrl: site.baseUrl, cloud: false, method: 'browser' };
    let user = null;
    const signedIn = async () => {
      try { user = await this.currentUser(login); return true; } catch { return false; }
    };
    if (!(await signedIn())) {
      const finished = await this.openLoginWindow(`${site.baseUrl}/`, { signedIn });
      if (!finished || !user) throw new Error('Confluence sign-in wasn’t completed. Try again.');
    }
    this.credentials = { ...login, user, space: null, parent: null };
    this.save();
    return this.status();
  }

  requireSite() {
    if (!this.credentials) throw new Error(this.loadError || 'Connect Confluence in Settings → Accounts → Confluence first.');
    return this.credentials;
  }

  // ---- spaces and pages ---------------------------------------------------------

  async spaces() {
    const site = this.requireSite();
    const spaces = [];
    if (site.cloud) {
      let next = '/api/v2/spaces?limit=250&sort=name';
      while (next && spaces.length < 1000) {
        const page = await this.request(next);
        spaces.push(...(page?.results || []).map((s) => ({ key: s.key, name: s.name, id: String(s.id) })));
        next = page?._links?.next?.replace(/^\/wiki/, '') || '';
      }
    } else {
      for (let start = 0; start < 1000; start += 100) {
        const page = await this.request(`/rest/api/space?limit=100&start=${start}`);
        const results = page?.results || [];
        spaces.push(...results.map((s) => ({ key: s.key, name: s.name, id: String(s.id || '') })));
        if (results.length < 100) break;
      }
    }
    return spaces.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Pages in a space whose title contains `query`, to pick a parent page. */
  async findPages({ spaceKey, query }) {
    this.requireSite();
    const escape = (text) => String(text).replace(/["\\]/g, (c) => `\\${c}`);
    const cql = `space = "${escape(spaceKey)}" and type = page${query.trim() ? ` and title ~ "${escape(query.trim())}*"` : ''} order by title`;
    const page = await this.request(`/rest/api/content/search?limit=25&cql=${encodeURIComponent(cql)}`);
    return (page?.results || []).map((p) => ({ id: String(p.id), title: p.title }));
  }

  /** Remember where new pages go. */
  setDefaults({ space = null, parent = null }) {
    this.requireSite();
    this.credentials.space = space && { key: String(space.key), name: String(space.name || space.key), id: String(space.id || '') };
    this.credentials.parent = parent && { id: String(parent.id), title: String(parent.title || '') };
    this.save();
    return this.status();
  }

  // Pages published for each guide, by site: { [baseUrl]: { [guideId]: { id, url, spaceKey, title } } }
  publishedPages() { return readJsonIfExists(this.pagesFile, {}); }

  publishedFor(guideId) {
    return this.credentials ? this.publishedPages()[this.credentials.baseUrl]?.[guideId] || null : null;
  }

  rememberPage(guideId, page) {
    const all = this.publishedPages();
    all[this.credentials.baseUrl] = { ...(all[this.credentials.baseUrl] || {}), [guideId]: page };
    writeJsonSync(this.pagesFile, all);
  }

  async getPage(id) {
    const site = this.requireSite();
    if (site.cloud) {
      const page = await this.request(`/api/v2/pages/${encodeURIComponent(id)}`, { allowMissing: true });
      return page && { id: String(page.id), version: page.version?.number || 1, title: page.title };
    }
    const page = await this.request(`/rest/api/content/${encodeURIComponent(id)}?expand=version,space`, { allowMissing: true });
    return page && { id: String(page.id), version: page.version?.number || 1, title: page.title };
  }

  async pageByTitle(space, title) {
    const site = this.requireSite();
    if (site.cloud) {
      const page = await this.request(`/api/v2/pages?space-id=${encodeURIComponent(space.id)}&title=${encodeURIComponent(title)}&limit=1`);
      const found = page?.results?.[0];
      return found ? { id: String(found.id), title: found.title } : null;
    }
    const page = await this.request(`/rest/api/content?type=page&spaceKey=${encodeURIComponent(space.key)}&title=${encodeURIComponent(title)}&limit=1`);
    const found = page?.results?.[0];
    return found ? { id: String(found.id), title: found.title } : null;
  }

  pageUrl(page) {
    const links = page?._links || {};
    const base = links.base || this.credentials.baseUrl;
    return links.webui ? `${base}${links.webui}` : `${this.credentials.baseUrl}/pages/viewpage.action?pageId=${encodeURIComponent(page.id)}`;
  }

  async savePage({ existing, space, parentId, title, body }) {
    const site = this.requireSite();
    if (site.cloud) {
      if (existing) {
        return this.request(`/api/v2/pages/${encodeURIComponent(existing.id)}`, { method: 'PUT', json: {
          id: existing.id, status: 'current', title, spaceId: space.id, ...(parentId ? { parentId } : {}),
          body: { representation: 'storage', value: body }, version: { number: existing.version + 1, message: 'Updated from StepForge' } } });
      }
      return this.request('/api/v2/pages', { method: 'POST', json: {
        spaceId: space.id, status: 'current', title, ...(parentId ? { parentId } : {}), body: { representation: 'storage', value: body } } });
    }
    const content = { type: 'page', title, space: { key: space.key }, ...(parentId ? { ancestors: [{ id: parentId }] } : {}),
      body: { storage: { value: body, representation: 'storage' } } };
    if (existing) {
      return this.request(`/rest/api/content/${encodeURIComponent(existing.id)}`, { method: 'PUT',
        json: { id: existing.id, ...content, version: { number: existing.version + 1, message: 'Updated from StepForge' } } });
    }
    return this.request('/rest/api/content', { method: 'POST', json: content });
  }

  async uploadAttachment(pageId, fileName, data) {
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`The screenshot ${fileName} is too large to upload.`);
    const base = `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    const existing = await this.request(`${base}?filename=${encodeURIComponent(fileName)}`);
    const found = existing?.results?.find((a) => a.title === fileName);
    const { body, contentType } = multipart(fileName, data);
    return this.request(found ? `${base}/${encodeURIComponent(found.id)}/data` : base, { method: 'POST', body, contentType, timeout: 300000 });
  }

  /**
   * Create or update the guide's page. `page` is { title, body (storage
   * format), attachments: [{ name, data }] }. With `replace` a page that
   * already has this title (and wasn't published from this guide) is
   * updated; otherwise that's reported as { conflict }.
   */
  async publish({ guideId, space, parent = null, page, replace = false, onProgress = () => {} }) {
    this.requireSite();
    if (!space?.key) throw new Error('Choose a Confluence space for this guide.');
    let existing = null;
    const known = this.publishedFor(guideId);
    if (known && known.spaceKey === space.key) existing = await this.getPage(known.id);
    if (!existing) {
      const same = await this.pageByTitle(space, page.title);
      if (same && !replace) return { conflict: { title: same.title, space: space.name || space.key } };
      if (same) existing = await this.getPage(same.id);
    }
    onProgress({ stage: 'page' });
    let saved;
    try {
      saved = await this.savePage({ existing, space, parentId: parent?.id || null, title: page.title, body: page.body });
    } catch (err) {
      if (err.status === 400 && /title/i.test(err.detail || '')) return { conflict: { title: page.title, space: space.name || space.key } };
      throw err;
    }
    const pageId = String(saved.id);
    const total = page.attachments.reduce((n, a) => n + a.data.length, 0);
    let loaded = 0;
    for (const [index, attachment] of page.attachments.entries()) {
      onProgress({ stage: 'upload', index: index + 1, count: page.attachments.length, loaded, total });
      await this.uploadAttachment(pageId, attachment.name, attachment.data);
      loaded += attachment.data.length;
    }
    onProgress({ stage: 'upload', index: page.attachments.length, count: page.attachments.length, loaded: total, total });
    const result = { id: pageId, url: this.pageUrl(saved), spaceKey: space.key, title: page.title, updated: Boolean(existing), publishedAt: new Date().toISOString() };
    this.rememberPage(guideId, result);
    return result;
  }
}

module.exports = { Confluence, normalizeSite, multipart, friendlyNetworkError, pageFromExport };
