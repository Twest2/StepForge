'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  WikiJs, normalizeSite, normalizePagePath, normalizeLocale, pageSlug, folderOf, pageFromExport, uploadBody, friendlyNetworkError,
  validConnectArgs, validCodeArgs, validPublishArgs,
} = require('../../app/wikijs');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function safeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, c.update(text), c.final()]); },
    decryptString(bytes) { const c = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([c.update(bytes.subarray(16)), c.final()]).toString(); },
  };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const jwt = (payload) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const ok = (message = 'ok') => ({ succeeded: true, errorCode: 0, slug: 'ok', message });
const fail = (errorCode, slug, message) => ({ succeeded: false, errorCode, slug, message });
// Wiki.js sends thrown errors with its own code under extensions.exception.
const gqlError = (message, code = null) => json({ errors: [{ message, extensions: { code: 'INTERNAL_SERVER_ERROR', exception: { code } } }], data: null });

/**
 * A small Wiki.js 2: GraphQL for sign-in, pages and asset folders, and /u
 * for uploads. `manager: false` makes the signed-in user a plain writer, who
 * can't use pages.singleByPath. A user with `tfa` (their current code) signs
 * in in two steps. A token that ran out within the renewal period is renewed
 * like Wiki.js does: a new one in the new-jwt header of JSON requests, and
 * the request goes ahead.
 */
