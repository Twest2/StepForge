'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync, writeJsonSync, readJsonIfExists, slugify } = require('../core/util');
const { normalizeServer } = require('./webdav');
const { check: c, isPlainArgs } = require('./security');

/*
 * Publishing guides as Wiki.js 2 pages, through the wiki's GraphQL API.
 *
 * Sign-in, either:
 *   API key            made under Administration → API Access, sent as a
 *                      Bearer token.
 *   username/password  for the wiki's form sign-ins (local accounts, LDAP).
 *                      authentication.login returns a short-lived token
 *                      (30 minutes by default), kept in memory only; the
 *                      password is kept so StepForge can sign in again
 *                      before each publish and when the token runs out.
 *
 * Two-step verification: login answers mustProvideTFA with a continuation
 * token, and authentication.loginTFA trades it and the code from the user's
 * authenticator app for the sign-in token. Signing in again would need a new
 * code, so for these accounts (`twoStep`) the token is stored encrypted with
 * the password and used for as long as Wiki.js renews it: a token that ran
 * out within the wiki's renewal period (14 days by default) is accepted and
 * a new one sent back in the new-jwt header. Only when that stops working is
 * the user asked for a code again.
 *
 * Secrets are stored encrypted with the operating system's credential store
 * (Electron safeStorage), with a copy in the OS user's keyring (app/
 * credential-vault.js) so an update or reinstall doesn't lose them.
 *
 * Screenshots go to an asset folder matching the page path, uploaded through
 * the wiki's /u endpoint, so their addresses sit beside the page's.
 *
 * All requests go to the site's own address and never follow redirects, so
 * a key or password can't be sent anywhere else.
 */

const MAX_ASSET_BYTES = 100 * 1024 * 1024;
// Sign in again this long before the token expires, so a publish doesn't
// start with a token that runs out halfway.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const VAULT_KEY = 'wikijs';

// First path segments Wiki.js keeps for itself (server/app/data.yml
// reservedPaths, plus its own routes), and language codes, which it reads
// as the page's locale.
const RESERVED_SEGMENTS = ['login', 'logout', 'register', 'verify', 'favicons', 'fonts', 'img', 'js', 'svg', 'graphql', 'healthz'];
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

// Wiki.js wants a code from the user's authenticator app. publish() and
// connect() answer { needsCode } instead, so the user can be asked for one.
const needsCode = () => Object.assign(new Error('Enter the 6-digit code from your authenticator app.'), { needsCode: true });

// Wiki.js error codes (server/helpers/error.js).
const CODES = { authFailed: 1002, authRequired: 1019, folderExists: 2002, duplicate: 6002, notFound: 6003, illegalPath: 6005,
  createForbidden: 6008, updateForbidden: 6009, deleteForbidden: 6010, viewForbidden: 6013 };

function friendlyNetworkError(err, host) {
  const message = `${err?.message || err} ${err?.cause?.code || ''} ${err?.cause?.message || ''}`;
  if (/CERT_|_CERT\b|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|SSL_PROTOCOL/i.test(message)) {
    return `StepForge doesn’t trust ${host}’s security certificate. If your organization uses its own certificates, they need to be installed on this computer, as they are for your browser.`;
  }
  return `Couldn’t reach ${host}. Check the address and your network connection.`;
}

/** The wiki's address. Wiki.js 2 runs at the root of its site, so any page's address will do. */
function normalizeSite(input) {
  return normalizeServer(input).origin;
}

