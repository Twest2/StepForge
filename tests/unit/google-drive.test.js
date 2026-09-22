'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { GoogleDrive, SCOPE } = require('../../app/google-drive');
const { makeTmpDir, rmrf } = require('./helpers');

function setup(t, options = {}) {
  const directory = makeTmpDir('google-drive');
  t.after(() => rmrf(directory));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString(); },
  };
  const drive = new GoogleDrive({
    directory,
    safeStorage,
    clientId: 'test.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    openExternal: async () => {},
    ...options
  });
  t.after(() => drive.cancel());
  return { drive, directory, safeStorage };
}
function authorize(drive) {
  drive.credentials = { clientId: 'test.apps.googleusercontent.com', refresh_token: 'refresh-secret', access_token: 'access-secret', expiresAt: Date.now() + 3600000 };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('OAuth uses loopback, state and PKCE and persists only encrypted credentials', async (t) => {
  let authorization;
  const { drive, directory, safeStorage } = setup(t, {
    openExternal: async (url) => {
      authorization = new URL(url);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      const redirect = new URL(authorization.searchParams.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1');
      redirect.searchParams.set('state', 'incorrect'); redirect.searchParams.set('code', 'code');
      assert.equal((await fetch(redirect)).status, 400);
      redirect.searchParams.set('state', authorization.searchParams.get('state'));
      assert.equal((await fetch(redirect)).status, 200);
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('client_id'), 'test.apps.googleusercontent.com');
      assert.equal(params.get('client_secret'), 'test-client-secret');
      assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      assert.equal(params.get('code'), 'code');
      return json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, scope: SCOPE });
    },
  });
  await drive.connect();
  assert.equal(drive.status().connected, true);
  const raw = fs.readFileSync(drive.file).toString();
  assert.ok(!raw.includes('refresh-secret')); assert.ok(!raw.includes('client-secret'));
  assert.equal(drive.status().refresh_token, undefined);
  const restarted = new GoogleDrive({
    directory,
    safeStorage,
    clientId: 'test.apps.googleusercontent.com',
    clientSecret: 'test-client-secret'
  });
  assert.equal(restarted.status().connected, true);
  assert.equal(restarted.credentials.refresh_token, 'refresh-secret');
});

test('OAuth cancellation closes the listener and does not persist credentials', async (t) => {
  let opened;
  const { drive } = setup(t, { openExternal: async (url) => { opened = new URL(url); queueMicrotask(() => drive.cancel()); } });
  await assert.rejects(drive.connect(), /cancelled/);
  assert.equal(drive.status().connected, false);
  assert.equal(fs.existsSync(drive.file), false);
  await assert.rejects(fetch(opened.searchParams.get('redirect_uri')));
});

test('OAuth rejects denied consent', async (t) => {
  const { drive } = setup(t, { openExternal: async (url) => {
    const auth = new URL(url); const redirect = new URL(auth.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', auth.searchParams.get('state')); redirect.searchParams.set('error', 'access_denied');
    await fetch(redirect);
  } });
  await assert.rejects(drive.connect(), /denied/);
  assert.equal(drive.status().connected, false);
});

test('sign-in refuses plaintext storage backends', async (t) => {
  const { drive } = setup(t, { safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(drive.connect(), /credential store/);
});

test('access token refresh is shared, persisted, and does not expose the refresh token', async (t) => {
  let requests = 0;
  const { drive } = setup(t, { fetchImpl: async (url, options) => {
    requests++;
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'refresh-secret');
    assert.equal(
      new URLSearchParams(options.body).get('client_secret'),
      'test-client-secret'
    );
    return json({ access_token: 'new-access', expires_in: 3600 });
  } });
  authorize(drive); drive.credentials.expiresAt = 0;
  assert.deepEqual(await Promise.all([drive.accessToken(), drive.accessToken()]), ['new-access', 'new-access']);
  assert.equal(requests, 1);
  assert.equal(drive.credentials.refresh_token, 'refresh-secret');
  assert.ok(!JSON.stringify(drive.status()).includes('secret'));
});

test('401 refreshes authentication once and retries the request', async (t) => {
  const headers = [];
  const { drive } = setup(t, { fetchImpl: async (url, options) => {
    if (url.includes('/token')) return json({ access_token: 'new-access', expires_in: 3600 });
    headers.push(options.headers.Authorization);
    return headers.length === 1 ? json({ error: { message: 'Unauthorized' } }, 401) : json({ files: [] });
  } });
  authorize(drive);
  await drive.listVersions();
  assert.deepEqual(headers, ['Bearer access-secret', 'Bearer new-access']);
});

test('Drive listing paginates within private app storage', async (t) => {
  let count = 0;
  const { drive } = setup(t, { fetchImpl: async (url) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('spaces'), 'appDataFolder');
    assert.match(query.get('q'), /guide-v1/);
    count++;
    if (count === 1) return json({ files: [{ id: 'first' }], nextPageToken: 'next' });
    assert.equal(query.get('pageToken'), 'next');
    return json({ files: [{ id: 'second' }] });
  } });
  authorize(drive);
  assert.deepEqual((await drive.listVersions()).map((f) => f.id), ['first', 'second']);
});