function wiki({ base = 'https://wiki.example.com', apiKey = jwt({ api: 1, grp: 1 }), strategies = null, manager = true, apiEnabled = true } = {}) {
  const server = {
    base, apiKey, pages: new Map(), folders: [], assets: new Map(), requests: [], logins: 0, nextId: 1, clock: Date.parse('2026-10-01T10:00:00Z'),
    users: { 'casey@example.com': { password: 'hunter2', name: 'Casey Jones' } },
    strategies: strategies || [{ key: 'local', displayName: 'Local', order: 0, isEnabled: true, strategy: { key: 'local', useForm: true, usernameType: 'email' } }],
    tokens: new Set(), loginResult: null, continuations: new Map(), renewalMs: 14 * 24 * 60 * 60 * 1000, uploadsForbidden: false,
  };
  server.issue = (name, expiresInMs = 30 * 60 * 1000) => {
    server.issued = (server.issued || 0) + 1;
    const token = jwt({ id: 7, name, n: server.issued, exp: Math.floor((Date.now() + expiresInMs) / 1000) });
    server.tokens.add(token);
    return token;
  };
  const now = () => new Date(server.clock += 1000).toISOString();
  const whoIs = (auth) => {
    const token = String(auth || '').replace(/^Bearer /, '');
    if (token === server.apiKey) return { api: true };
    if (!server.tokens.has(token)) return null;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const expired = Date.now() - payload.exp * 1000;
    if (expired <= 0) return { user: true };
    return expired < server.renewalMs ? { user: true, renewed: server.issue(payload.name) } : null;
  };
  server.edit = (pagePath, content, authorName = 'Jane Doe') => {
    const page = [...server.pages.values()].find((p) => p.path === pagePath);
    Object.assign(page, { content, authorName, updatedAt: now() });
  };
  server.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    assert.equal(init.redirect, 'manual', 'never follows redirects');
    assert.equal(init.credentials, 'omit', 'keeps no cookies');
    assert.ok(url.startsWith(`${base}/`), `stays on the site: ${url}`);
    const who = whoIs(init.headers?.Authorization);
    if (u.pathname === '/u' && method === 'POST') {
      server.requests.push('upload');
      if (!who || server.uploadsForbidden) return json({ succeeded: false, message: 'You are not authorized to upload files.' }, 403);
      const raw = Buffer.from(init.body).toString('latin1');
      const boundary = /boundary=(.+)$/.exec(init.headers['Content-Type'])[1];
      const parts = raw.split(`--${boundary}`).slice(1, -1);
      assert.equal(parts.length, 2, 'the folder, then the file');
      assert.match(parts[0], /name="mediaUpload"\r\n\r\n\{"folderId":\d+\}\r\n$/);
      const name = /name="mediaUpload"; filename="([^"]+)"/.exec(parts[1])[1];
      const folderId = JSON.parse(/\{"folderId":\d+\}/.exec(parts[0])[0]).folderId;
      const key = `${folderId}/${name}`;
      server.assets.set(key, { folderId, name, updates: (server.assets.get(key)?.updates ?? -1) + 1 });
      return new Response('ok', { status: 200 });
    }
    assert.equal(u.pathname, '/graphql');
    const response = await graphql(init, who);
    if (who?.renewed) response.headers.set('new-jwt', who.renewed);
    return response;
  };
  const graphql = async (init, who) => {
    const { query, variables: v } = JSON.parse(init.body);
    server.requests.push(query.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (who?.api && !apiEnabled) return json({ data: {}, errors: [{ message: 'API is disabled. You must enable it from the Administration Area first.', path: [] }] }, 500);
    if (/activeStrategies/.test(query)) return json({ data: { authentication: { activeStrategies: server.strategies } } });
    if (/loginTFA\(/.test(query)) {
      // Each continuation token works once, right code or wrong.
      const username = server.continuations.get(v.continuationToken);
      server.continuations.delete(v.continuationToken);
      if (!username) return json({ data: { authentication: { loginTFA: { responseResult: fail(1006, 'AuthTFAInvalid', 'Invalid TFA Security Code or Login Token.'), jwt: null } } } });
      const user = server.users[username];
      if (v.securityCode !== user.tfa) return json({ data: { authentication: { loginTFA: { responseResult: fail(1005, 'AuthTFAFailed', 'Incorrect TFA Security Code.'), jwt: null } } } });
      return json({ data: { authentication: { loginTFA: { responseResult: ok('Login success'), jwt: server.issue(user.name) } } } });
    }
    if (/login\(/.test(query)) {
      server.logins += 1;
      if (server.loginResult) return json({ data: { authentication: { login: server.loginResult } } });
      const user = server.users[v.username];
      if (!user || user.password !== v.password || !server.strategies.some((s) => s.key === v.strategy)) {
        return json({ data: { authentication: { login: { responseResult: fail(1002, 'AuthLoginFailed', 'Invalid email / username or password.'), jwt: null } } } });
      }
      if (user.tfa) {
        const continuationToken = `continue-${server.logins}`;
        server.continuations.set(continuationToken, v.username);
        return json({ data: { authentication: { login: { responseResult: ok('Login success'), jwt: null, mustProvideTFA: true, continuationToken } } } });
      }
      return json({ data: { authentication: { login: { responseResult: ok('Login success'), jwt: server.issue(user.name) } } } });
    }
    if (/profile/.test(query)) {
      if (!who) return gqlError('You must be authenticated to access this resource.', 1019);
      // An API key is answered with the first administrator's profile.
      return json({ data: { users: { profile: who.api ? { id: 1, name: 'Administrator', email: 'admin@example.com' } : { id: 7, name: 'Casey Jones', email: 'casey@example.com' } } } });
    }
    if (!who) return gqlError('Forbidden');
    if (/singleByPath/.test(query)) {
      if (!manager) return gqlError('You are not authorized to view this page.', 6013);
      const page = [...server.pages.values()].find((p) => p.path === v.path && p.locale === v.locale);
      if (!page) return gqlError('This page does not exist.', 6003);
      return json({ data: { pages: { singleByPath: { ...page, tags: page.tags.map((tag) => ({ tag })) } } } });
    }
    if (/list\(locale/.test(query)) {
      return json({ data: { pages: { list: [...server.pages.values()].filter((p) => p.locale === v.locale).map(({ content, scriptCss, scriptJs, editor, authorName, ...p }) => p) } } });
    }
    if (/folders\(/.test(query)) return json({ data: { assets: { folders: server.folders.filter((f) => f.parentId === v.id).map(({ id, slug }) => ({ id, slug })) } } });
    if (/createFolder/.test(query)) {
      if (server.folders.some((f) => f.parentId === v.id && f.slug === v.slug)) return json({ data: { assets: { createFolder: { responseResult: fail(2002, 'AssetFolderExists', 'exists') } } } });
      server.folders.push({ id: server.nextId++, parentId: v.id, slug: v.slug });
      return json({ data: { assets: { createFolder: { responseResult: ok() } } } });
    }
    if (/convert\(/.test(query)) {
      [...server.pages.values()].find((p) => p.id === v.id).editor = 'markdown';
      return json({ data: { pages: { convert: { responseResult: ok() } } } });
    }
    if (/create\(/.test(query)) {
      if ([...server.pages.values()].some((p) => p.path === v.path && p.locale === v.locale)) {
        return json({ data: { pages: { create: { responseResult: fail(6002, 'PageDuplicateCreate', 'exists'), page: null } } } });
      }
      assert.deepEqual([v.editor, v.isPublished, v.isPrivate], ['markdown', true, false]);
      const page = { id: server.nextId++, path: v.path, locale: v.locale, title: v.title, description: v.description, content: v.content, editor: v.editor,
        tags: v.tags, scriptCss: '', scriptJs: '', authorName: 'Administrator', updatedAt: now() };
      server.pages.set(page.id, page);
      return json({ data: { pages: { create: { responseResult: ok(), page: { id: page.id, updatedAt: page.updatedAt } } } } });
    }
    if (/update\(/.test(query)) {
      const page = server.pages.get(v.id);
      assert.ok(Array.isArray(v.tags), 'Wiki.js needs the tags on every update');
      Object.assign(page, { title: v.title, content: v.content, tags: v.tags, scriptCss: v.scriptCss, authorName: 'Administrator', updatedAt: now(), updates: (page.updates || 0) + 1 });
      return json({ data: { pages: { update: { responseResult: ok(), page: { id: page.id, updatedAt: page.updatedAt } } } } });
    }
    throw new Error(`unexpected ${query}`);
  };
  return server;
}

function setup(t, server, options = {}) {
  const directory = makeTmpDir('wikijs');
  t.after(() => rmrf(directory));
  const wikijs = new WikiJs({ directory, safeStorage: safeStorage(), fetchImpl: server.fetch, ...options });
  return { wikijs, directory };
}

const page = (folder = '/guides/reset-a-password') => ({ content: `## 1. Open\n\n![Step 1](${folder}/step-001.png)\n`,
  assets: [{ name: 'step-001.png', data: Buffer.alloc(2000, 1) }, { name: 'step-002.png', data: Buffer.alloc(3000, 2) }] });

test('site addresses become the wiki’s origin; paths, slugs and languages are checked the way Wiki.js does', () => {
  assert.equal(normalizeSite('wiki.example.com/en/guides/home'), 'https://wiki.example.com');
  assert.equal(normalizeSite('http://localhost:3000'), 'http://localhost:3000');
  assert.throws(() => normalizeSite('http://wiki.example.com'), /https/);

  assert.equal(pageSlug('Reset a password (v2.1)'), 'reset-a-password-v2-1');
  assert.equal(pageSlug('***'), 'guide');
  assert.equal(normalizePagePath('/Guides//IT Help/Reset/ '), 'guides/it-help/reset');
  assert.equal(normalizePagePath('équipe/procédure'), 'équipe/procédure');
  assert.throws(() => normalizePagePath(''), /Enter where the page goes/);
  assert.throws(() => normalizePagePath('guides/v1.2'), /letters, numbers, dashes and underscores/);
  for (const reserved of ['en/reset', 'pt-br/reset', 'a/reset', 'login/x', 'graphql', '_assets/x']) {
    assert.throws(() => normalizePagePath(reserved), /keeps “.+” for itself/, reserved);
  }
  assert.equal(normalizeLocale(' PT-BR '), 'pt-br');
  assert.equal(normalizeLocale(''), 'en');
  assert.throws(() => normalizeLocale('english'), /language code/);
  assert.equal(folderOf('team/it/printer'), 'team/it');
  assert.equal(folderOf('printer'), '');
});

test('an API key signs in, is stored encrypted, and is sent only as a Bearer token to the site', async (t) => {
  const server = wiki();
  const { wikijs, directory } = setup(t, server);
  const probe = await wikijs.probe('wiki.example.com/en/home');
  assert.deepEqual(probe, { baseUrl: 'https://wiki.example.com', host: 'wiki.example.com', apiKeyUrl: 'https://wiki.example.com/a/api',
    strategies: [{ key: 'local', name: 'Local', usernameType: 'email' }] });
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: 'not-a-key' }), /isn’t a Wiki\.js API key/);
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: jwt({ api: 9 }) }), /didn’t accept the API key/);
  const status = await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: ` ${server.apiKey} ` });
  // Wiki.js answers "who am I" for a key with an administrator's name, so none is shown.
  assert.deepEqual([status.connected, status.method, status.host, status.user], [true, 'apikey', 'wiki.example.com', '']);
  const saved = fs.readFileSync(path.join(directory, 'wikijs.credentials'));
  assert.equal(saved.includes(server.apiKey.split('.')[1]), false, 'not stored in the clear');
  const reopened = new WikiJs({ directory, safeStorage: wikijs.safeStorage, fetchImpl: server.fetch });
  assert.equal(reopened.status().connected, true);
});

