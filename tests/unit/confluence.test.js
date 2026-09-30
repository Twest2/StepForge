'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Confluence, normalizeSite, friendlyNetworkError } = require('../../app/confluence');
const { makeTmpDir, rmrf } = require('./helpers');

function safeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, c.update(text), c.final()]); },
    decryptString(bytes) { const c = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([c.update(bytes.subarray(16)), c.final()]).toString(); },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A small Confluence Data Center: users, spaces, pages and attachments. */
function dataCenter({ base = 'https://wiki.example.mil/confluence', token = 'pat-123', needsCertificate = false } = {}) {
  const server = { pages: new Map(), attachments: new Map(), requests: [], nextId: 100, certificateOk: !needsCertificate };
  server.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    server.requests.push(`${method} ${u.pathname}${u.search}`);
    assert.equal(init.redirect, 'manual', 'never follows redirects');
    if (!server.certificateOk) throw new TypeError('net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED');
    assert.ok(url.startsWith(base), `stays on the site: ${url}`);
    const auth = init.headers?.Authorization;
    const signedIn = auth === `Bearer ${token}` || (server.cookie && !auth);
    const rest = u.pathname.slice(new URL(base).pathname.length);
    if (rest === '/rest/api/user/current') return json(signedIn ? { type: 'known', username: 'casey', displayName: 'Casey Jones', userKey: 'u1' } : { type: 'anonymous' });
    if (!signedIn) return json({ message: 'Not authorized' }, 401);
    assert.equal(init.headers['X-Atlassian-Token'], 'no-check');
    if (rest === '/rest/api/space') {
      const start = Number(u.searchParams.get('start'));
      const all = Array.from({ length: 130 }, (_, i) => ({ key: `S${i}`, name: `Space ${String(i).padStart(3, '0')}`, id: i }));
      return json({ results: all.slice(start, start + 100) });
    }
    if (rest === '/rest/api/content/search') return json({ results: [{ id: '7', title: 'How-to guides' }] });
    if (rest === '/rest/api/content' && method === 'GET') {
      const found = [...server.pages.values()].find((p) => p.title === u.searchParams.get('title') && p.space === u.searchParams.get('spaceKey'));
      return json({ results: found ? [{ id: found.id, title: found.title }] : [] });
    }
    if (rest === '/rest/api/content' && method === 'POST') {
      const body = JSON.parse(init.body);
      const id = String(server.nextId++);
      server.pages.set(id, { id, title: body.title, space: body.space.key, body: body.body.storage.value, version: 1, ancestors: body.ancestors });
      return json({ id, version: { number: 1 }, _links: { base, webui: `/display/${body.space.key}/${encodeURIComponent(body.title)}` } });
    }
    let match = /^\/rest\/api\/content\/(\d+)$/.exec(rest);
    if (match && method === 'GET') {
      const page = server.pages.get(match[1]);
      return page ? json({ id: page.id, title: page.title, version: { number: page.version } }) : json({ message: 'No content' }, 404);
    }
    if (match && method === 'PUT') {
      const page = server.pages.get(match[1]);
      const body = JSON.parse(init.body);
      assert.equal(body.version.number, page.version + 1, 'updates bump the version');
      Object.assign(page, { title: body.title, body: body.body.storage.value, version: body.version.number });
      return json({ id: page.id, version: { number: page.version }, _links: { base, webui: `/display/${page.space}/${encodeURIComponent(page.title)}` } });
    }
    match = /^\/rest\/api\/content\/(\d+)\/child\/attachment(?:\/(\w+)\/data)?$/.exec(rest);
    if (match && method === 'GET') {
      const found = [...server.attachments.values()].filter((a) => a.page === match[1] && a.title === u.searchParams.get('filename'));
      return json({ results: found.map((a) => ({ id: a.id, title: a.title })) });
    }
    if (match && method === 'POST') {
      const raw = Buffer.from(init.body);
      assert.match(init.headers['Content-Type'], /^multipart\/form-data; boundary=/);
      const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))[1];
      if (match[2]) { server.attachments.get(match[2]).updates += 1; return json({ id: match[2] }); }
      const id = `att${server.nextId++}`;
      server.attachments.set(id, { id, page: match[1], title: name, size: raw.length, updates: 0 });
      return json({ results: [{ id, title: name }] });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return server;
}

