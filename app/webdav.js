'use strict';

const net = require('node:net');
const { CloudAccount } = require('./cloud-account');

/*
 * Nextcloud, ownCloud or any WebDAV server. StepForge keeps its files in a
 * StepForge folder in the account. Nextcloud sign-in uses Login Flow v2:
 * the browser opens the server's own login page and Nextcloud hands
 * StepForge an app password that can be revoked under Settings → Security.
 * Other servers take a user name and password (ideally an app password).
 */

const FOLDER = 'StepForge';
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 20 * 60 * 1000;

const decodeXml = (text) => text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (match, entity) => {
  const named = { lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' }[entity.toLowerCase()];
  if (named) return named;
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : match;
});

/** The entries of a WebDAV multistatus response, whatever namespace prefix the server uses. */
function parseMultistatus(xml) {
  const blocks = xml.match(/<(?:[\w.-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) || [];
  return blocks.map((block) => {
    const value = (name) => {
      const match = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>/]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i').exec(block);
      return match ? decodeXml(match[1].trim()) : '';
    };
    const href = value('href');
    let name = '';
    try { name = decodeURIComponent(new URL(href, 'http://x').pathname.replace(/\/+$/, '').split('/').pop() || ''); } catch { /* skip */ }
    return {
      name,
      collection: /<(?:[\w.-]+:)?collection\b/i.test(block),
      size: Number(value('getcontentlength')) || 0,
      modified: value('getlastmodified'),
      quotaUsed: value('quota-used-bytes'),
      quotaAvailable: value('quota-available-bytes'),
    };
  });
}

// Plain http is only accepted on a home or local network, never across the internet.
function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || !host.includes('.') && !net.isIP(host)) return true;
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(host)) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return net.isIPv6(host) && (host === '::1' || /^f[cd]/.test(host) || /^fe80:/.test(host));
}

/** A server address as typed, as a URL ending in "/". */
function normalizeServer(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter your server’s address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('That doesn’t look like a server address. Try something like cloud.example.com.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an https:// address for your server.');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('Use an https:// address. StepForge only sends your password over an unencrypted connection on your own network.');
  }
  url.search = '';
  url.hash = '';
  // A Nextcloud address copied from the browser often ends in /index.php/apps/files/….
  url.pathname = url.pathname.replace(/\/index\.php(\/.*)?$/, '/').replace(/\/+$/, '') + '/';
  return url;
}

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

class WebDAV extends CloudAccount {
  constructor(options) {
    super({ id: 'webdav', label: 'Nextcloud', key: 'webdav', ...options });
  }

  loadFile() {
    super.loadFile();
    this.label = this.credentials?.kind === 'webdav' ? 'WebDAV' : 'Nextcloud';
  }

  accepts(stored) {
    return Boolean(stored?.key === 'webdav' && stored.davUrl && stored.username && stored.password);
  }

  get tokenUrl() { return ''; }

  async authHeaders() {
    if (!this.credentials) throw new Error(this.loadError || `Sign in to ${this.label} first.`);
    return { Authorization: basic(this.credentials.username, this.credentials.password) };
  }

  status() {
    const status = super.status();
    if (this.credentials) {
      let host = '';
      try { host = new URL(this.credentials.server || this.credentials.davUrl).host; } catch { /* keep it blank */ }
      status.email = host ? `${this.credentials.name || this.credentials.username} on ${host}` : this.credentials.username;
      status.kind = this.credentials.kind;
    }
    return status;
  }

  disconnect() {
    const result = super.disconnect();
    this.label = 'Nextcloud';
    return result;
  }

  describeError(status, body) {
    if (status === 401) return `${this.label} didn’t accept the user name or password.`;
    if (status === 507) return `Your ${this.label} storage is full. Free up space there, then try again.`;
    if (status === 423) return `A file on ${this.label} is locked. Try again in a moment.`;
    return super.describeError(status, typeof body === 'string' ? null : body);
  }

