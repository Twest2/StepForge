'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { OneDrive, SCOPE } = require('../../app/onedrive');
const { Dropbox, REDIRECT_PORTS } = require('../../app/dropbox');
const { WebDAV, parseMultistatus, normalizeServer, isLocalHost } = require('../../app/webdav');
const { resolveCloudApps } = require('../../app/cloud-apps');
const { configureCloudApps } = require('../../scripts/configure-cloud-apps');
const { makeTmpDir, rmrf } = require('./helpers');

const ONEDRIVE_ID = '11111111-2222-3333-4444-555555555555';
const DROPBOX_KEY = 'abcdefghij12345';

function safeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString(); },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status });

function setup(t, Kind, options) {
  const directory = makeTmpDir('cloud-account');
  t.after(() => rmrf(directory));
  const storage = safeStorage();
  const account = new Kind({ directory, safeStorage: storage, openExternal: async () => {}, ...options });
  t.after(() => account.cancel());
  return { account, directory, storage };
}

/** Follow a browser sign-in: return to the app's loopback address with the code. */
async function approve(url, seen = () => {}) {
  const authorization = new URL(url);
  seen(authorization);
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  redirect.searchParams.set('state', 'wrong');
  redirect.searchParams.set('code', 'the-code');
  assert.equal((await fetch(redirect)).status, 400, 'a callback without the right state is refused');
  redirect.searchParams.set('state', authorization.searchParams.get('state'));
  assert.equal((await fetch(redirect)).status, 200);
  return authorization;
}

// ---- OneDrive -------------------------------------------------------------