test('API access turned off, or a revoked key, is explained', async (t) => {
  const server = wiki({ apiEnabled: false });
  const { wikijs } = setup(t, server);
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey }), /API access is turned off on this wiki.*Administration → API Access/);
  const revoked = async () => json({ data: {}, errors: [{ message: 'API Key is invalid or was revoked.', path: [] }] }, 500);
  const other = new WikiJs({ directory: makeTmpDir('wikijs'), safeStorage: safeStorage(), fetchImpl: revoked });
  t.after(() => rmrf(other.file.replace(/\/[^/]+$/, '')));
  await assert.rejects(other.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey }), /expired or been revoked/);
});

test('a username and password sign in through authentication.login; the token is reused, then renewed', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'wrong' }),
    /didn’t accept that username and password/);
  const status = await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2' });
  assert.deepEqual([status.connected, status.method, status.user, status.strategy], [true, 'password', 'Casey Jones', 'Local']);
  const logins = server.logins;
  await wikijs.publish({ guideId: 'g1', path: 'guides/reset-a-password', title: 'Reset a password', page: page() });
  assert.equal(server.logins, logins, 'a fresh token is reused (Wiki.js allows five sign-ins a minute)');

  // About to run out: sign in again first.
  wikijs.session.expires = Date.now() + 60 * 1000;
  await wikijs.publish({ guideId: 'g1', path: 'guides/reset-a-password', title: 'Reset a password', page: page() });
  assert.equal(server.logins, logins + 1);

  // Turned down halfway (expired on the server): sign in again once and retry.
  server.tokens.clear();
  const found = await wikijs.findPage('guides/reset-a-password', 'en');
  assert.equal(found.path, 'guides/reset-a-password');
  assert.equal(server.logins, logins + 2);
  server.tokens.clear();
  await wikijs.uploadAsset(1, 'step-009.png', TINY_PNG);
  assert.equal(server.logins, logins + 3, 'an upload turned away is retried with a new token');

  // The password itself is what's stored, never the short-lived token.
  const reopened = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: wikijs.safeStorage, fetchImpl: server.fetch });
  assert.equal(reopened.session, null);
  assert.equal(reopened.credentials.password, 'hunter2');
});