test('connection test checks refresh, listing, upload, download and cleanup', async (t) => {
  const { drive } = setup(t); authorize(drive);
  const actions = [];
  drive.accessToken = async (force) => { assert.equal(force, true); actions.push('refresh'); };
  drive.listVersions = async () => { actions.push('list'); return []; };
  let uploaded;
  drive.upload = async ({ data, properties }) => { actions.push('upload'); assert.equal(properties.stepforge, 'connection-test'); uploaded = data; return { id: 'probe' }; };
  drive.download = async (id) => { assert.equal(id, 'probe'); actions.push('download'); return uploaded; };
  drive.authorized = async (url, options) => { assert.match(url, /probe$/); assert.equal(options.method, 'DELETE'); actions.push('cleanup'); };
  const result = await drive.test();
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 5);
  assert.deepEqual(actions, ['refresh', 'list', 'upload', 'download', 'cleanup']);
});

test('failed connection test still cleans up its test file', async (t) => {
  const { drive } = setup(t); authorize(drive);
  drive.accessToken = async () => 'access'; drive.listVersions = async () => [];
  drive.upload = async () => ({ id: 'probe' });
  drive.download = async () => { throw new Error('Download failed'); };
  let cleaned = false;
  drive.authorized = async () => { cleaned = true; };
  const result = await drive.test();
  assert.equal(result.ok, false); assert.equal(cleaned, true);
  assert.match(result.checks.join(' '), /Download failed/);
});

test('connection test reports cleanup failure instead of success', async (t) => {
  const { drive } = setup(t); authorize(drive);
  drive.accessToken = async () => 'access'; drive.listVersions = async () => [];
  let data;
  drive.upload = async (args) => { data = args.data; return { id: 'probe' }; };
  drive.download = async () => data;
  drive.authorized = async () => { throw new Error('Offline'); };
  const result = await drive.test(); assert.equal(result.ok, false);
  assert.match(result.checks.at(-1), /cleanup failed/);
});

test('disconnect removes encrypted tokens and never permits a late refresh to restore them', async (t) => {
  let complete;
  const { drive } = setup(t, { fetchImpl: () => new Promise((resolve) => { complete = resolve; }) });
  authorize(drive); drive.save(); drive.credentials.expiresAt = 0;
  const pending = drive.accessToken();
  drive.disconnect();
  complete(json({ access_token: 'late-token' }));
  await assert.rejects(pending, /account changed/);
  assert.equal(drive.status().connected, false); assert.equal(fs.existsSync(drive.file), false);
});

test('revoked refresh token reports actionable error without leaking tokens', async (t) => {
  const { drive } = setup(t, { fetchImpl: async () => json({ error: 'invalid_grant' }, 400) });
  authorize(drive);
  await assert.rejects(drive.accessToken(true), /Disconnect and sign in again/);
});

test('large archives use a resumable upload session at a trusted Google endpoint', async (t) => {
  const requests = [];
  const data = Buffer.alloc(6 * 1024 * 1024, 1);
  const { drive } = setup(t, { fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method });
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body).parents[0], 'appDataFolder');
      assert.equal(options.headers['X-Upload-Content-Length'], String(data.length));
      return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } });
    }
    assert.equal(options.method, 'PUT'); assert.equal(options.body, data);
    return json({ id: 'large-file' });
  } });
  authorize(drive);
  assert.equal((await drive.upload({ data, name: 'large.sfgz', properties: { stepforge: 'guide-v1' } })).id, 'large-file');
  assert.equal(requests.length, 2);
});

test('upload sessions cannot redirect credentials to another host', async (t) => {
  const { drive } = setup(t, { fetchImpl: async () => new Response(null, { headers: { location: 'https://unexpected.example/upload' } }) });
  authorize(drive);
  await assert.rejects(drive.upload({ data: Buffer.alloc(6 * 1024 * 1024), name: 'guide', properties: {} }), /unexpected upload destination/);
});