test('OneDrive signs in with PKCE on a loopback address and keeps only encrypted credentials', async (t) => {
  let authorization;
  const { account, directory, storage } = setup(t, OneDrive, {
    clientId: ONEDRIVE_ID,
    openExternal: (url) => approve(url, (found) => { authorization = found; }),
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/oauth2/v2.0/token')) {
        const params = new URLSearchParams(options.body);
        assert.equal(params.get('client_id'), ONEDRIVE_ID);
        assert.equal(params.get('client_secret'), null, 'a public client has no secret');
        assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        assert.equal(params.get('code'), 'the-code');
        return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      }
      assert.equal(options.headers.Authorization, 'Bearer access');
      if (url.startsWith('https://graph.microsoft.com/v1.0/me/drive?')) return json({ id: 'drive-123' });
      if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) return json({ displayName: 'Casey', userPrincipalName: 'casey@outlook.com' });
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(account.available, true);
  const status = await account.connect();
  assert.equal(authorization.origin, 'https://login.microsoftonline.com');
  assert.equal(authorization.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(authorization.searchParams.get('scope'), SCOPE);
  assert.match(SCOPE, /Files\.ReadWrite\.AppFolder/);
  assert.doesNotMatch(SCOPE, /Files\.ReadWrite(\.All)?( |$)/, 'only the app folder, never the whole OneDrive');
  assert.equal(new URL(authorization.searchParams.get('redirect_uri')).hostname, 'localhost');
  assert.deepEqual([status.connected, status.email], [true, 'casey@outlook.com']);
  assert.equal(await account.account(), 'drive-123');
  const saved = fs.readFileSync(path.join(directory, 'onedrive.credentials'));
  assert.equal(saved.includes('refresh'), false, 'nothing is stored in plain text');
  assert.equal(JSON.parse(storage.decryptString(saved)).refresh_token, 'refresh');
});

test('OneDrive is unavailable without an app registration', (t) => {
  const { account } = setup(t, OneDrive, { clientId: '' });
  assert.equal(account.available, false);
  return assert.rejects(account.connect(), /unavailable in this build/);
});

function signedIn(account, extra = {}) {
  account.credentials = { key: account.key, access_token: 'access', refresh_token: 'refresh', expiresAt: Date.now() + 3600000, accountId: 'acct', ...extra };
}

test('OneDrive stores files in its app folder, follows download links and refreshes an expired token', async (t) => {
  const requests = [];
  const files = new Map();
  let token = 'stale';
  const { account } = setup(t, OneDrive, {
    clientId: ONEDRIVE_ID,
    fetchImpl: async (url, options = {}) => {
      requests.push([options.method || 'GET', url]);
      if (url.endsWith('/token')) {
        assert.equal(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
        token = 'fresh';
        return json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 });
      }
      if (url.startsWith('https://download.example/')) {
        assert.equal(options.headers?.Authorization, undefined, 'the download link carries its own authorization');
        return new Response(files.get(decodeURIComponent(url.slice('https://download.example/'.length))));
      }
      if (options.headers.Authorization !== `Bearer ${token}` || token === 'stale') return json({ error: { code: 'InvalidAuthenticationToken' } }, 401);
      const match = /approot:\/(.+?):(\/content|\/children)?(\?.*)?$/.exec(decodeURIComponent(url));
      assert.ok(match, url);
      const [, file, action] = match;
      if (action === '/content' && options.method === 'PUT') { files.set(file, Buffer.from(await new Response(options.body).arrayBuffer())); return json({ id: 'x' }, 201); }
      if (action === '/content') {
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: `https://download.example/${encodeURIComponent(file)}` } });
      }
      if (action === '/children') {
        const value = [...files].filter(([name]) => name.startsWith(`${file}/`))
          .map(([name, data]) => ({ name: name.slice(file.length + 1), size: data.length, lastModifiedDateTime: '2026-09-29T10:00:00Z', file: {} }));
        return value.length ? json({ value }) : json({ error: { code: 'itemNotFound' } }, 404);
      }
      if (options.method === 'DELETE') { files.delete(file); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${url}`);
    },
  });
  signedIn(account, { access_token: 'stale' });
  const version = await account.upload({ data: Buffer.alloc(9000, 1), name: 'Guide.sfgz', properties: { stepforge: 'guide-v1', guideId: 'g1', hash: 'a'.repeat(64) } });
  assert.equal(account.credentials.refresh_token, 'rotated', 'a rotated refresh token is kept');
  assert.ok(requests.every(([, url]) => url.startsWith('https://graph.microsoft.com/v1.0/me/drive/special/approot') || url.endsWith('/token')),
    'every file request stays inside the app folder');
  assert.deepEqual((await account.listVersions()).map((file) => file.name), ['Guide.sfgz']);
  assert.deepEqual(await account.download(version.id), Buffer.alloc(9000, 1));
  assert.deepEqual(await account.listParts(), [], 'a folder that does not exist yet is empty');
  await account.deleteFile(version.id);
  assert.deepEqual(await account.listVersions(), []);
});

test('OneDrive uploads large files in 320 KiB-aligned chunks to the upload session', async (t) => {
  const chunks = [];
  const { account } = setup(t, OneDrive, {
    clientId: ONEDRIVE_ID,
    fetchImpl: async (url, options = {}) => {
      if (url.includes(':/createUploadSession')) return json({ uploadUrl: 'https://upload.example/session' });
      if (url === 'https://upload.example/session') {
        assert.equal(options.headers.Authorization, undefined);
        const body = Buffer.from(await new Response(options.body).arrayBuffer());
        chunks.push([options.headers['Content-Range'], body.length]);
        return json({}, 202);
      }
      if (url.includes(':/content') && options.method === 'PUT') return json({ id: 'details' }, 201);
      throw new Error(`unexpected ${url}`);
    },
  });
  signedIn(account);
  const size = 12 * 1024 * 1024 + 5;
  const progress = [];
  await account.upload({ data: Buffer.alloc(size), name: 'Big.sfgz', properties: { stepforge: 'guide-v1', guideId: 'g1', hash: 'b'.repeat(64) }, onProgress: (n) => progress.push(n) });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0][0], `bytes 0-${10 * 1024 * 1024 - 1}/${size}`);
  assert.equal(chunks[0][1] % (320 * 1024), 0);
  assert.equal(chunks[1][0], `bytes ${10 * 1024 * 1024}-${size - 1}/${size}`);
  assert.equal(progress.at(-1), size);
});

test('a refused OneDrive refresh token asks the user to sign in again', async (t) => {
  const { account } = setup(t, OneDrive, {
    clientId: ONEDRIVE_ID,
    fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }, 400),
  });
  signedIn(account, { expiresAt: 0 });
  await assert.rejects(account.listVersions(), /OneDrive sign-in expired or was revoked/);
});

test('OneDrive sign-in keeps waiting when the browser could not be opened, and says when it is done', async (t) => {
  let link;
  const { account } = setup(t, OneDrive, {
    clientId: ONEDRIVE_ID,
    openExternal: async (url) => { link = url; throw new Error('no browser'); },
    fetchImpl: async (url) => {
      if (url.endsWith('/oauth2/v2.0/token')) return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      if (url.startsWith('https://graph.microsoft.com/v1.0/me/drive?')) return json({ id: 'drive-123' });
      return json({});
    },
  });
  const connected = account.connect();
  while (!link) await new Promise((resolve) => setTimeout(resolve, 5));
  const authorization = new URL(link);
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  redirect.searchParams.set('state', authorization.searchParams.get('state'));
  redirect.searchParams.set('code', 'the-code');
  const page = await fetch(redirect);
  assert.match(await page.text(), /Signed in to OneDrive\. You can close this tab and go back to StepForge\./);
  assert.equal((await connected).connected, true);
});

// ---- Dropbox --------------------------------------------------------------

test('Dropbox signs in with PKCE on a registered port and asks for offline access', async (t) => {
  let authorization;
  const { account } = setup(t, Dropbox, {
    appKey: DROPBOX_KEY,
    openExternal: (url) => approve(url, (found) => { authorization = found; }),
    fetchImpl: async (url, options = {}) => {
      if (url === 'https://api.dropboxapi.com/oauth2/token') {
        const params = new URLSearchParams(options.body);
        assert.equal(params.get('client_id'), DROPBOX_KEY);
        assert.equal(params.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 14400 });
      }
      if (url === 'https://api.dropboxapi.com/2/users/get_current_account') {
        return json({ account_id: 'dbid:1', email: 'casey@example.com', name: { display_name: 'Casey' } });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const status = await account.connect();
  assert.equal(authorization.origin, 'https://www.dropbox.com');
  assert.equal(authorization.searchParams.get('token_access_type'), 'offline');
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  assert.ok(REDIRECT_PORTS.includes(Number(redirect.port)), 'Dropbox needs one of the registered redirect ports');
  assert.equal(status.email, 'casey@example.com');
  assert.equal(await account.account(), 'dbid:1');
});

test('Dropbox sign-in moves to the next registered port when one is busy', async (t) => {
  const http = require('node:http');
  const blocker = http.createServer();
  const busy = await new Promise((resolve) => { blocker.once('error', () => resolve(false)); blocker.listen(REDIRECT_PORTS[0], '127.0.0.1', () => resolve(true)); });
  t.after(() => blocker.close());
  let redirect;
  const { account } = setup(t, Dropbox, {
    appKey: DROPBOX_KEY,
    openExternal: async (url) => { redirect = new URL(new URL(url).searchParams.get('redirect_uri')); account.cancel(); },
  });
  await assert.rejects(account.connect(), /cancelled/);
  if (busy) assert.equal(Number(redirect.port), REDIRECT_PORTS[1]);
});

test('Dropbox lists every page, treats not_found as missing and escapes the API header', async (t) => {
  const seen = [];
  const { account } = setup(t, Dropbox, {
    appKey: DROPBOX_KEY,
    fetchImpl: async (url, options = {}) => {
      seen.push([url, options.headers['Dropbox-API-Arg'] || options.body]);
      if (url.endsWith('/2/files/list_folder')) {
        const { path: folder } = JSON.parse(options.body);
        if (folder === '/parts') return json({ error_summary: 'path/not_found/..' }, 409);
        return json({ entries: [{ '.tag': 'file', name: 'aaa-0123456789abcdef.json', size: 10, server_modified: '2026-09-29T10:00:00Z' }, { '.tag': 'folder', name: 'x' }], has_more: true, cursor: 'c1' });
      }
      if (url.endsWith('/2/files/list_folder/continue')) {
        assert.equal(JSON.parse(options.body).cursor, 'c1');
        return json({ entries: [{ '.tag': 'file', name: 'aab-0123456789abcdef.json', size: 10, server_modified: '2026-09-29T10:00:01Z' }], has_more: false });
      }
      if (url.endsWith('/2/files/download')) {
        const { path: file } = JSON.parse(options.headers['Dropbox-API-Arg']);
        return text(JSON.stringify({ name: `Guide ${file.slice(9, 12)}`, createdTime: '2026-09-29T10:00:00Z', appProperties: { stepforge: 'guide-v1', guideId: 'g1', hash: 'c'.repeat(64) }, data: '' }));
      }
      if (url.endsWith('/2/files/upload')) return json({ id: 'id:1' });
      if (url.endsWith('/2/files/delete_v2')) return json({ error_summary: 'path_lookup/not_found/' }, 409);
      throw new Error(`unexpected ${url}`);
    },
  });
  signedIn(account);
  assert.deepEqual((await account.listVersions()).map((file) => file.name).sort(), ['Guide aaa', 'Guide aab']);
  assert.deepEqual(await account.listParts(), []);
  await account.deleteFile('aaa-0123456789abcdef');
  await account.upload({ data: Buffer.from('é'), name: 'Guide é', properties: { stepforge: 'part-v1', sha: 'd'.repeat(64) } });
  const header = seen.find(([url]) => url.endsWith('/2/files/upload'))[1];
  assert.match(header, /^[\x20-\x7e]+$/, 'the header is plain ASCII');
  assert.equal(JSON.parse(header).path, `/parts/${'d'.repeat(64)}`);
});

// ---- Nextcloud / WebDAV ------------------------------------------------------

test('WebDAV responses parse whatever namespace prefix the server uses', () => {
  const xml = `<?xml version="1.0"?>
  <D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/StepForge/objects/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>https://cloud.example.com/dav/StepForge/objects/abc-0123456789abcdef.json</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>42</D:getcontentlength><D:getlastmodified>Tue, 29 Sep 2026 10:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
  <lp1:response xmlns:lp1="DAV:"><lp1:href>/dav/a%20b&amp;c.bin</lp1:href><lp1:propstat><lp1:prop><lp1:getcontentlength>7</lp1:getcontentlength></lp1:prop></lp1:propstat></lp1:response></D:multistatus>`;
  const entries = parseMultistatus(xml);
  assert.deepEqual(entries.map(({ name, collection, size }) => [name, collection, size]),
    [['objects', true, 0], ['abc-0123456789abcdef.json', false, 42], ['a b&c.bin', false, 7]]);
  assert.equal(Date.parse(entries[1].modified), Date.UTC(2026, 8, 29, 10));
});

test('server addresses need https except on a home network', () => {
  assert.equal(normalizeServer('cloud.example.com').href, 'https://cloud.example.com/');
  assert.equal(normalizeServer('https://cloud.example.com/index.php/apps/files/?dir=/').href, 'https://cloud.example.com/');
  assert.equal(normalizeServer('https://example.com/nextcloud').href, 'https://example.com/nextcloud/');
  assert.equal(normalizeServer('http://192.168.1.20:8080').href, 'http://192.168.1.20:8080/');
  assert.equal(normalizeServer('http://nas.local').href, 'http://nas.local/');
  assert.throws(() => normalizeServer('http://cloud.example.com'), /https/);
  assert.throws(() => normalizeServer('ftp://cloud.example.com'), /https/);
  assert.throws(() => normalizeServer(''), /address/);
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.20.1.1', '100.101.102.103', 'nas', '[::1]', 'box.lan']) assert.equal(isLocalHost(host), true, host);
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]']) assert.equal(isLocalHost(host), false, host);
});

function nextcloudServer({ polls = 1 } = {}) {
  const files = new Map();
  const log = [];
  let pending = polls;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    log.push([method, url]);
    const u = new URL(url);
    if (u.pathname === '/status.php') return json({ installed: true, productname: 'Nextcloud', version: '31.0.0' });
    if (u.pathname === '/index.php/login/v2') {
      assert.equal(options.headers['User-Agent'], 'StepForge', 'Nextcloud names the app password after the app');
      return json({ poll: { token: 'poll-token', endpoint: 'https://cloud.example.com/index.php/login/v2/poll' }, login: 'https://cloud.example.com/index.php/login/v2/flow/abc' });
    }
    if (u.pathname === '/index.php/login/v2/poll') {
      assert.equal(new URLSearchParams(options.body).get('token'), 'poll-token');
      if (pending-- > 0) return text('', 404);
      return json({ server: 'https://cloud.example.com', loginName: 'casey@example.com', appPassword: 'app-password' });
    }
    if (u.pathname === '/ocs/v2.php/cloud/user') return json({ ocs: { data: { id: 'casey', displayname: 'Casey' } } });
    const auth = `Basic ${Buffer.from('casey@example.com:app-password').toString('base64')}`;
    if (options.headers?.Authorization !== auth) return text('', 401);
    const root = '/remote.php/dav/files/casey/';
    assert.ok(u.pathname.startsWith(root), u.pathname);
    const file = decodeURIComponent(u.pathname.slice(root.length));
    if (method === 'PROPFIND') {
      if (!file) return text('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:quota-used-bytes>100</d:quota-used-bytes><d:quota-available-bytes>900</d:quota-available-bytes></d:prop></d:propstat></d:response></d:multistatus>', 207);
      const folder = file.replace(/\/$/, '');
      if (!files.has(folder)) return text('', 404);
      const body = [...files].filter(([name]) => name.startsWith(`${folder}/`))
        .map(([name, data]) => `<d:response><d:href>${root}${name}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${data.length}</d:getcontentlength><d:getlastmodified>Tue, 29 Sep 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`).join('');
      return text(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${root}${folder}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${body}</d:multistatus>`, 207);
    }
    if (method === 'MKCOL') { if (files.has(file.replace(/\/$/, ''))) return text('', 405); files.set(file.replace(/\/$/, ''), 'folder'); return text('', 201); }
    if (method === 'PUT') {
      const parent = file.split('/').slice(0, -1).join('/');
      if (!files.has(parent)) return text('', 409);
      files.set(file, Buffer.from(await new Response(options.body).arrayBuffer()));
      return text('', 201);
    }
    if (method === 'GET') return files.has(file) ? new Response(files.get(file)) : text('', 404);
    if (method === 'DELETE') { const had = files.delete(file); return text('', had ? 204 : 404); }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { files, log, fetchImpl };
}