function setup(t, server, options = {}) {
  const directory = makeTmpDir('confluence');
  t.after(() => rmrf(directory));
  const confluence = new Confluence({ directory, safeStorage: safeStorage(), fetchImpl: server.fetch, ...options });
  return { confluence, directory };
}

const page = (title = 'Reset a password') => ({ title, body: '<p>Step 1</p><ac:image><ri:attachment ri:filename="001-open.png" /></ac:image>',
  attachments: [{ name: '001-open.png', data: Buffer.alloc(2000, 1) }, { name: '002-save.png', data: Buffer.alloc(3000, 2) }] });

test('site addresses: Cloud gets /wiki, a copied page link becomes the site, http only on a home network', () => {
  assert.deepEqual(normalizeSite('acme.atlassian.net'), { baseUrl: 'https://acme.atlassian.net/wiki', cloud: true });
  assert.deepEqual(normalizeSite('https://acme.atlassian.net/wiki/spaces/DOC/overview'), { baseUrl: 'https://acme.atlassian.net/wiki', cloud: true });
  assert.deepEqual(normalizeSite('wiki.example.mil/confluence/display/OPS/Home'), { baseUrl: 'https://wiki.example.mil/confluence', cloud: false });
  assert.deepEqual(normalizeSite('https://confluence.example.com/pages/viewpage.action?pageId=5'), { baseUrl: 'https://confluence.example.com', cloud: false });
  assert.throws(() => normalizeSite('http://confluence.example.com'), /https/);
});

test('a personal access token signs in, is stored encrypted, and is only sent to the site', async (t) => {
  const server = dataCenter();
  const { confluence, directory } = setup(t, server);
  const probe = confluence.probe('wiki.example.mil/confluence');
  assert.equal(probe.tokenUrl, 'https://wiki.example.mil/confluence/plugins/personalaccesstokens/usertokens.action');
  await assert.rejects(confluence.connect({ address: 'wiki.example.mil/confluence', token: 'wrong' }), /didn’t accept the sign-in/);
  const status = await confluence.connect({ address: 'wiki.example.mil/confluence', token: 'pat-123' });
  assert.deepEqual([status.connected, status.user, status.host, status.cloud, status.method], [true, 'Casey Jones', 'wiki.example.mil', false, 'token']);
  const saved = fs.readFileSync(path.join(directory, 'confluence.credentials'));
  assert.equal(saved.includes('pat-123'), false);
  const reopened = new Confluence({ directory, safeStorage: confluence.safeStorage, fetchImpl: server.fetch });
  assert.equal(reopened.status().user, 'Casey Jones');
});

test('a smart-card site gets its certificate handshake from a hidden page, then the request is retried', async (t) => {
  const server = dataCenter({ needsCertificate: true });
  const opened = [];
  const { confluence } = setup(t, server, { openHiddenPage: async (url) => { opened.push(url); server.certificateOk = true; } });
  const status = await confluence.connect({ address: 'wiki.example.mil/confluence', token: 'pat-123' });
  assert.equal(status.connected, true);
  assert.deepEqual(opened, ['https://wiki.example.mil/']);
});

test('smart card and certificate problems are explained plainly', () => {
  assert.match(friendlyNetworkError(new Error('net::ERR_BAD_SSL_CLIENT_AUTH_CERT'), 'wiki.example.mil'), /smart card \(CAC\) certificate/);
  assert.match(friendlyNetworkError(new Error('net::ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED'), 'wiki.example.mil'), /PIN/);
  assert.match(friendlyNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'wiki.example.mil'), /DoD root certificates/);
  assert.match(friendlyNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'), 'wiki.example.mil'), /Couldn’t reach wiki\.example\.mil/);
});

test('browser sign-in waits for the site to recognize the user, then keeps using its session', async (t) => {
  const server = dataCenter();
  let windows = 0;
  const { confluence } = setup(t, server, { openLoginWindow: async (url, { signedIn }) => {
    windows += 1;
    assert.equal(url, 'https://wiki.example.mil/confluence/');
    assert.equal(await signedIn(), false);
    server.cookie = true; // the user signs in with their card
    return signedIn();
  } });
  const status = await confluence.connectWithBrowser({ address: 'wiki.example.mil/confluence' });
  assert.deepEqual([status.connected, status.method, windows], [true, 'browser', 1]);
  assert.equal((await confluence.spaces()).length, 130);
  server.cookie = false;
  await assert.rejects(confluence.spaces(), /sign-in/);
});