test('“Sign in with” lists only the wiki’s form sign-ins; SSO-only wikis point to API keys', async (t) => {
  const strategies = [
    { key: 'local', displayName: 'Local', order: 1, isEnabled: true, strategy: { key: 'local', useForm: true, usernameType: 'email' } },
    { key: 'abc-123', displayName: 'Company LDAP', order: 0, isEnabled: true, strategy: { key: 'ldap', useForm: true, usernameType: 'username' } },
    { key: 'oidc-1', displayName: 'Okta', order: 2, isEnabled: true, strategy: { key: 'oidc', useForm: false } },
  ];
  const server = wiki({ strategies });
  server.users.casey = { password: 'pw', name: 'Casey' };
  const { wikijs } = setup(t, server);
  assert.deepEqual((await wikijs.probe('wiki.example.com')).strategies, [
    { key: 'abc-123', name: 'Company LDAP', usernameType: 'username' }, { key: 'local', name: 'Local', usernameType: 'email' }]);
  const status = await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey', password: 'pw', strategy: 'abc-123' });
  assert.equal(status.strategy, 'Company LDAP');
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey', password: 'pw', strategy: 'oidc-1' }), /Choose how to sign in/);

  server.strategies = [strategies[2]];
  assert.deepEqual((await wikijs.probe('wiki.example.com')).strategies, []);
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey', password: 'pw' }), /only offers single sign-on.*API key/);

  server.strategies = [strategies[0]];
  server.loginResult = { responseResult: ok(), jwt: null, mustSetupTFA: true };
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'x' }), /set up two-step verification first.*browser/);
  server.loginResult = { responseResult: ok(), jwt: null, mustChangePwd: true };
  await assert.rejects(wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'x' }), /new password/);
  server.loginResult = null;
  const tooMany = async () => gqlError('Too many requests, please try again in 48 seconds.');
  const limited = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: safeStorage(), fetchImpl: async (url, init) => (/login/.test(init.body) ? tooMany() : server.fetch(url, init)) });
  await assert.rejects(limited.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2' }), /too many sign-in attempts/);
});

test('a two-step account connects with a code from the authenticator app, and keeps its session through a restart', async (t) => {
  const server = wiki();
  server.users['casey@example.com'].tfa = '123456';
  const { wikijs } = setup(t, server);
  const signIn = (code) => wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2', code });
  assert.deepEqual(await signIn(), { needsCode: true }, 'asks for a code');
  assert.equal(fs.existsSync(wikijs.file), false, 'nothing saved yet');
  await assert.rejects(signIn('12345'), /6-digit code/);
  await assert.rejects(signIn('654321'), /didn’t accept that code/);
  const status = await signIn(' 123 456 ');
  assert.deepEqual([status.connected, status.user, status.twoStep, status.needsCode], [true, 'Casey Jones', true, false]);

  // A restart keeps the session, so publishing doesn't need a sign-in (or a code).
  const reopened = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: wikijs.safeStorage, fetchImpl: server.fetch });
  assert.equal(reopened.session.token, wikijs.session.token);
  const logins = server.logins;
  const published = await reopened.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.equal(published.updated, false);
  assert.equal(server.logins, logins);
});