test('a cancelled authorization exchange cannot recreate disconnected credentials', async (t) => {
  const { drive } = setup(t, {
    openExternal: async (url) => {
      const auth = new URL(url); const redirect = new URL(auth.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', auth.searchParams.get('state')); redirect.searchParams.set('code', 'code');
      await fetch(redirect);
    },
    fetchImpl: async () => {
      drive.disconnect();
      return json({ access_token: 'late-access', refresh_token: 'late-refresh', scope: SCOPE });
    },
  });
  await assert.rejects(drive.connect(), /cancelled/);
  assert.equal(drive.status().connected, false); assert.equal(fs.existsSync(drive.file), false);
});

test('missing Drive consent never persists a connection', async (t) => {
  const { drive } = setup(t, {
    openExternal: async (url) => {
      const auth = new URL(url); const redirect = new URL(auth.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', auth.searchParams.get('state')); redirect.searchParams.set('code', 'code');
      await fetch(redirect);
    },
    fetchImpl: async () => json({ access_token: 'access', refresh_token: 'refresh', scope: 'email' }),
  });
  await assert.rejects(drive.connect(), /did not grant/);
  assert.equal(fs.existsSync(drive.file), false);
});

test('an unconfigured development build never opens a fabricated Google sign-in', async (t) => {
  let opened = false;
  const { drive } = setup(t, { clientId: '', openExternal: async () => { opened = true; } });
  assert.equal(drive.status().available, false);
  await assert.rejects(drive.connect(), /unavailable in this build/);
  assert.equal(opened, false);
});

test('stored tokens from a different application registration require sign-in again', (t) => {
  const { drive, directory, safeStorage } = setup(t);
  authorize(drive); drive.save();
  const updated = new GoogleDrive({ directory, safeStorage, clientId: 'official.apps.googleusercontent.com' });
  assert.equal(updated.status().connected, false);
  assert.match(updated.status().error, /sign in again/);
  assert.equal(updated.status().clientId, undefined);
});

test('the main-process registration cannot be overridden by connect arguments', async (t) => {
  let requestedClient;
  const { drive } = setup(t, {
    openExternal: async (url) => {
      const auth = new URL(url); requestedClient = auth.searchParams.get('client_id');
      const redirect = new URL(auth.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', auth.searchParams.get('state')); redirect.searchParams.set('error', 'access_denied');
      await fetch(redirect);
    },
  });
  await assert.rejects(drive.connect({ clientId: 'other.apps.googleusercontent.com' }), /denied/);
  assert.equal(requestedClient, 'test.apps.googleusercontent.com');
});

function memoryVault() {
  const entries = new Map();
  return { entries,
    async read(clientId) { return entries.get(clientId) ?? null; },
    async write(clientId, secret) { entries.set(clientId, secret); },
    async clear(clientId) { entries.delete(clientId); } };
}
// A reinstall or keyring change: same data folder, but a different encryption key.
function freshKeyring() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString(); },
  };
}
const settleBackup = () => new Promise((resolve) => setImmediate(resolve));

test('a sign-in whose primary file became unreadable is recovered from the OS backup', async (t) => {
  const vault = memoryVault();
  const { drive, directory } = setup(t, { vault });
  authorize(drive); drive.credentials.email = 'user@example.com'; drive.save();
  await settleBackup();
  assert.ok(!vault.entries.get('test.apps.googleusercontent.com').includes('access-secret'));
  const keyring = freshKeyring();
  const reinstalled = new GoogleDrive({ directory, safeStorage: keyring, vault, clientId: 'test.apps.googleusercontent.com', clientSecret: 'test-client-secret' });
  assert.equal(reinstalled.status().connected, false);
  assert.equal(await reinstalled.recover(), true);
  assert.deepEqual(reinstalled.status(), { connected: true, available: true, email: 'user@example.com', photoLink: '', error: null });
  // The primary file is rewritten with the new key, so the next launch needs no backup.
  const nextLaunch = new GoogleDrive({ directory, safeStorage: keyring, clientId: 'test.apps.googleusercontent.com', clientSecret: 'test-client-secret' });
  assert.equal(nextLaunch.credentials.refresh_token, 'refresh-secret');
});