  /**
   * Whether the address is a Nextcloud or ownCloud server. An address typed
   * without https:// on a home network may only answer over plain http.
   */
  async probe(server) {
    const base = normalizeServer(server);
    const candidates = [base];
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(String(server).trim()) && isLocalHost(base.hostname)) {
      const plain = new URL(base.href);
      plain.protocol = 'http:';
      candidates.push(plain);
    }
    for (const candidate of candidates) {
      let status;
      try {
        status = await this.request(new URL('status.php', candidate).href, { timeout: 15000, redirect: 'follow' });
      } catch (err) {
        if (err.transient) continue;
        // It answered, just not as Nextcloud.
        return { kind: 'webdav', server: candidate.href };
      }
      if (status && typeof status === 'object' && status.installed !== undefined) {
        return { kind: 'nextcloud', server: candidate.href, product: String(status.productname || 'Nextcloud').slice(0, 40) };
      }
      return { kind: 'webdav', server: candidate.href };
    }
    throw new Error(`Couldn’t reach ${base.host}. Check the address and your connection.`);
  }

  /**
   * Sign in. Without a user name, a Nextcloud server gets a browser login and
   * any other server returns { needsPassword: true } for the form to ask.
   */
  async connect({ server, username = '', password = '' } = {}) {
    this.requireEncryption();
    const found = await this.probe(server);
    if (!username && found.kind !== 'nextcloud') return { needsPassword: true, server: found.server };
    const base = new URL(found.server);
    let login;
    if (username) {
      if (!password) throw new Error('Enter your password or app password.');
      // Nextcloud and ownCloud serve the signed-in user's files here; any
      // other server's address is its WebDAV folder.
      const davUrl = found.kind === 'nextcloud' ? new URL('remote.php/webdav/', base).href : base.href;
      login = { server: base.href, username, password, davUrl, kind: found.kind };
    } else {
      login = await this.nextcloudLogin(base);
    }
    await this.verify(login);
    this.finishSignIn({ ...login, accountId: `${login.davUrl}|${login.username}` });
    this.label = login.kind === 'webdav' ? 'WebDAV' : 'Nextcloud';
    return this.status();
  }

  async nextcloudLogin(base) {
    const start = await this.request(new URL('index.php/login/v2', base).href, { method: 'POST', headers: { 'User-Agent': 'StepForge' } });
    const loginUrl = new URL(start?.login || '');
    const endpoint = new URL(start?.poll?.endpoint || '');
    const token = start?.poll?.token;
    if (!token || loginUrl.host !== base.host || endpoint.host !== base.host || !['https:', 'http:'].includes(loginUrl.protocol)) {
      throw new Error('This server didn’t start a Nextcloud sign-in. Enter a user name and app password instead.');
    }
    if (this.signIn) this.signIn.cancel();
    const generation = this.generation;
    let cancelled = false;
    const attempt = { cancel: () => { cancelled = true; } };
    this.signIn = attempt;
    try {
      void Promise.resolve(this.openExternal(loginUrl.href)).catch(() => {});
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
        if (cancelled || generation !== this.generation) throw new Error('Nextcloud sign-in cancelled.');
        let result;
        try {
          result = await this.request(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString() });
        } catch (err) {
          if (err.status === 404 || err.transient) continue; // not signed in yet
          throw err;
        }
        if (!result?.loginName || !result?.appPassword) throw new Error('Nextcloud didn’t finish the sign-in. Try again.');
        const server = new URL(result.server && new URL(result.server).host === base.host ? `${String(result.server).replace(/\/+$/, '')}/` : base.href);
        const user = await this.request(new URL('ocs/v2.php/cloud/user?format=json', server).href, {
          headers: { 'OCS-APIRequest': 'true', Accept: 'application/json', Authorization: basic(result.loginName, result.appPassword) } }).catch(() => null);
        const id = user?.ocs?.data?.id || result.loginName;
        return { server: server.href, username: result.loginName, password: result.appPassword, name: user?.ocs?.data?.displayname || '',
          davUrl: new URL(`remote.php/dav/files/${encodeURIComponent(id)}/`, server).href, kind: 'nextcloud' };
      }
      throw new Error('Nextcloud sign-in timed out. Try again.');
    } finally {
      if (this.signIn === attempt) this.signIn = null;
    }
  }

  async verify(login) {
    const response = await this.request(login.davUrl, { method: 'PROPFIND', raw: true,
      headers: { Depth: '0', Authorization: basic(login.username, login.password), 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' });
    if (response.status === 207 || response.ok) return;
    if (response.status === 401) {
      throw new Error(login.kind === 'nextcloud'
        ? 'Nextcloud didn’t accept the user name or password. If you use two-factor sign-in, create an app password under Settings → Security.'
        : 'The server didn’t accept the user name or password.');
    }
    throw new Error(`The server didn’t accept WebDAV requests at ${login.davUrl} (${response.status}). Check the address.`);
  }

  async loadProfile() {
    if (!this.credentials.accountId) this.credentials.accountId = `${this.credentials.davUrl}|${this.credentials.username}`;
  }

  backend() {
    const root = () => new URL(`${FOLDER}/`, this.credentials.davUrl);
    const url = (file) => new URL(file.split('/').map(encodeURIComponent).join('/'), root()).href;
    const propfind = async (target, depth, props) => {
      const xml = await this.authorized(target, { method: 'PROPFIND', text: true,
        headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>${props.map((p) => `<d:${p}/>`).join('')}</d:prop></d:propfind>` });
      return parseMultistatus(xml);
    };
    const makeFolder = async (target) => {
      try { await this.authorized(target, { method: 'MKCOL' }); }
      catch (err) { if (err.status !== 405) throw err; } // 405: it already exists
    };
    return {
      list: async (folder) => {
        try {
          const entries = await propfind(`${url(folder)}/`, '1', ['resourcetype', 'getcontentlength', 'getlastmodified']);
          return entries.filter((entry) => !entry.collection && entry.name).map(({ name, size, modified }) => {
            const time = Date.parse(modified);
            return { name, size, modified: Number.isFinite(time) ? new Date(time).toISOString() : '' };
          });
        } catch (err) {
          if (err.status === 404) return [];
          throw err;
        }
      },
      put: async (file, data, { onProgress } = {}) => {
        const send = () => this.authorized(url(file), { method: 'PUT', text: true, headers: { 'Content-Type': 'application/octet-stream' }, body: data, onProgress });
        try { await send(); } catch (err) {
          // 409: the folder doesn't exist yet.
          if (err.status !== 409 && err.status !== 404) throw err;
          await makeFolder(root().href);
          if (file.includes('/')) await makeFolder(`${url(file.split('/')[0])}/`);
          await send();
        }
      },
      get: (file, { onProgress } = {}) => this.authorized(url(file), { binary: true, onProgress }),
      remove: async (file) => {
        try { await this.authorized(url(file), { method: 'DELETE', text: true }); }
        catch (err) { if (err.status !== 404) throw err; }
      },
      quota: async () => {
        const [entry] = await propfind(this.credentials.davUrl, '0', ['quota-used-bytes', 'quota-available-bytes']);
        const used = Number(entry?.quotaUsed);
        const available = Number(entry?.quotaAvailable);
        // A negative "available" means unknown or unlimited.
        return { limit: entry?.quotaAvailable !== '' && available >= 0 && Number.isFinite(used) ? used + available : null,
          usage: entry?.quotaUsed !== '' && Number.isFinite(used) ? used : null };
      },
    };
  }
}

module.exports = { WebDAV, parseMultistatus, normalizeServer, isLocalHost };