test('a two-step session that ran out is renewed by Wiki.js, and the new token is kept', async (t) => {
  const server = wiki();
  server.users['casey@example.com'].tfa = '123456';
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2', code: '123456' });
  // Ran out two days ago, inside the renewal period: used anyway, never signed in again.
  wikijs.session = { token: server.issue('Casey Jones', -2 * 24 * 60 * 60 * 1000), expires: Date.now() - 2 * 24 * 60 * 60 * 1000 };
  const logins = server.logins;
  const published = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.equal(published.updated, false);
  assert.equal(server.logins, logins);
  assert.ok(wikijs.session.expires > Date.now(), 'the renewed token replaces it');
  const reopened = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: wikijs.safeStorage, fetchImpl: server.fetch });
  assert.equal(reopened.session.token, wikijs.session.token, 'and is stored');
});

test('when Wiki.js ends a two-step session, publishing asks for a code first, then carries on', async (t) => {
  const server = wiki();
  server.users['casey@example.com'].tfa = '123456';
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2', code: '123456' });
  const first = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  server.tokens.clear(); // signed out on the wiki, or past the renewal period
  const uploads = server.requests.filter((r) => r === 'upload').length;
  const logins = server.logins;
  const issued = server.issued;
  assert.deepEqual(await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') }), { needsCode: true });
  assert.equal(server.logins, logins + 1, 'one password sign-in, to see whether Wiki.js still wants a code');
  assert.equal(server.issued, issued, 'no session without the code');
  assert.equal(server.requests.filter((r) => r === 'upload').length, uploads, 'nothing uploaded');
  assert.deepEqual(await wikijs.needsCodeNow(), true, 'still asked before the next publish');
  assert.equal(wikijs.status().needsCode, true);
  assert.equal(new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: wikijs.safeStorage, fetchImpl: server.fetch }).status().needsCode, true, 'remembered');

  await assert.rejects(wikijs.signInAgain({ code: '000000' }), /didn’t accept that code/);
  const status = await wikijs.signInAgain({ code: '123456' });
  assert.deepEqual([status.connected, status.needsCode], [true, false]);
  const again = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.deepEqual([again.id, again.updated], [first.id, true]);
});

test('if two-step verification is turned off on the wiki, the next sign-in carries on without a code', async (t) => {
  const server = wiki();
  server.users['casey@example.com'].tfa = '123456';
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2', code: '123456' });
  delete server.users['casey@example.com'].tfa;
  server.tokens.clear();
  assert.equal(wikijs.status().twoStep, true);
  // Before publishing: StepForge signs in, Wiki.js asks for no code, and nobody is asked for one.
  const published = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.equal(published.updated, false);
  assert.deepEqual([wikijs.status().twoStep, wikijs.status().needsCode], [false, false]);
  const reopened = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: wikijs.safeStorage, fetchImpl: server.fetch });
  assert.deepEqual([reopened.status().twoStep, reopened.session], [false, null], 'an ordinary password sign-in again: no stored session');

  // Already asked for a code when it was turned off: Sign in again keeps the sign-in it gets.
  server.users['casey@example.com'].tfa = '123456';
  await wikijs.signInAgain({ code: '123456' });
  server.tokens.clear();
  assert.deepEqual(await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') }), { needsCode: true });
  delete server.users['casey@example.com'].tfa;
  const status = await wikijs.signInAgain({ code: '123456' });
  assert.deepEqual([status.connected, status.twoStep, status.needsCode], [true, false, false]);
  assert.equal((await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') })).updated, true);
});

test('a two-step account that isn’t allowed to do something is told so, not asked for a code', async (t) => {
  const server = wiki();
  server.users['casey@example.com'].tfa = '123456';
  server.uploadsForbidden = true;
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2', code: '123456' });
  await assert.rejects(wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') }), /permission to upload files/);
  assert.equal(wikijs.status().needsCode, false, 'the session is still good');
});

test('an account that turns on two-step verification later is asked for a code, then stays signed in', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2' });
  assert.equal(wikijs.status().twoStep, false);
  server.users['casey@example.com'].tfa = '123456';
  server.tokens.clear();
  assert.deepEqual(await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') }), { needsCode: true });
  const status = await wikijs.signInAgain({ code: '123456' });
  assert.deepEqual([status.twoStep, status.needsCode], [true, false]);
  assert.equal((await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') })).updated, false);
});

test('requests stay on the site, never follow redirects, and network problems are explained', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey });
  await assert.rejects(wikijs.request('https://wiki.example.com', 'https://evil.example.net/graphql'), /only talks to your Wiki\.js site/);
  await assert.rejects(wikijs.request('https://wiki.example.com', '//evil.example.net/x'), /only talks to your Wiki\.js site/);

  const redirecting = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: safeStorage(),
    fetchImpl: async (url, init) => { assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://sso.example.net/' } }); } });
  await assert.rejects(redirecting.probe('wiki.example.com'), /sent StepForge to another address.*doesn’t follow redirects/);
  const notWiki = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: safeStorage(), fetchImpl: async () => new Response('<html>Hello</html>', { status: 200 }) });
  await assert.rejects(notWiki.probe('example.com'), /doesn’t look like a Wiki\.js 2 site/);
  const proxyDown = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: safeStorage(), fetchImpl: async () => new Response('<html>Bad gateway</html>', { status: 502 }) });
  await assert.rejects(proxyDown.probe('wiki.example.com'), /Wiki\.js request failed \(502\)/);

  const cert = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
  assert.match(friendlyNetworkError(cert, 'wiki.example.com'), /doesn’t trust wiki\.example\.com’s security certificate/);
  assert.match(friendlyNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'wiki.example.com'), /security certificate/);
  assert.match(friendlyNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'), 'wiki.example.com'), /Couldn’t reach wiki\.example\.com/);
  const offline = new WikiJs({ directory: path.dirname(wikijs.file), safeStorage: safeStorage(), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.probe('wiki.example.com'), /Couldn’t reach wiki\.example\.com/);
});