test('a missing credential file is restored from the OS backup after a clean reinstall', async (t) => {
  const vault = memoryVault();
  const { drive, directory, safeStorage } = setup(t, { vault });
  authorize(drive); drive.save(); await settleBackup();
  fs.rmSync(drive.file);
  const reinstalled = new GoogleDrive({ directory, safeStorage, vault, clientId: 'test.apps.googleusercontent.com', clientSecret: 'test-client-secret' });
  assert.equal(await reinstalled.recover(), true);
  assert.equal(reinstalled.status().connected, true);
  assert.ok(fs.existsSync(reinstalled.file));
});

test('an existing sign-in is backed up at launch and disconnect removes the backup', async (t) => {
  const vault = memoryVault();
  const { drive, directory, safeStorage } = setup(t);
  authorize(drive); drive.save();
  const launched = new GoogleDrive({ directory, safeStorage, vault, clientId: 'test.apps.googleusercontent.com', clientSecret: 'test-client-secret' });
  assert.equal(await launched.recover(), false);
  assert.equal(JSON.parse(vault.entries.get('test.apps.googleusercontent.com')).refresh_token, 'refresh-secret');
  await launched.disconnect();
  assert.equal(vault.entries.size, 0);
  assert.equal(fs.existsSync(launched.file), false);
});

test('backups from another registration or a failing OS store are ignored', async (t) => {
  const vault = memoryVault();
  vault.entries.set('test.apps.googleusercontent.com', JSON.stringify({ clientId: 'other.apps.googleusercontent.com', refresh_token: 'x' }));
  const { drive } = setup(t, { vault });
  assert.equal(await drive.recover(), false);
  assert.equal(drive.status().connected, false);
  const broken = { read: async () => { throw new Error('no keyring'); }, write: async () => { throw new Error('no keyring'); }, clear: async () => {} };
  const { drive: other } = setup(t, { vault: broken });
  assert.equal(await other.recover(), false);
  authorize(other); other.save(); await settleBackup();
  assert.equal(other.status().connected, true);
});


test('account photo refreshes legacy credentials once per session and persists across restarts', async (t) => {
  let calls = 0;
  const photoLink = 'https://lh3.googleusercontent.com/avatar';
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('fields'), 'user(permissionId,emailAddress,photoLink)');
    return json({ user: { permissionId: 'account', emailAddress: 'test@example.com', photoLink } });
  };
  const { drive, directory, safeStorage } = setup(t, { fetchImpl });
  authorize(drive);
  drive.credentials.accountId = 'account';
  assert.deepEqual(await Promise.all([drive.account(), drive.account()]), ['account', 'account']);
  assert.equal(drive.status().photoLink, photoLink);
  await drive.account();
  assert.equal(calls, 1);
  const restarted = new GoogleDrive({ directory, safeStorage, fetchImpl,
    clientId: drive.clientId, clientSecret: drive.clientSecret });
  assert.equal(restarted.status().photoLink, photoLink);
  await restarted.account();
  assert.equal(calls, 2);
  drive.disconnect();
  assert.equal(drive.status().photoLink, '');
});

test('missing or untrusted photos leave the account usable with an empty avatar URL', async (t) => {
  for (const photoLink of [undefined, 'http://lh3.googleusercontent.com/p', 'https://example.com/p',
    'https://googleusercontent.com.evil.example/p', 'https://user:pass@lh3.googleusercontent.com/p']) {
    const { drive } = setup(t, { fetchImpl: async () => json({ user: { permissionId: 'account', photoLink } }) });
    authorize(drive);
    assert.equal(await drive.account(), 'account');
    assert.equal(drive.status().photoLink, '');
  }
});

test('optional profile refresh failure preserves a cached account and photo', async (t) => {
  const { drive } = setup(t, { fetchImpl: async () => { throw new Error('offline'); } });
  authorize(drive);
  Object.assign(drive.credentials, { accountId: 'account', photoLink: 'https://lh3.googleusercontent.com/cached' });
  assert.equal(await drive.account(), 'account');
  assert.equal(drive.status().photoLink, 'https://lh3.googleusercontent.com/cached');
});

test('a late account response cannot restore a disconnected profile', async (t) => {
  let finish;
  const { drive } = setup(t, { fetchImpl: () => new Promise((resolve) => { finish = resolve; }) });
  authorize(drive);
  const pending = drive.account();
  await Promise.resolve();
  drive.disconnect();
  finish(json({ user: { permissionId: 'account', photoLink: 'https://lh3.googleusercontent.com/late' } }));
  await assert.rejects(pending, /account changed/);
  assert.equal(drive.status().photoLink, '');
  assert.equal(fs.existsSync(drive.file), false);
});
