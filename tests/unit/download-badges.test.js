'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SOURCES, badgeLabels, sortBadges, fetchCounts } = require('../../scripts/sort-download-badges');

const ROOT = path.resolve(__dirname, '..', '..');

const README = [
  '# StepForge',
  '<!-- download-badges:start (kept sorted by count) -->',
  '<p align="center">',
  '  <a href="a"><img alt="GitHub downloads" src="gh"></a>',
  '  <a href="b"><img alt="APT downloads" src="apt"></a>',
  '  <a href="c"><img alt="DNF downloads" src="dnf"></a>',
  '  <a href="d"><img alt="Chocolatey downloads" src="choco"></a>',
  '</p>',
  '<!-- download-badges:end -->',
  'More text',
  '',
].join('\n');

test('badges are reordered from most to fewest downloads', () => {
  const sorted = sortBadges(README, {
    'GitHub downloads': 52,
    'APT downloads': 18,
    'DNF downloads': 0,
    'Chocolatey downloads': 7,
  });
  assert.deepEqual(badgeLabels(sorted), [
    'GitHub downloads',
    'APT downloads',
    'Chocolatey downloads',
    'DNF downloads',
  ]);
  // Only the badge lines move; everything around them is untouched.
  assert.equal(sorted.split('\n').length, README.split('\n').length);
  assert.match(sorted, /^# StepForge\n/);
  assert.match(sorted, /<\/p>\n<!-- download-badges:end -->\nMore text\n$/);
});

test('an already sorted README comes back unchanged, and ties keep their order', () => {
  const counts = {
    'GitHub downloads': 9,
    'APT downloads': 5,
    'DNF downloads': 5,
    'Chocolatey downloads': 1,
  };
  assert.equal(sortBadges(README, counts), README);
});

test('CRLF line endings are preserved', () => {
  const crlf = README.replace(/\n/g, '\r\n');
  const sorted = sortBadges(crlf, {
    'GitHub downloads': 0,
    'APT downloads': 1,
    'DNF downloads': 2,
    'Chocolatey downloads': 3,
  });
  assert.ok(!/[^\r]\n/.test(sorted), 'every newline stays CRLF');
  assert.equal(badgeLabels(sorted)[0], 'Chocolatey downloads');
});

test('missing markers or counts fail instead of guessing', () => {
  assert.throws(() => sortBadges('# no badges\n', {}), /markers/);
  assert.throws(() => sortBadges(README, { 'GitHub downloads': 1 }), /No download count/);
});

test('every badge in the real README has a configured download source', () => {
  const labels = badgeLabels(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  assert.deepEqual([...labels].sort(), Object.keys(SOURCES).sort());
});

test('counts come from GitHub release assets, ProGet totalDownloads via shields.io, and the badges branch', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, auth: options.headers.Authorization });
    let body;
    if (url.includes('/contents/')) {
      body = { schemaVersion: 1, label: 'Microsoft Store downloads', message: '31', color: 'blue' };
    } else if (url.startsWith('https://api.github.com/')) {
      body = url.endsWith('page=1')
        ? [{ assets: [{ download_count: 10 }, { download_count: 2 }] }, { assets: [] }]
        : [];
    } else if (url.includes(encodeURIComponent('/stepforge-rpm/'))) {
      body = { label: 'downloads', message: 'no result', value: 'no result' };
    } else {
      body = { label: 'downloads', message: '18', value: '18' };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  const counts = await fetchCounts(Object.keys(SOURCES), { fetchImpl, token: 't0k' });
  assert.deepEqual(counts, {
    'GitHub downloads': 12,
    'APT downloads': 18,
    'DNF downloads': 0,
    'Chocolatey downloads': 18,
    'Microsoft Store downloads': 31,
  });
  assert.ok(requested.some((r) => r.url.includes('/repos/Twest2/StepForge/releases') && r.auth === 'Bearer t0k'));
  const choco = requested.find((r) => r.url.includes(encodeURIComponent('/stepforge-choco/')));
  assert.ok(choco.url.startsWith('https://img.shields.io/badge/dynamic/json.json?url='));
  assert.equal(
    new URL(choco.url).searchParams.get('url'),
    'https://packages.twestbrook.com/api/packages/stepforge-choco/versions?name=stepforge',
  );
  assert.equal(new URL(choco.url).searchParams.get('query'), '$[0].totalDownloads');
});

