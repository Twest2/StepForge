'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LATEST_RELEASE_API,
  STORE_CATALOG_API,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  installHint,
  checkForUpdates,
} = require('../../app/update-check');

/**
 * Settings → About "Check for updates": these tests drive the real checker
 * against scripted GitHub responses and verify what the user would be told,
 * plus the network guarantees (one fixed endpoint, no redirects, deadline,
 * size cap).
 */

function githubReturns(body, { status = 200, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetchImpl, calls };
}

const release = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/Twest2/StepForge/releases/tag/${tag}`,
  published_at: '2026-09-23T12:00:00Z',
  ...extra,
});

test('versions compare numerically across short, three- and four-part forms', () => {
  assert.deepEqual(parseVersion('v1.0'), [1, 0, 0, 0]);
  assert.deepEqual(parseVersion('0.6.1.3'), [0, 6, 1, 3]);
  assert.equal(parseVersion('1.0-beta'), null);
  assert.equal(parseVersion(''), null);
  assert.ok(compareVersions(parseVersion('v1.0'), parseVersion('0.7.0')) > 0);
  assert.ok(compareVersions(parseVersion('0.6.1.3'), parseVersion('v0.7')) < 0);
  assert.equal(compareVersions(parseVersion('v0.7'), parseVersion('0.7.0')), 0);
  // Numeric, not lexical: 0.10 is newer than 0.9.
  assert.ok(compareVersions(parseVersion('0.10'), parseVersion('0.9.9')) > 0);
});

test('a newer release is reported with its link and an install hint for this platform', async () => {
  const { fetchImpl } = githubReturns(release('v1.0'));
  const result = await checkForUpdates({ currentVersion: '0.7.0', platform: 'win32', fetchImpl });
  assert.equal(result.status, 'update-available');
  assert.equal(result.latestVersion, '1.0');
  assert.equal(result.currentVersion, '0.7.0');
  assert.equal(result.releaseUrl, 'https://github.com/Twest2/StepForge/releases/tag/v1.0');
  assert.match(result.hint, /Download the new installer/);
  assert.equal(result.updateNow, false, 'not registered with Chocolatey: download only');
});

test('Windows: Update now is offered only for an install registered with Chocolatey', async () => {
  const registered = await checkForUpdates({ currentVersion: '0.7.0', platform: 'win32', chocolatey: true, fetchImpl: githubReturns(release('v1.0')).fetchImpl });
  assert.equal(registered.updateNow, true);
  assert.match(registered.hint, /^Update now installs it with Chocolatey\. StepForge closes while it updates and opens again when it’s done\.$/);

  // Linux never gets the button, whatever it is told.
  const linux = await checkForUpdates({ currentVersion: '0.7.0', platform: 'linux', chocolatey: true, fetchImpl: githubReturns(release('v1.0')).fetchImpl });
  assert.equal(linux.updateNow, false);
  assert.match(linux.hint, /Download the new version/);

  const current = await checkForUpdates({ currentVersion: '1.0', platform: 'win32', chocolatey: true, fetchImpl: githubReturns(release('v1.0')).fetchImpl });
  assert.equal(current.status, 'up-to-date');
  assert.equal(current.updateNow, undefined, 'nothing to update');
});

// What the Store's public catalog answers, cut down to what the check reads.
const catalog = (...versions) => ({ Products: [{ DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: versions.map((v) => ({
  PackageFullName: `TylerWestbrook.StepForge_${v}_x64__g82bmjxgmp812`, PackageFormat: 'Msix' })) } } }] }] });

/** A Store install's network: the catalog answers with `live`; GitHub with `releaseBody` for a tag. */
function storeReturns(live, { catalogStatus = 200, releaseStatus = 200, releaseBody = 'Release notes' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith(STORE_CATALOG_API)) return new Response(JSON.stringify(live), { status: catalogStatus });
    const tag = url.split('/').pop();
    return new Response(JSON.stringify(release(tag, { body: releaseBody })), { status: releaseStatus });
  };
  return { fetchImpl, calls };
}
const storeCheck = (currentVersion, network) => checkForUpdates({ currentVersion, platform: 'win32', chocolatey: true, store: true, productId: '9NDH81CF1HGV', fetchImpl: network.fetchImpl });

test('a Microsoft Store install asks the Store, and hears only about a version the Store has', async () => {
  // GitHub may already have 1.6.9; the Store still has 1.6.8, so that's what's offered.
  const network = storeReturns(catalog('1.6.800.0', '1.6.700.0'));
  const store = await storeCheck('1.6.7', network);
  assert.equal(store.status, 'update-available');
  assert.deepEqual([store.latestVersion, store.store, store.updateNow], ['1.6.8', true, false], 'the Store updates it, even beside a Chocolatey-registered copy');
  assert.equal(store.notes, 'Release notes', 'the notes come from that version’s GitHub release');
  assert.equal(store.releaseUrl, 'https://github.com/Twest2/StepForge/releases/tag/v1.6.8');
  assert.match(store.hint, /^It’s in the Microsoft Store now/);
  assert.doesNotMatch(store.hint, /installer|Chocolatey/);
  assert.deepEqual(network.calls.map((c) => c.url), [
    `${STORE_CATALOG_API}?bigIds=9NDH81CF1HGV&market=US&languages=en-US`,
    'https://api.github.com/repos/Twest2/StepForge/releases/tags/v1.6.8',
  ]);
  assert.ok(network.calls.every((c) => c.options.method === 'GET' && c.options.redirect === 'error' && !c.options.body), 'reads only, never follows redirects');

  // Up to date with the Store: nothing to show, and GitHub isn't asked.
  const current = storeReturns(catalog('1.6.800.0'));
  assert.equal((await storeCheck('1.6.8', current)).status, 'up-to-date');
  assert.equal(current.calls.length, 1);
  // A fourth version part maps the same way the Store package numbers it.
  assert.equal((await storeCheck('1.6.8', storeReturns(catalog('1.6.801.0')))).latestVersion, '1.6.8.1');

  // Without the notes, the update is still offered.
  const noNotes = await storeCheck('1.6.7', storeReturns(catalog('1.6.800.0'), { releaseStatus: 404 }));
  assert.deepEqual([noNotes.status, noNotes.notes, noNotes.releaseUrl], ['update-available', '', RELEASES_PAGE]);
});

test('a Store check that can’t read the Store says so, and never offers an update', async () => {
  for (const [network, message] of [
    [storeReturns(catalog('1.6.800.0'), { catalogStatus: 503 }), /Microsoft Store returned an error \(503\)/],
    [storeReturns({ Products: [] }), /didn’t say which version/],
    [{ fetchImpl: async () => { throw new TypeError('fetch failed'); } }, /Couldn’t reach the Microsoft Store/],
  ]) {
    const result = await storeCheck('1.6.7', network);
    assert.equal(result.status, 'error');
    assert.match(result.message, message);
  }
  // A build without its Store ID or a usable version doesn't ask at all.
  const quiet = storeReturns(catalog('1.6.800.0'));
  assert.equal((await checkForUpdates({ currentVersion: '1.6.7', platform: 'win32', store: true, productId: '', fetchImpl: quiet.fetchImpl })).status, 'error');
  assert.equal(quiet.calls.length, 0);
});

test('only a Windows Microsoft Store install asks the Store', async () => {
  const installer = await checkForUpdates({ currentVersion: '0.7.0', platform: 'win32', fetchImpl: githubReturns(release('v1.0')).fetchImpl });
  assert.equal(installer.store, false);

  const linux = await checkForUpdates({ currentVersion: '0.7.0', platform: 'linux', store: true, fetchImpl: githubReturns(release('v1.0')).fetchImpl });
  assert.equal(linux.store, false, 'only Windows has a Microsoft Store install');
  assert.match(linux.hint, /Download the new version/);
});

test('the Windows hint without Chocolatey says how to get one-click updates', () => {
  const hint = installHint('win32');
  assert.equal(hint, 'Download the new installer from the release page. Run the installer again and keep "Keep StepForge updated with Chocolatey" checked to get one-click updates.');
  assert.equal(installHint('win32', () => false, { chocolatey: false }), hint);
  assert.doesNotMatch(installHint('win32', () => false, { chocolatey: true }), /installer/);
});

test('Linux hints follow the installed package manager', () => {
  assert.match(installHint('linux', (cmd) => cmd === 'dnf'), /sudo dnf upgrade stepforge/);
  assert.match(installHint('linux', (cmd) => cmd === 'apt'), /apt install --only-upgrade stepforge/);
  assert.match(installHint('linux', () => false), /Download the new version/);
});

test('the same or an older release means the user is up to date', async () => {
  const same = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl: githubReturns(release('v0.7')).fetchImpl });
  assert.equal(same.status, 'up-to-date');
  assert.equal(same.latestVersion, '0.7');
  const ahead = await checkForUpdates({ currentVersion: '1.1.0', fetchImpl: githubReturns(release('v1.0')).fetchImpl });
  assert.equal(ahead.status, 'up-to-date');
});

test('the check makes exactly one GET to the fixed endpoint, refuses redirects, and sends no data', async () => {
  const { fetchImpl, calls } = githubReturns(release('v1.0'));
  await checkForUpdates({ currentVersion: '0.7.0', fetchImpl });
  assert.equal(calls.length, 1);
  const [{ url, options }] = calls;
  assert.equal(url, LATEST_RELEASE_API);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body, undefined);
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(options.headers['User-Agent'], 'StepForge/0.7.0');
  assert.ok(options.signal, 'request must be cancellable');
});

test('a release link outside the StepForge releases page is never offered to the user', async () => {
  const { fetchImpl } = githubReturns(release('v1.0', { html_url: 'https://evil.example/download' }));
  const result = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl });
  assert.equal(result.status, 'update-available');
  assert.equal(result.releaseUrl, RELEASES_PAGE);
});

test('network failures, rate limits, and missing releases give a clear message instead of throwing', async () => {
  const offline = await checkForUpdates({
    currentVersion: '0.7.0',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.equal(offline.status, 'error');
  assert.match(offline.message, /Couldn’t reach GitHub/);

  const limited = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl: githubReturns({}, { status: 403 }).fetchImpl });
  assert.equal(limited.status, 'error');
  assert.match(limited.message, /limiting requests/);

  const none = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl: githubReturns({}, { status: 404 }).fetchImpl });
  assert.equal(none.status, 'error');
  assert.match(none.message, /No published release/);

  const garbled = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl: githubReturns('not json').fetchImpl });
  assert.equal(garbled.status, 'error');
});

test('a slow GitHub is abandoned at the deadline', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const result = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl, timeoutMs: 50 });
  assert.equal(result.status, 'error');
  assert.match(result.message, /took too long/);
  assert.ok(Date.now() - started < 2000);
});

test('oversized responses are rejected before parsing', async () => {
  const huge = JSON.stringify(release('v1.0', { body: 'x'.repeat(2 * 1024 * 1024) }));
  const result = await checkForUpdates({ currentVersion: '0.7.0', fetchImpl: githubReturns(huge).fetchImpl });
  assert.equal(result.status, 'error');
});

test('a build without a usable version never contacts GitHub', async () => {
  const { fetchImpl, calls } = githubReturns(release('v1.0'));
  const result = await checkForUpdates({ currentVersion: 'dev', fetchImpl });
  assert.equal(result.status, 'error');
  assert.equal(calls.length, 0);
});

test('an available update carries the release text as its notes', async () => {
  const { fetchImpl } = githubReturns({ ...release('v1.1'), body: '## What\'s new\n- Faster exports' });
  const result = await checkForUpdates({ currentVersion: '1.0', fetchImpl });
  assert.equal(result.status, 'update-available');
  assert.equal(result.notes, '## What\'s new\n- Faster exports');
  const { fetchImpl: noBody } = githubReturns({ ...release('v1.1'), body: null });
  assert.equal((await checkForUpdates({ currentVersion: '1.0', fetchImpl: noBody })).notes, '');
});

test('main.js checks at startup only for installs that should', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../app/main.js'), 'utf8');
  // Every install checks, Microsoft Store ones included; only source checkouts and the setting turn it off.
  assert.match(main, /checkUpdatesOnStart: !devBuild && settings\.get\('updates\.checkOnStart'\) !== false,/);
});