test('Nextcloud signs in through its browser login and stores guides in a StepForge folder', async (t) => {
  const server = nextcloudServer({ polls: 1 });
  const opened = [];
  const { account } = setup(t, WebDAV, { fetchImpl: server.fetchImpl, openExternal: async (url) => opened.push(url) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connecting = account.connect({ server: 'cloud.example.com' });
  for (let i = 0; i < 20 && !account.credentials; i += 1) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(2000); }
  const status = await connecting;
  t.mock.timers.reset();
  assert.deepEqual(opened, ['https://cloud.example.com/index.php/login/v2/flow/abc']);
  assert.equal(status.connected, true);
  assert.equal(status.email, 'Casey on cloud.example.com');
  assert.equal(account.label, 'Nextcloud');
  const sha = 'e'.repeat(64);
  await account.upload({ data: Buffer.from('screenshot'), name: `part-${sha}`, properties: { stepforge: 'part-v1', sha } });
  assert.deepEqual(server.files.get(`StepForge/parts/${sha}`), Buffer.from('screenshot'), 'folders are created on first use');
  assert.deepEqual((await account.listParts()).map((part) => part.appProperties.sha), [sha]);
  assert.deepEqual(await account.quota(), { limit: 1000, usage: 100 });
});

test('a WebDAV server that is not Nextcloud asks for a login, and a wrong password is explained', async (t) => {
  const files = new Map();
  const auth = `Basic ${Buffer.from('casey:secret').toString('base64')}`;
  const { account } = setup(t, WebDAV, {
    fetchImpl: async (url, options = {}) => {
      const u = new URL(url);
      if (u.pathname === '/status.php') return text('<html>not here</html>', 404);
      if (options.headers?.Authorization !== auth) return text('', 401);
      if (options.method === 'PROPFIND') return text('<multistatus xmlns="DAV:"><response><href>/dav/</href></response></multistatus>', 207);
      if (options.method === 'PUT') { files.set(u.pathname, Buffer.from(await new Response(options.body).arrayBuffer())); return text('', 201); }
      return text('', 404);
    },
  });
  const first = await account.connect({ server: 'https://dav.example.com/dav/' });
  assert.deepEqual(first, { needsPassword: true, server: 'https://dav.example.com/dav/' });
  assert.equal(account.status().connected, false);
  await assert.rejects(account.connect({ server: 'https://dav.example.com/dav/', username: 'casey', password: 'wrong' }), /didn’t accept the user name or password/);
  const status = await account.connect({ server: 'https://dav.example.com/dav/', username: 'casey', password: 'secret' });
  assert.equal(status.connected, true);
  assert.equal(account.label, 'WebDAV');
  await account.upload({ data: Buffer.from('{}'), name: 'Deleted', properties: { stepforge: 'deletion-v1', guideId: 'g1', state: 'deleted' } });
  assert.ok([...files.keys()].every((name) => name.startsWith('/dav/StepForge/objects/')));
});

// ---- release configuration ------------------------------------------------------

test('app registrations come from the release, then the environment, then a local file', (t) => {
  const root = makeTmpDir('cloud-apps');
  t.after(() => rmrf(root));
  const localFile = path.join(root, 'cloud-apps.local.json');
  fs.writeFileSync(localFile, JSON.stringify({ onedriveClientId: 'local-od', dropboxAppKey: 'localkey' }));
  assert.deepEqual(resolveCloudApps({ committed: {}, env: {}, localFile }), { onedriveClientId: 'local-od', dropboxAppKey: 'localkey' });
  assert.deepEqual(resolveCloudApps({ committed: {}, env: { STEPFORGE_DROPBOX_APP_KEY: 'envkey' }, localFile }), { onedriveClientId: 'local-od', dropboxAppKey: 'envkey' });
  assert.deepEqual(resolveCloudApps({ committed: { onedriveClientId: ONEDRIVE_ID, dropboxAppKey: DROPBOX_KEY }, env: { STEPFORGE_DROPBOX_APP_KEY: 'envkey' }, localFile }),
    { onedriveClientId: ONEDRIVE_ID, dropboxAppKey: DROPBOX_KEY });
});

test('release builds embed both registrations and refuse to ship without them', (t) => {
  const root = makeTmpDir('cloud-apps');
  t.after(() => rmrf(root));
  const file = path.join(root, 'cloud-apps-config.json');
  fs.writeFileSync(file, JSON.stringify({ onedriveClientId: '', dropboxAppKey: '' }));
  assert.throws(() => configureCloudApps({ file, onedriveClientId: '', dropboxAppKey: DROPBOX_KEY }), /OneDrive/);
  assert.throws(() => configureCloudApps({ file, onedriveClientId: ONEDRIVE_ID, dropboxAppKey: 'Not A Key!' }), /Dropbox/);
  configureCloudApps({ file, onedriveClientId: ONEDRIVE_ID, dropboxAppKey: DROPBOX_KEY });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { onedriveClientId: ONEDRIVE_ID, dropboxAppKey: DROPBOX_KEY });
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../app/cloud-apps-config.json'), 'utf8'));
  assert.deepEqual(committed, { onedriveClientId: '', dropboxAppKey: '' }, 'the source tree never commits a registration');
});

test('WebDAV creates missing folders even when the server answers in plain text', async (t) => {
  const folders = new Set();
  const files = new Map();
  const { account } = setup(t, WebDAV, {
    fetchImpl: async (url, options = {}) => {
      const { pathname } = new URL(url);
      if (options.method === 'MKCOL') { folders.add(pathname.replace(/\/$/, '')); return text('Created', 201); }
      if (options.method === 'PUT') {
        if (!folders.has(pathname.split('/').slice(0, -1).join('/'))) return text('Conflict', 409);
        files.set(pathname, Buffer.from(await new Response(options.body).arrayBuffer()));
        return text('Created', 201);
      }
      return text('', 404);
    },
  });
  account.credentials = { key: 'webdav', davUrl: 'https://dav.example.com/dav/', username: 'casey', password: 'secret', kind: 'webdav', accountId: 'x' };
  const sha = '1'.repeat(64);
  await account.upload({ data: Buffer.from('x'), name: 'part', properties: { stepforge: 'part-v1', sha } });
  assert.deepEqual([...folders], ['/dav/StepForge', '/dav/StepForge/parts']);
  assert.ok(files.has(`/dav/StepForge/parts/${sha}`));
});