test('spaces are listed across pages, and parent pages can be searched', async (t) => {
  const server = dataCenter();
  const { confluence } = setup(t, server);
  await confluence.connect({ address: 'wiki.example.mil/confluence', token: 'pat-123' });
  const spaces = await confluence.spaces();
  assert.equal(spaces.length, 130);
  assert.equal(spaces[0].name, 'Space 000');
  assert.deepEqual(await confluence.findPages({ spaceKey: 'OPS', query: 'How "to' }), [{ id: '7', title: 'How-to guides' }]);
  const search = server.requests.find((r) => r.includes('/content/search'));
  assert.match(decodeURIComponent(search), /space = "OPS" and type = page and title ~ "How \\"to\*"/, 'search text is escaped');
});

test('publishing creates the page with its screenshots, and publishing again updates the same page', async (t) => {
  const server = dataCenter();
  const { confluence } = setup(t, server);
  await confluence.connect({ address: 'wiki.example.mil/confluence', token: 'pat-123' });
  const space = { key: 'OPS', name: 'Operations' };
  const progress = [];
  const first = await confluence.publish({ guideId: 'guide-1', space, parent: { id: '7', title: 'How-to guides' }, page: page(), onProgress: (p) => progress.push(p.stage) });
  assert.equal(first.url, 'https://wiki.example.mil/confluence/display/OPS/Reset%20a%20password');
  assert.equal(first.updated, false);
  const created = server.pages.get(first.id);
  assert.deepEqual(created.ancestors, [{ id: '7' }]);
  assert.deepEqual([...server.attachments.values()].map((a) => a.title), ['001-open.png', '002-save.png']);
  assert.deepEqual([...new Set(progress)], ['page', 'upload']);
  assert.equal(confluence.publishedFor('guide-1').id, first.id);

  const second = await confluence.publish({ guideId: 'guide-1', space, page: page() });
  assert.equal(second.id, first.id, 'the same page');
  assert.equal(second.updated, true);
  assert.equal(server.pages.get(first.id).version, 2);
  assert.equal(server.attachments.size, 2, 'screenshots are replaced, not duplicated');
  assert.ok([...server.attachments.values()].every((a) => a.updates === 1));
});

test('a page with the same title is only replaced when the user says so', async (t) => {
  const server = dataCenter();
  const { confluence } = setup(t, server);
  await confluence.connect({ address: 'wiki.example.mil/confluence', token: 'pat-123' });
  const space = { key: 'OPS', name: 'Operations' };
  await confluence.publish({ guideId: 'someone-else', space, page: page('Shared title') });
  const asked = await confluence.publish({ guideId: 'guide-2', space, page: page('Shared title') });
  assert.deepEqual(asked, { conflict: { title: 'Shared title', space: 'Operations' } });
  assert.equal(server.pages.size, 1);
  const replaced = await confluence.publish({ guideId: 'guide-2', space, page: page('Shared title'), replace: true });
  assert.equal(replaced.updated, true);
  assert.equal(server.pages.size, 1);
});

test('Confluence Cloud signs in with an email and API token and publishes through the v2 pages API', async (t) => {
  const requests = [];
  const pages = new Map();
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push(`${init.method || 'GET'} ${u.pathname}`);
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('casey@example.com:api-token').toString('base64')}`);
    if (u.pathname === '/wiki/rest/api/user/current') return json({ accountId: 'a1', displayName: 'Casey', type: 'known' });
    if (u.pathname === '/wiki/api/v2/spaces') return json({ results: [{ id: 42, key: 'DOC', name: 'Docs' }], _links: {} });
    if (u.pathname === '/wiki/api/v2/pages' && (init.method || 'GET') === 'GET') return json({ results: [] });
    if (u.pathname === '/wiki/api/v2/pages') {
      const body = JSON.parse(init.body);
      assert.deepEqual([body.spaceId, body.status, body.body.representation], ['42', 'current', 'storage']);
      pages.set('900', body);
      return json({ id: '900', version: { number: 1 }, _links: { base: 'https://acme.atlassian.net/wiki', webui: '/spaces/DOC/pages/900' } });
    }
    if (/\/child\/attachment/.test(u.pathname)) return json({ results: [] });
    throw new Error(`unexpected ${url}`);
  };
  const directory = makeTmpDir('confluence');
  t.after(() => rmrf(directory));
  const confluence = new Confluence({ directory, safeStorage: safeStorage(), fetchImpl });
  await assert.rejects(confluence.connect({ address: 'acme.atlassian.net', token: 'api-token', email: 'not-an-email' }), /email address/);
  const status = await confluence.connect({ address: 'acme.atlassian.net', token: 'api-token', email: 'casey@example.com' });
  assert.equal(status.cloud, true);
  const [space] = await confluence.spaces();
  const result = await confluence.publish({ guideId: 'g', space, page: page() });
  assert.equal(result.url, 'https://acme.atlassian.net/wiki/spaces/DOC/pages/900');
  assert.ok(requests.includes('POST /wiki/rest/api/content/900/child/attachment'));
});

test('publishing names screenshots by step number, so private details in step titles stay off the site', async (t) => {
  const { GuideStore } = require('../../core/store');
  const { buildRenderAst } = require('../../core/renderast');
  const { runExport } = require('../../exporters');
  const { pageFromExport } = require('../../app/confluence');
  const { TINY_PNG } = require('./helpers');
  const root = makeTmpDir('confluence-export');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'library'));
  const guide = store.createGuide({ title: 'Send the report' });
  store.addStep(guide.guideId, { title: 'Open settings' }, TINY_PNG, { width: 1, height: 1 });
  store.addStep(guide.guideId, { title: 'Email casey.jones@contoso.com' }, TINY_PNG, { width: 1, height: 1 });
  const result = runExport('confluence', buildRenderAst(store, guide.guideId, {}), path.join(root, 'out'), { apiFiles: true, includeImages: true });
  const exported = pageFromExport(path.dirname(result.apiPage));
  assert.equal(exported.title, 'Send the report');
  assert.deepEqual(exported.attachments.map((a) => a.name), ['step-001.png', 'step-002.png']);
  assert.ok(exported.attachments.every((a) => a.data.length > 0));
  assert.match(exported.body, /ri:filename="step-002\.png"/);
  assert.doesNotMatch(exported.body, /ri:filename="\d{3}-/, 'every image points at a renamed attachment');
  assert.doesNotMatch(exported.attachments.map((a) => a.name).join(' '), /contoso/);
});

test('a smart card’s sign-in certificate is chosen over its email one, and the choice is remembered per site', async () => {
  const { signInCertificates, hostOf } = require('../../app/confluence-session');
  const pem = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/certificates', name), 'utf8');
  const signIn = { data: pem('sign-in.pem'), fingerprint: 'sha256/sign-in', subjectName: 'TEST.ONLY.auth' };
  const email = { data: pem('email-signing.pem'), fingerprint: 'sha256/email', subjectName: 'TEST.ONLY.email' };
  assert.deepEqual(signInCertificates([email, signIn]), [signIn]);
  assert.deepEqual(signInCertificates([email]), [email], 'with nothing better, every certificate is offered');
  assert.equal(hostOf('wiki.example.mil:443'), 'wiki.example.mil');
  assert.equal(hostOf('https://wiki.example.mil/confluence'), 'wiki.example.mil');
});

test('with two sign-in certificates StepForge asks once per site, then uses the saved choice', async () => {
  const { createConfluenceSession } = require('../../app/confluence-session');
  const pem = fs.readFileSync(path.join(__dirname, '../fixtures/certificates/sign-in.pem'), 'utf8');
  const fakeSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, fetch() {} };
  const saved = new Map();
  let asked = 0;
  const parts = createConfluenceSession({
    session: { fromPartition: (name) => { assert.equal(name, 'persist:confluence'); return fakeSession; } },
    BrowserWindow: class {},
    remembered: (host) => saved.get(host) || null,
    remember: (host, fingerprint) => saved.set(host, fingerprint),
    ask: async (host, certificates) => { asked += 1; assert.equal(host, 'wiki.example.mil'); assert.equal(certificates.length, 2); return 1; },
  });
  const certificates = [{ data: pem, fingerprint: 'one' }, { data: pem, fingerprint: 'two' }];
  assert.equal((await parts.chooseCertificate('wiki.example.mil:443', certificates)).fingerprint, 'two');
  assert.equal((await parts.chooseCertificate('wiki.example.mil:443', certificates)).fingerprint, 'two');
  assert.equal(asked, 1);
  // Only the Confluence session's requests are handled; others keep Electron's default.
  let prevented = false;
  parts.onSelectCertificate({ preventDefault: () => { prevented = true; } }, { session: {} }, 'x', certificates, () => {});
  assert.equal(prevented, false);
});