test('an upload is one multipart request: the folder id, then the file', () => {
  const { body, contentType } = uploadBody(42, 'step"001\r\n.png', Buffer.from('PNGDATA'));
  const boundary = /^multipart\/form-data; boundary=(stepforge[0-9a-f]{24})$/.exec(contentType)[1];
  const text = body.toString('latin1');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="mediaUpload"\r\n\r\n{"folderId":42}\r\n--${boundary}\r\n`));
  assert.match(text, /name="mediaUpload"; filename="step_001__\.png"\r\nContent-Type: image\/png\r\n\r\nPNGDATA\r\n/);
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
});

test('publishing uploads screenshots to a folder matching the path, creates the page, and republishing updates it in place', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey });
  const defaults = wikijs.defaultsFor('guide-1', 'Reset a password');
  assert.deepEqual([defaults.path, defaults.title, defaults.locale, defaults.published], ['guides/reset-a-password', 'Reset a password', 'en', null]);

  const progress = [];
  const first = await wikijs.publish({ guideId: 'guide-1', path: defaults.path, title: 'Reset a password', description: 'How to', page: page(), onProgress: (p) => progress.push(p.stage) });
  assert.deepEqual([first.url, first.updated, first.path, first.locale], ['https://wiki.example.com/en/guides/reset-a-password', false, 'guides/reset-a-password', 'en']);
  assert.deepEqual([...new Set(progress)], ['upload', 'page'], 'screenshots go up before the page that shows them');
  assert.deepEqual(server.folders.map((f) => [f.slug, f.parentId]), [['guides', 0], ['reset-a-password', 1]]);
  assert.deepEqual([...server.assets.keys()], ['2/step-001.png', '2/step-002.png']);
  const created = server.pages.get(first.id);
  assert.equal(created.content, page().content);
  assert.equal(created.description, 'How to');

  // Someone tags the page and adds a stylesheet on the wiki; a later update keeps them.
  Object.assign(created, { tags: ['howto'], scriptCss: '.x{}' });
  wikijs.rememberPage('guide-1', { ...wikijs.publishedFor('guide-1'), updatedAt: created.updatedAt });
  const second = await wikijs.publish({ guideId: 'guide-1', path: 'guides/reset-a-password', title: 'Reset a password', page: page() });
  assert.deepEqual([second.id, second.updated], [first.id, true]);
  assert.equal(server.pages.size, 1);
  assert.deepEqual([created.updates, created.tags, created.scriptCss], [1, ['howto'], '.x{}']);
  assert.equal(server.folders.length, 2, 'the folders are reused');
  assert.ok([...server.assets.values()].every((a) => a.updates === 1), 'screenshots are replaced, not duplicated');

  // The guide remembers its page; new guides start in the last folder used.
  assert.equal(wikijs.defaultsFor('guide-1', 'Renamed').path, 'guides/reset-a-password');
  await wikijs.publish({ guideId: 'guide-2', path: 'team/it/printer', title: 'Printer', page: page('/team/it/printer') });
  assert.equal(wikijs.defaultsFor('guide-3', 'Install VPN').path, 'team/it/install-vpn');
  await wikijs.publish({ guideId: 'guide-4', path: 'top-level', title: 'Top', page: { content: 'Hi', assets: [] } });
  assert.equal(wikijs.defaultsFor('guide-5', 'Next one').path, 'next-one');
});

test('a page edited on the wiki since the last publish is only replaced when the user says so', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey });
  const first = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.equal(wikijs.publishedFor('g').updatedAt, server.pages.get(first.id).updatedAt, 'remembers the page’s own time');
  server.edit('guides/vpn', 'Fixed a typo on the wiki');
  const uploads = server.assets.size;
  const asked = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.deepEqual(asked, { edited: { path: 'guides/vpn', title: 'VPN', url: 'https://wiki.example.com/en/guides/vpn',
    by: 'Jane Doe', when: server.pages.get(first.id).updatedAt } });
  assert.equal(server.pages.get(first.id).content, 'Fixed a typo on the wiki', 'nothing changed yet');
  assert.equal(server.requests.filter((r) => r === 'upload').length, uploads, 'nothing uploaded yet');
  const replaced = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn'), replace: true });
  assert.equal(replaced.updated, true);
  assert.equal(server.pages.get(first.id).content, page('/guides/vpn').content);
  const again = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.equal(again.edited, undefined, 'no warning once StepForge’s version is the latest');
});

test('a page another guide (or person) made at the path is a conflict until replaced', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey });
  await wikijs.publish({ guideId: 'someone-else', path: 'guides/shared', title: 'Shared', page: page('/guides/shared') });
  const asked = await wikijs.publish({ guideId: 'mine', path: 'guides/shared', title: 'Mine', page: page('/guides/shared') });
  assert.deepEqual(asked, { conflict: { path: 'guides/shared', title: 'Shared' } });
  const replaced = await wikijs.publish({ guideId: 'mine', path: 'guides/shared', title: 'Mine', page: page('/guides/shared'), replace: true });
  assert.equal(replaced.updated, true);
  assert.equal(server.pages.size, 1);
  assert.equal(wikijs.publishedFor('mine').id, replaced.id);
});

test('writers without “manage pages” find their page through the page list', async (t) => {
  const server = wiki({ manager: false });
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey });
  const first = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  const second = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.deepEqual([second.id, second.updated], [first.id, true]);
  assert.ok(server.requests.some((r) => /list\(locale/.test(r)));
  // The page list doesn't say who edited a page, so the warning has no name.
  server.edit('guides/vpn', 'Edited on the wiki');
  const asked = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  assert.deepEqual([asked.edited.by, asked.edited.when], ['', server.pages.get(first.id).updatedAt]);
});

test('a page switched to another editor on the wiki is switched back to Markdown before it’s updated', async (t) => {
  const server = wiki();
  const { wikijs } = setup(t, server);
  await wikijs.connect({ address: 'wiki.example.com', method: 'apikey', apiKey: server.apiKey });
  const first = await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn') });
  server.pages.get(first.id).editor = 'ckeditor';
  await wikijs.publish({ guideId: 'g', path: 'guides/vpn', title: 'VPN', page: page('/guides/vpn'), replace: true });
  assert.equal(server.pages.get(first.id).editor, 'markdown');
});

test('signing out removes the stored sign-in and its keyring copy; a lost file comes back from the keyring', async (t) => {
  const server = wiki();
  const kept = new Map();
  const vault = { read: async (key) => kept.get(key) || null, write: async (key, secret) => { kept.set(key, secret); }, clear: async (key) => { kept.delete(key); } };
  const { wikijs, directory } = setup(t, server, { vault });
  await wikijs.connect({ address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(kept.get('wikijs')).password, 'hunter2');

  // An update that can't read the encrypted file any more.
  const fresh = new WikiJs({ directory, safeStorage: safeStorage(), fetchImpl: server.fetch, vault });
  assert.match(fresh.status().error, /couldn’t be unlocked/);
  fs.rmSync(path.join(directory, 'wikijs.credentials'));
  const restarted = new WikiJs({ directory, safeStorage: safeStorage(), fetchImpl: server.fetch, vault });
  assert.equal(await restarted.recover(), true);
  assert.equal(restarted.status().user, 'Casey Jones');

  const after = restarted.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(after.connected, false);
  assert.equal(fs.existsSync(path.join(directory, 'wikijs.credentials')), false);
  assert.equal(kept.has('wikijs'), false);
  assert.equal(restarted.session, null);
  await assert.rejects(restarted.publish({ guideId: 'g', path: 'guides/x', title: 'X', page: page() }), /Connect Wiki\.js in Settings → Accounts → Wiki\.js/);
});

test('the exported page names screenshots by step number and points its images at the asset folder', (t) => {
  const { GuideStore } = require('../../core/store');
  const { buildRenderAst } = require('../../core/renderast');
  const { runExport } = require('../../exporters');
  const root = makeTmpDir('wikijs-export');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'library'));
  const guide = store.createGuide({ title: 'Send the report' });
  store.addStep(guide.guideId, { title: 'Open settings' }, TINY_PNG, { width: 1, height: 1 });
  store.addStep(guide.guideId, { title: 'Email casey.jones@contoso.com' }, TINY_PNG, { width: 1, height: 1 });
  const result = runExport('wikijs', buildRenderAst(store, guide.guideId, {}), path.join(root, 'out'),
    { includeImages: true, toc: false, frontMatter: false, assetFolder: '/guides/send-the-report' });
  const exported = pageFromExport(result.file, '/guides/send-the-report');
  assert.deepEqual(exported.assets.map((a) => a.name), ['step-001.png', 'step-002.png']);
  assert.ok(exported.assets.every((a) => a.data.length > 0));
  assert.match(exported.content, /\]\(\/guides\/send-the-report\/step-002\.png\)/);
  assert.doesNotMatch(exported.content, /\/\d{3}-[^/)]*\.png\)/, 'every image points at a renamed asset');
  assert.doesNotMatch(exported.assets.map((a) => a.name).join(' '), /contoso/);
  assert.doesNotMatch(exported.content, /^# Send the report/m, 'Wiki.js shows the title itself');
});

test('IPC arguments are checked before anything runs', () => {
  assert.equal(validConnectArgs({ address: 'wiki.example.com', method: 'apikey', apiKey: 'k' }), true);
  assert.equal(validConnectArgs({ address: 'wiki.example.com', method: 'password', username: 'u', password: 'p', strategy: 'local' }), true);
  assert.equal(validConnectArgs({ address: 'wiki.example.com', method: 'cookie' }), false);
  assert.equal(validConnectArgs({ address: 'wiki.example.com', method: 'apikey', apiKey: 'k'.repeat(5000) }), false);
  assert.equal(validConnectArgs({ address: 7, method: 'apikey' }), false);
  assert.equal(validConnectArgs({ address: 'w', method: 'apikey', redirect: 'https://evil' }), false, 'no unknown fields');
  assert.equal(validConnectArgs({ address: 'w', method: 'password', username: 'u', password: 'p', code: '123456' }), true);
  assert.equal(validConnectArgs({ address: 'w', method: 'password', username: 'u', password: 'p', code: 123456 }), false);
  assert.equal(validCodeArgs({ code: '123456' }), true);
  assert.equal(validCodeArgs({ code: '1'.repeat(21) }), false);
  assert.equal(validCodeArgs({ code: '123456', password: 'p' }), false);

  assert.equal(validPublishArgs({ guideId: 'g-1', path: 'guides/x', title: 'X' }), true);
  assert.equal(validPublishArgs({ guideId: 'g-1', path: 'guides/x', title: 'X', locale: 'de', replace: true }), true);
  assert.equal(validPublishArgs({ guideId: '../g', path: 'guides/x', title: 'X' }), false);
  assert.equal(validPublishArgs({ guideId: 'g', path: 'guides/x', title: '  ' }), false);
  assert.equal(validPublishArgs({ guideId: 'g', path: 'guides/x', title: 'X', replace: 'yes' }), false);
  assert.equal(validPublishArgs({ guideId: 'g', path: 'x'.repeat(501), title: 'X' }), false);
  assert.equal(validPublishArgs({ guideId: 'g', path: ['guides'], title: 'X' }), false);

  // main.js uses these for its Wiki.js channels.
  const main = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
  assert.match(main, /h\('wikijs:connect'[\s\S]{0,300}validate: validWikiConnectArgs/);
  assert.match(main, /h\('wikijs:publish'[\s\S]*?\}, \{ validate: validWikiPublishArgs \}\);/);
  assert.match(main, /h\('wikijs:publish'[\s\S]*?redactor\.checkGuide[\s\S]*?runExportInWorker\([\s\S]*?format: 'wikijs'[\s\S]*?wikijs\.publish\(/, 'the privacy check runs before the export and publish');
  // Placeholders are filled in the page's title and description, as in its content (#176).
  assert.match(main, /h\('wikijs:defaults'[\s\S]{0,400}buildRenderAst\([\s\S]{0,200}wikijs\.defaultsFor\(guideId, guide\.title\)/);
  assert.match(main, /h\('wikijs:publish'[\s\S]*?wikijs\.publish\(\{[^}]*description: result\.description/);
});