test('the configured ProGet host is queried directly without credentials', async () => {
  const requested = [];
  const fetchImpl = async (url, { headers }) => {
    requested.push(url);
    assert.equal(headers.Authorization, undefined);
    return Response.json([{ downloads: 3, totalDownloads: 80 }, { downloads: 7, totalDownloads: 80 }]);
  };
  assert.deepEqual(await fetchCounts(['Chocolatey downloads'], {
    fetchImpl, token: 't0k', progetBase: 'https://proget.example/',
  }), {
    'Chocolatey downloads': 80,
  });
  assert.deepEqual(requested, ['https://proget.example/api/packages/stepforge-choco/versions?name=stepforge']);
});

test('a blocked direct lookup falls back to Shields.io with the public ProGet URL', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return url.startsWith('https://proget.example/')
      ? new Response(null, { status: 403 })
      : Response.json({ value: '80' });
  };
  assert.deepEqual(await fetchCounts(['Chocolatey downloads'], {
    fetchImpl, progetBase: 'https://proget.example',
  }), { 'Chocolatey downloads': 80 });
  assert.equal(requested.length, 2);
  assert.equal(new URL(requested[1]).searchParams.get('url'), 'https://packages.twestbrook.com/api/packages/stepforge-choco/versions?name=stepforge');
});

test('an unreadable ProGet feed reports both failures instead of counting as zero', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: 'resource not found', value: 'resource not found' }),
  });
  await assert.rejects(fetchCounts(['APT downloads'], { fetchImpl }), /Shields.io: resource not found.*Direct: missing or invalid totalDownloads/);
});

test('a failed GitHub request aborts the sort', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchCounts(['GitHub downloads'], { fetchImpl }), /HTTP 503/);
});

test('the workflow warns and preserves the README when neither ProGet lookup works', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-badges-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const readmePath = path.join(dir, 'README.md');
  fs.writeFileSync(readmePath, README);
  const mockFetch = `globalThis.fetch = async (url) => {
    if (url.startsWith('https://api.github.com/')) return Response.json([]);
    if (url.startsWith('https://img.shields.io/')) {
      const feed = new URL(url).searchParams.get('url');
      return Response.json({ value: feed.includes('/stepforge/') ? 'inaccessible' : '100' });
    }
    return new Response(null, { status: 403 });
  };`;
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`,
    path.join(ROOT, 'scripts/sort-download-badges.js'), readmePath,
  ], {
    env: { ...process.env, GITHUB_ACTIONS: 'true', PROGET_BADGE_BASE_URL: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stdout, /::warning::Could not read ProGet feed stepforge .*Shields.io: inaccessible.*HTTP 403.*Skipping badge sort/);
  assert.equal(fs.readFileSync(readmePath, 'utf8'), README);
});

test('the Microsoft Store count is read from the badges branch through the contents API', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, headers: options.headers });
    return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, label: 'Microsoft Store downloads', message: '31', color: 'blue' }) };
  };
  assert.deepEqual(await fetchCounts(['Microsoft Store downloads'], { fetchImpl, token: 't0k' }), { 'Microsoft Store downloads': 31 });
  assert.equal(requested[0].url, 'https://api.github.com/repos/Twest2/StepForge/contents/microsoft-store-downloads.json?ref=badges');
  assert.equal(requested[0].headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(requested[0].headers.Authorization, 'Bearer t0k');

  // A missing branch or an unreadable file aborts instead of counting as zero.
  await assert.rejects(fetchCounts(['Microsoft Store downloads'], { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), /HTTP 404/);
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ message: '' }) });
  await assert.rejects(fetchCounts(['Microsoft Store downloads'], { fetchImpl: empty }), /has no count/);
});
