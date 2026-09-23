'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LATEST_RELEASE_API,
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
  assert.match(result.hint, /choco upgrade stepforge/);
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