/** A guide title as a page name: lowercase words joined by dashes. */
function pageSlug(title) {
  return slugify(title, 'guide').replace(/[._]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'guide';
}

/**
 * The page path as typed, the way Wiki.js stores it: no leading or trailing
 * slash, lowercase so it matches the asset folder (Wiki.js lowercases folder
 * names), spaces as dashes. Throws a readable error for paths Wiki.js
 * refuses or can't show.
 */
function normalizePagePath(input) {
  const text = String(input || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
    .toLowerCase().replace(/\s+/g, '-');
  if (!text) throw new Error('Enter where the page goes, such as guides/reset-a-password.');
  const segments = text.split('/');
  if (segments.some((segment) => !/^[\p{L}\p{N}_-]+$/u.test(segment))) {
    throw new Error('Use only letters, numbers, dashes and underscores in the page path, with / between folders.');
  }
  const [first] = segments;
  if (first.length <= 1 || LOCALE_SEGMENT.test(first) || RESERVED_SEGMENTS.includes(first) || first.startsWith('_')) {
    throw new Error(`Wiki.js keeps “${first}” for itself, so a page path can’t start with it. Try guides/${segments.slice(1).join('/') || 'my-guide'}.`);
  }
  if (text.length > 255) throw new Error('That page path is too long.');
  return text;
}

function normalizeLocale(input) {
  const locale = String(input || '').trim().toLowerCase() || 'en';
  if (!LOCALE_SEGMENT.test(locale)) throw new Error('Enter a language code such as en, de or pt-br.');
  return locale;
}

/** The folder part of a page path ("" for a page at the top). */
function folderOf(pagePath) {
  return pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')) : '';
}

function decodeToken(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

/**
 * The page to publish, from a Wiki.js export (exporters/wikijs.js with
 * assetFolder set). Exported screenshots are named after step titles, which
 * can hold private details; on the wiki they're just step-001.png and so on.
 */
function pageFromExport(file, assetFolder) {
  let content = fs.readFileSync(file, 'utf8');
  const outDir = path.dirname(file);
  const folder = `/${String(assetFolder).replace(/^\/+|\/+$/g, '')}`;
  const assets = [];
  for (const dir of fs.readdirSync(outDir).filter((name) => name.startsWith('steps-')).sort()) {
    const full = path.join(outDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const image of fs.readdirSync(full).filter((name) => /^\d{3}-.*\.png$/.test(name)).sort()) {
      const name = `step-${image.slice(0, 3)}.png`;
      content = content.split(`(${folder}/${image})`).join(`(${folder}/${name})`);
      assets.push({ name, data: fs.readFileSync(path.join(full, image)) });
    }
  }
  return { content, assets };
}

/** The /u upload: the folder first, then the file, both in "mediaUpload" fields. */
function uploadBody(folderId, fileName, data, contentType = 'image/png') {
  const boundary = `stepforge${crypto.randomBytes(12).toString('hex')}`;
  const safeName = fileName.replace(/["\r\n\\]/g, '_');
  const folder = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mediaUpload"\r\n\r\n${JSON.stringify({ folderId })}\r\n`);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mediaUpload"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([folder, head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

const sameTime = (a, b) => Boolean(a && b) && (a === b || Date.parse(a) === Date.parse(b));

const PAGE_FIELDS = 'id path locale title editor updatedAt authorName scriptCss scriptJs tags { tag }';

class WikiJs {
  /** `fetchImpl` is the network (Electron's, in a session of its own); `vault` keeps a backup of the sign-in. */
  constructor({ directory, safeStorage, fetchImpl = globalThis.fetch, vault = null, onStatus = () => {} }) {
    Object.assign(this, { safeStorage, vault, onStatus });
    this.fetch = fetchImpl;
    this.file = path.join(directory, 'wikijs.credentials');
    this.pagesFile = path.join(directory, 'wikijs-pages.json');
    this.credentials = null;
    this.loadError = null;
    this.session = null; // { token, expires } for password sign-in
    this.controllers = new Set();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      this.requireEncryption();
      this.restore(JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file))));
    } catch {
      this.loadError = 'Your saved Wiki.js sign-in couldn’t be unlocked. Sign in again.';
    }
  }

  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Wiki.js sign-in requires an operating-system credential store. Unlock your keyring and restart StepForge.');
    }
  }

  /** What's stored: the sign-in, plus the session for two-step accounts (see the top of this file). */
  stored() {
    if (!this.credentials) return null;
    return this.credentials.twoStep && this.session ? { ...this.credentials, session: this.session } : this.credentials;
  }

  restore(stored) {
    const { session = null, ...credentials } = stored;
    this.credentials = credentials;
    this.session = credentials.twoStep && session?.token ? session : null;
  }

  save() {
    this.requireEncryption();
    atomicWriteFileSync(this.file, this.safeStorage.encryptString(JSON.stringify(this.stored())));
    this.loadError = null;
    void this.backup();
    this.onStatus(this.status());
  }

  // The OS-user copy keeps the sign-in through an update or reinstall.
  async backup() {
    const secret = this.credentials && JSON.stringify(this.stored());
    if (!this.vault || !secret || this.vaulted === secret) return;
    try {
      await this.vault.write(VAULT_KEY, secret);
      this.vaulted = secret;
    } catch { /* the encrypted file remains the source of the sign-in */ }
  }

  /** Bring back a sign-in the encrypted file lost. Resolves true when it did. */
  async recover() {
    if (!this.vault) return false;
    if (this.credentials) { await this.backup(); return false; }
    let stored;
    try { stored = JSON.parse(await this.vault.read(VAULT_KEY) || 'null'); } catch { return false; }
    if (this.credentials || !stored?.baseUrl || !stored.method) return false;
    this.restore(stored);
    this.vaulted = JSON.stringify(stored);
    try { this.save(); } catch { this.loadError = null; this.onStatus(this.status()); }
    return true;
  }

  get host() {
    try { return new URL(this.credentials?.baseUrl).host; } catch { return 'Wiki.js'; }
  }

  status() {
    const c = this.credentials;
    return {
      connected: Boolean(c),
      error: this.loadError,
      site: c?.baseUrl || '',
      host: c ? this.host : '',
      method: c?.method || '',
      user: c?.method === 'password' ? c.user?.name || c.username : '',
      strategy: c?.method === 'password' ? c.strategyName || '' : '',
      twoStep: Boolean(c?.twoStep),
      // Signed out on the wiki: a code is needed before the next publish.
      needsCode: Boolean(c?.twoStep && !this.session),
    };
  }

  cancel() {
    for (const controller of this.controllers) controller.abort();
  }

  disconnect() {
    this.cancel();
    this.credentials = null;
    this.session = null;
    this.loadError = null;
    this.vaulted = null;
    fs.rmSync(this.file, { force: true });
    void this.vault?.clear(VAULT_KEY).catch(() => {});
    this.onStatus(this.status());
    return this.status();
  }

  requireSite() {
    if (!this.credentials) throw new Error(this.loadError || 'Connect Wiki.js in Settings → Accounts → Wiki.js first.');
    return this.credentials;
  }

  // ---- requests ---------------------------------------------------------------

  /**
   * A request to the site. `target` is a path on it. Options: json, body
   * (Buffer), contentType, token (Bearer), timeout. Resolves with
   * { status, ok, text, data (parsed JSON or null), headers }.
   */
  async request(baseUrl, target, { method = 'GET', json, body, contentType, token = '', timeout = 60000 } = {}) {
    const url = new URL(target, `${baseUrl}/`);
    if (url.origin !== new URL(baseUrl).origin) throw new Error('StepForge only talks to your Wiki.js site.');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = body;
    if (json !== undefined) { payload = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
    else if (contentType) headers['Content-Type'] = contentType;
    let response;
    let text;
    try {
      response = await this.fetch(url.href, { method, headers, body: payload, redirect: 'manual', credentials: 'omit', signal: controller.signal });
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) throw new Error('The Wiki.js request was cancelled or took too long.');
      throw new Error(friendlyNetworkError(err, url.host));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      throw new Error(`${url.host} sent StepForge to another address. Check the site address; StepForge doesn’t follow redirects, so your sign-in stays on your wiki.`);
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, ok: response.ok, text, data, headers: response.headers };
  }

  /** A GraphQL request. Throws on errors, with Wiki.js's error code as `code`. */
  async graphql(baseUrl, query, variables = {}, { token = '', timeout } = {}) {
    const response = await this.request(baseUrl, '/graphql', { method: 'POST', json: { query, variables }, token, timeout });
    const errors = response.data?.errors;
    if (!response.data || (!response.ok && !errors?.length)) {
      // A page that isn't JSON: another kind of site, or a proxy in front of the wiki having trouble.
      throw Object.assign(new Error(response.ok || response.status === 404
        ? `${new URL(baseUrl).host} doesn’t look like a Wiki.js 2 site. Check the address.`
        : `Wiki.js request failed (${response.status}).`), { status: response.status });
    }
    if (errors?.length) {
      const first = errors[0];
      const message = String(first.message || '');
      const code = first.extensions?.exception?.code || null;
      // Sent by Wiki.js before it runs the query, for API keys.
      if (/API is disabled/i.test(message)) throw Object.assign(new Error('API access is turned off on this wiki. An administrator can turn it on under Administration → API Access.'), { auth: true });
      if (/API Key is invalid|revoked/i.test(message)) throw Object.assign(new Error('Wiki.js didn’t accept the API key. It may have expired or been revoked; create a new one under Administration → API Access.'), { auth: true });
      if (/Too many requests/i.test(message)) throw new Error('Wiki.js has had too many sign-in attempts from this computer. Wait a minute and try again.');
      const auth = code === CODES.authRequired || message === 'Forbidden';
      throw Object.assign(new Error(message === 'Forbidden' ? 'You don’t have permission to do that on this wiki.'
        : code === CODES.authRequired ? 'Wiki.js didn’t accept the sign-in. Sign in again.'
          : `Wiki.js: ${message.slice(0, 300)}`), { code, auth, detail: message });
    }
    return { data: response.data.data, renewed: response.headers?.get?.('new-jwt') || '' };
  }

  /** A mutation's responseResult, as an error when it didn't succeed. */
  static check(result, describe = (r) => `Wiki.js: ${r.message}`) {
    const r = result?.responseResult;
    if (!r) throw new Error('Wiki.js sent an unexpected answer.');
    if (!r.succeeded) throw Object.assign(new Error(describe(r)), { code: r.errorCode, slug: r.slug, detail: r.message });
    return result;
  }

  // ---- signing in -------------------------------------------------------------

  /** The wiki's username/password sign-ins (local accounts, LDAP…), without signing in. */
  async strategies(baseUrl) {
    const { data } = await this.graphql(baseUrl, `{ authentication { activeStrategies(enabledOnly: true) {
      key displayName order isEnabled strategy { key useForm usernameType } } } }`);
    const list = data?.authentication?.activeStrategies;
    if (!Array.isArray(list)) throw new Error(`${new URL(baseUrl).host} doesn’t look like a Wiki.js 2 site. Check the address.`);
    return list.filter((s) => s.isEnabled !== false && s.strategy?.useForm)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((s) => ({ key: String(s.key), name: String(s.displayName || s.strategy.key), usernameType: s.strategy.usernameType === 'email' ? 'email' : 'username' }));
  }

  /** Check an address is a Wiki.js 2 site, and how one signs in to it. */
  async probe(address) {
    const baseUrl = normalizeSite(address);
    const strategies = await this.strategies(baseUrl);
    return { baseUrl, host: new URL(baseUrl).host, strategies, apiKeyUrl: `${baseUrl}/a/api` };
  }

  /**
   * Sign in with a username and password, and for two-step accounts `code`
   * from the authenticator app: a fresh token ({ token, expires, twoStep }),
   * or a readable reason there isn't one. Without a code, a two-step account
   * throws a `needsCode` error.
   */
  async login({ baseUrl, username, password, strategy }, { code = '' } = {}) {
    const { data } = await this.graphql(baseUrl, `mutation ($username: String!, $password: String!, $strategy: String!) {
      authentication { login(username: $username, password: $password, strategy: $strategy) {
        responseResult { succeeded errorCode slug message } jwt mustChangePwd mustProvideTFA mustSetupTFA continuationToken } } }`,
    { username, password, strategy });
    let result = WikiJs.check(data?.authentication?.login, (r) => (r.errorCode === CODES.authFailed
      ? 'Wiki.js didn’t accept that username and password.'
      : `Wiki.js couldn’t sign you in (${r.message}).`));
    if (result.mustSetupTFA) {
      throw new Error('This wiki wants you to set up two-step verification first. Sign in to the wiki in your browser to set it up, then sign in here again.');
    }
    const twoStep = Boolean(result.mustProvideTFA);
    if (twoStep) {
      const securityCode = String(code).replace(/\s+/g, '');
      if (!securityCode) throw needsCode();
      if (!/^\d{6}$/.test(securityCode)) throw new Error('Enter the 6-digit code from your authenticator app.');
      // The continuation token works once, right or wrong, so each code needs a fresh login.
      const answer = await this.graphql(baseUrl, `mutation ($continuationToken: String!, $securityCode: String!) {
        authentication { loginTFA(continuationToken: $continuationToken, securityCode: $securityCode) {
          responseResult { succeeded errorCode slug message } jwt mustChangePwd } } }`,
      { continuationToken: String(result.continuationToken || ''), securityCode });
      result = WikiJs.check(answer.data?.authentication?.loginTFA, (r) => (/TFAFailed/i.test(r.slug)
        ? 'Wiki.js didn’t accept that code. Codes change every 30 seconds; enter the one your app shows now.'
        : /TFAInvalid/i.test(r.slug) ? 'The sign-in took too long. Enter a new code.'
          : `Wiki.js couldn’t sign you in (${r.message}).`));
    }
    if (result.mustChangePwd) {
      throw new Error('Wiki.js wants a new password for this account. Sign in to the wiki in your browser to change it, then try again, or use an API key.');
    }
    if (!result.jwt) throw new Error('Wiki.js didn’t send a sign-in token. Try an API key instead.');
    const expires = (decodeToken(result.jwt)?.exp || 0) * 1000 || Date.now() + 30 * 60 * 1000;
    return { token: result.jwt, expires, twoStep };
  }

  /** A token for `login`: the API key, or a password sign-in's token (signing in again when needed). */
  async token(login = this.requireSite(), { fresh = false } = {}) {
    if (login.method === 'apikey') return login.apiKey;
    const session = login === this.credentials ? this.session : null;
    // Even once it has run out: Wiki.js renews it (see the top of this file).
    if (login.twoStep) {
      if (!fresh && session?.token) return session.token;
      throw needsCode();
    }
    if (!fresh && session && session.expires - Date.now() > TOKEN_MARGIN_MS) return session.token;
    const next = await this.login(login);
    if (login === this.credentials) this.session = { token: next.token, expires: next.expires };
    return next.token;
  }

  /**
   * A two-step account was turned away. If its session still works, the
   * user just isn't allowed to do that (`err` stands); otherwise the session
   * is over and the user is asked for a code.
   */
  async endedSession(login, err) {
    const token = this.session?.token;
    if (token && await this.profile(login.baseUrl, token).then(() => true, () => false)) return err;
    if (login === this.credentials) {
      this.session = null;
      this.save();
    }
    return needsCode();
  }

  /** Sign in again with a code from the authenticator app, after Wiki.js ended the session. */
  async signInAgain({ code }) {
    const login = this.requireSite();
    if (login.method !== 'password') throw new Error('Only a password sign-in uses codes.');
    const session = await this.login(login, { code });
    if (!session.twoStep) throw new Error('Wiki.js didn’t ask for a code. Publish again.');
    login.twoStep = true;
    this.session = { token: session.token, expires: session.expires };
    this.save();
    return this.status();
  }

  /** A GraphQL request as the signed-in user. A password sign-in is renewed once if Wiki.js turns it down. */
  async call(query, variables = {}, options = {}) {
    const login = this.requireSite();
    const run = async (fresh) => {
      const { data, renewed } = await this.graphql(login.baseUrl, query, variables, { ...options, token: await this.token(login, { fresh }) });
      // Wiki.js renews an expired token by itself and sends the new one back.
      if (renewed && login.method === 'password' && login === this.credentials) {
        this.session = { token: renewed, expires: (decodeToken(renewed)?.exp || 0) * 1000 };
        if (login.twoStep) this.save();
      }
      return data;
    };
    try {
      return await run(false);
    } catch (err) {
      if (!err.auth || login.method !== 'password') throw err;
      if (login.twoStep) throw await this.endedSession(login, err);
      return run(true);
    }
  }

  /** Who a token signs in as. Wiki.js treats a token it can't read as a visitor, who has no profile. */
  async profile(baseUrl, token) {
    const { data } = await this.graphql(baseUrl, '{ users { profile { id name email } } }', {}, { token });
    const profile = data?.users?.profile;
    if (!profile) throw new Error('Wiki.js didn’t accept the sign-in.');
    return profile;
  }

  /**
   * Sign in: { address, method: 'apikey', apiKey } or { address, method:
   * 'password', username, password, strategy, code } (strategy may be left
   * out when the wiki has only one; code is for two-step accounts). Resolves
   * with the status, or { needsCode } when Wiki.js wants a code: send the
   * same again with it.
   */
  async connect({ address, method, apiKey = '', username = '', password = '', strategy = '', code = '' }) {
    this.requireEncryption();
    const baseUrl = normalizeSite(address);
    let login;
    if (method === 'apikey') {
      const key = apiKey.trim();
      if (!key) throw new Error('Paste your Wiki.js API key.');
      if (!decodeToken(key)?.api) throw new Error('That isn’t a Wiki.js API key. Create one under Administration → API Access and paste all of it.');
      login = { baseUrl, method, apiKey: key };
      // The answer is the first administrator's profile, whoever made the key, so only its existence counts.
      await this.profile(baseUrl, key).catch((err) => { throw err.code === CODES.authRequired ? new Error('Wiki.js didn’t accept the API key.') : err; });
    } else if (method === 'password') {
      if (!username.trim() || !password) throw new Error('Enter your username and password.');
      const strategies = await this.strategies(baseUrl);
      if (!strategies.length) throw new Error('This wiki only offers single sign-on, so StepForge can’t sign in with a username and password. Use an API key instead.');
      const chosen = strategies.find((s) => s.key === strategy) || (strategies.length === 1 || !strategy ? strategies[0] : null);
      if (!chosen) throw new Error('Choose how to sign in.');
      login = { baseUrl, method, username: username.trim(), password, strategy: chosen.key, strategyName: chosen.name };
      let session;
      try {
        session = await this.login(login, { code });
      } catch (err) {
        if (err.needsCode) return { needsCode: true };
        throw err;
      }
      const profile = await this.profile(baseUrl, session.token);
      login.user = { name: String(profile.name || profile.email || login.username), email: String(profile.email || '') };
      if (session.twoStep) login.twoStep = true;
      this.session = { token: session.token, expires: session.expires };
    } else {
      throw new Error('Choose how to sign in.');
    }
    this.credentials = login;
    this.save();
    return this.status();
  }

  // ---- pages --------------------------------------------------------------------

  // Pages published for each guide, by site:
  // { [baseUrl]: { lastFolder, pages: { [guideId]: { id, path, locale, title, url, updatedAt, publishedAt } } } }
  publishedSites() { return readJsonIfExists(this.pagesFile, {}); }

  publishedFor(guideId) {
    return this.credentials ? this.publishedSites()[this.credentials.baseUrl]?.pages?.[guideId] || null : null;
  }

  rememberPage(guideId, page) {
    const all = this.publishedSites();
    const site = all[this.credentials.baseUrl] || {};
    all[this.credentials.baseUrl] = { ...site, lastFolder: folderOf(page.path), pages: { ...(site.pages || {}), [guideId]: page } };
    writeJsonSync(this.pagesFile, all);
  }

  /** What the publish dialog starts with: the guide's page if it has one, else <last folder>/<guide slug>. */
  defaultsFor(guideId, title) {
    this.requireSite();
    const known = this.publishedFor(guideId);
    const site = this.publishedSites()[this.credentials.baseUrl] || {};
    const folder = typeof site.lastFolder === 'string' ? site.lastFolder : 'guides';
    return {
      path: known?.path || [folder, pageSlug(title)].filter(Boolean).join('/'),
      title: String(title || 'Untitled guide'),
      locale: known?.locale || 'en',
      published: known,
      site: this.credentials.baseUrl,
    };
  }

  pageUrl(pagePath, locale) {
    return `${this.credentials.baseUrl}/${locale}/${pagePath.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * The page at a path, or null. singleByPath needs the "manage pages"
   * permission; people who can only write pages get it from the page list.
   */
  async findPage(pagePath, locale) {
    try {
      const data = await this.call(`query ($path: String!, $locale: String!) { pages { singleByPath(path: $path, locale: $locale) { ${PAGE_FIELDS} } } }`,
        { path: pagePath, locale });
      const page = data?.pages?.singleByPath;
      return page && { id: page.id, path: page.path, locale: page.locale, title: page.title, editor: page.editor, updatedAt: page.updatedAt,
        authorName: page.authorName || '', tags: (page.tags || []).map((t) => t?.tag).filter(Boolean), scriptCss: page.scriptCss, scriptJs: page.scriptJs };
    } catch (err) {
      if (err.code === CODES.notFound) return null;
      if (err.code !== CODES.viewForbidden) throw err;
    }
    const data = await this.call('query ($locale: String) { pages { list(locale: $locale) { id path locale title updatedAt tags } } }', { locale });
    const page = (data?.pages?.list || []).find((p) => p.path === pagePath && p.locale === locale);
    return page ? { id: page.id, path: page.path, locale: page.locale, title: page.title, updatedAt: page.updatedAt, tags: (page.tags || []).filter(Boolean) } : null;
  }

  /** The asset folder for a page path, made if it's missing. Resolves with its id. */
  async assetFolder(pagePath) {
    let parentId = 0;
    for (const slug of pagePath.split('/')) {
      const list = async () => (await this.call('query ($id: Int!) { assets { folders(parentFolderId: $id) { id slug } } }', { id: parentId }))?.assets?.folders || [];
      let folder = (await list()).find((f) => f.slug === slug);
      if (!folder) {
        const data = await this.call('mutation ($id: Int!, $slug: String!) { assets { createFolder(parentFolderId: $id, slug: $slug, name: $slug) { responseResult { succeeded errorCode slug message } } } }',
          { id: parentId, slug });
        const result = data?.assets?.createFolder;
        if (result?.responseResult?.errorCode !== CODES.folderExists) WikiJs.check(result, (r) => `Wiki.js couldn’t make the screenshot folder ${slug} (${r.message}).`);
        folder = (await list()).find((f) => f.slug === slug);
        if (!folder) throw new Error(`Wiki.js couldn’t make the screenshot folder ${slug}. Check that you can upload files to this wiki.`);
      }
      parentId = folder.id;
    }
    return parentId;
  }

  async uploadAsset(folderId, fileName, data) {
    if (data.length > MAX_ASSET_BYTES) throw new Error(`The screenshot ${fileName} is too large to upload.`);
    const send = async (fresh) => {
      const login = this.requireSite();
      const { body, contentType } = uploadBody(folderId, fileName, data);
      return this.request(login.baseUrl, '/u', { method: 'POST', body, contentType, token: await this.token(login, { fresh }), timeout: 300000 });
    };
    let response = await send(false);
    // A visitor can't upload: a password sign-in that ran out is renewed once,
    // and a two-step one whose session ended needs a code.
    if (response.status === 403 && this.credentials.twoStep) {
      const err = await this.endedSession(this.credentials, null);
      if (err) throw err;
    } else if (response.status === 403 && this.credentials.method === 'password') {
      response = await send(true);
    }
    if (response.ok) return;
    const message = response.data?.message || '';
    if (response.status === 413 || /too large/i.test(message || response.text)) {
      throw new Error(`The screenshot ${fileName} is larger than this wiki accepts. An administrator can raise the upload size limit in Wiki.js.`);
    }
    if (response.status === 403) throw new Error('You don’t have permission to upload files to this wiki, so the screenshots can’t be added.');
    throw new Error(`Wiki.js couldn’t upload ${fileName} (${response.status}${message ? `: ${String(message).slice(0, 200)}` : ''}).`);
  }

  async savePage({ existing, path: pagePath, locale, title, description, content }) {
    // The page Wiki.js sends back has no locale (and fails if asked for one).
    const fields = 'responseResult { succeeded errorCode slug message } page { id updatedAt }';
    const common = { content, description, editor: 'markdown', isPublished: true, isPrivate: false, locale, path: pagePath, title };
    if (existing) {
      // Updating keeps a page's editor, so one switched to another editor on the wiki is switched back first.
      if (existing.editor && existing.editor !== 'markdown') {
        const converted = await this.call('mutation ($id: Int!) { pages { convert(id: $id, editor: "markdown") { responseResult { succeeded errorCode slug message } } } }', { id: existing.id });
        WikiJs.check(converted?.pages?.convert, (r) => `Wiki.js couldn’t switch the page back to Markdown (${r.message}).`);
      }
      const data = await this.call(`mutation ($id: Int!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!,
        $locale: String!, $path: String!, $tags: [String]!, $title: String!, $scriptCss: String, $scriptJs: String) {
        pages { update(id: $id, content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate,
          locale: $locale, path: $path, tags: $tags, title: $title, scriptCss: $scriptCss, scriptJs: $scriptJs) { ${fields} } } }`,
      // Tags and page scripts are kept: updating without them would clear them.
      { ...common, id: existing.id, tags: existing.tags || [], scriptCss: existing.scriptCss ?? null, scriptJs: existing.scriptJs ?? null });
      return WikiJs.check(data?.pages?.update, (r) => ([CODES.updateForbidden, CODES.deleteForbidden].includes(r.errorCode)
        ? `You don’t have permission to change the page at ${pagePath}.` : `Wiki.js couldn’t update the page (${r.message}).`)).page;
    }
    const data = await this.call(`mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!,
      $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
      pages { create(content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate,
        locale: $locale, path: $path, tags: $tags, title: $title) { ${fields} } } }`, { ...common, tags: [] });
    // Wiki.js reports a missing write permission on create as "not authorized to delete".
    return WikiJs.check(data?.pages?.create, (r) => ([CODES.createForbidden, CODES.deleteForbidden].includes(r.errorCode)
      ? `You don’t have permission to create pages at ${pagePath}.`
      : r.errorCode === CODES.illegalPath ? 'Wiki.js doesn’t accept that page path.'
        : `Wiki.js couldn’t create the page (${r.message}).`)).page;
  }

  /**
   * Create or update the guide's page. `page` is { content (markdown),
   * assets: [{ name, data }] }, with image links already pointing at the
   * asset folder for `path`. Before anything changes on the wiki:
   *   { edited }    the guide's page was edited on the wiki since it was
   *                 last published from here: its url, and who (by) and
   *                 when it was last edited;
   *   { conflict }  another page already has this path.
   * Both are only replaced with `replace`. { needsCode } means a two-step
   * account was signed out on the wiki: signInAgain(), then publish again.
   */
  async publish(args) {
    try {
      return await this.publishPage(args);
    } catch (err) {
      // Nothing is lost: publishing again after the code picks up where this stopped.
      if (err.needsCode) return { needsCode: true };
      throw err;
    }
  }

  async publishPage({ guideId, path: rawPath, locale: rawLocale = 'en', title, description = '', page, replace = false, onProgress = () => {} }) {
    this.requireSite();
    const pagePath = normalizePagePath(rawPath);
    const locale = normalizeLocale(rawLocale);
    const pageTitle = String(title || '').trim();
    if (!pageTitle) throw new Error('Enter a title for the page.');
    // A password sign-in whose token is missing or about to run out signs
    // in again now. Not on every publish: Wiki.js allows five sign-ins a minute.
    await this.token(this.credentials);
    // A two-step session Wiki.js ended works like a visitor's, who can often
    // still read pages: find that out (or renew it) before anything changes.
    if (this.credentials.twoStep) await this.call('{ users { profile { id } } }');
    const existing = await this.findPage(pagePath, locale);
    const known = this.publishedFor(guideId);
    const ours = Boolean(existing && known && known.id === existing.id);
    if (existing && !replace) {
      if (!ours) return { conflict: { path: pagePath, title: existing.title || pagePath } };
      // The page list has no author, so `by` is empty for writers without "manage pages".
      if (!sameTime(existing.updatedAt, known.updatedAt)) {
        return { edited: { path: pagePath, title: existing.title || pagePath, url: this.pageUrl(pagePath, locale), by: existing.authorName || '', when: existing.updatedAt } };
      }
    }
    const total = page.assets.reduce((n, a) => n + a.data.length, 0);
    if (page.assets.length) {
      onProgress({ stage: 'upload', index: 0, count: page.assets.length, loaded: 0, total });
      const folderId = await this.assetFolder(pagePath);
      let loaded = 0;
      for (const [index, asset] of page.assets.entries()) {
        onProgress({ stage: 'upload', index: index + 1, count: page.assets.length, loaded, total });
        await this.uploadAsset(folderId, asset.name, asset.data);
        loaded += asset.data.length;
      }
      onProgress({ stage: 'upload', index: page.assets.length, count: page.assets.length, loaded: total, total });
    }
    onProgress({ stage: 'page' });
    let saved;
    try {
      saved = await this.savePage({ existing, path: pagePath, locale, title: pageTitle, description: String(description).slice(0, 255), content: page.content });
    } catch (err) {
      // Made by someone else while this guide was being published.
      if (err.code === CODES.duplicate) return { conflict: { path: pagePath, title: pagePath } };
      throw err;
    }
    const updatedAt = saved?.updatedAt || (await this.findPage(pagePath, locale))?.updatedAt || '';
    const result = { id: saved?.id ?? existing?.id, path: pagePath, locale, title: pageTitle, url: this.pageUrl(pagePath, locale),
      updatedAt, publishedAt: new Date().toISOString(), updated: Boolean(existing) };
    const { updated, ...remembered } = result;
    this.rememberPage(guideId, remembered);
    return result;
  }
}

// ---- IPC arguments (main.js) ---------------------------------------------------

const onlyKeys = (a, keys) => isPlainArgs(a) && Object.keys(a || {}).every((key) => keys.includes(key));

/** wikijs:connect: a site and one way of signing in. */
function validConnectArgs(a) {
  return onlyKeys(a, ['address', 'method', 'apiKey', 'username', 'password', 'strategy', 'code']) && c.string(a.address, 2000)
    && c.oneOf(a.method, ['apikey', 'password']) && c.optionalString(a.apiKey, 4000) && c.optionalString(a.username, 320)
    && c.optionalString(a.password, 1000) && c.optionalString(a.strategy, 100) && c.optionalString(a.code, 20);
}

/** wikijs:signInAgain: a code from the authenticator app. */
function validCodeArgs(a) {
  return onlyKeys(a, ['code']) && c.string(a.code, 20);
}

/** wikijs:publish: the guide, where its page goes, and whether to replace what's there. */
function validPublishArgs(a) {
  return onlyKeys(a, ['guideId', 'path', 'title', 'locale', 'replace']) && c.id(a.guideId) && c.string(a.path, 500)
    && c.string(a.title, 500) && a.title.trim().length > 0 && c.optionalString(a.locale, 10)
    && (a.replace === undefined || c.bool(a.replace));
}

module.exports = {
  WikiJs, normalizeSite, normalizePagePath, normalizeLocale, pageSlug, folderOf, pageFromExport, uploadBody, friendlyNetworkError,
  validConnectArgs, validCodeArgs, validPublishArgs,
};
