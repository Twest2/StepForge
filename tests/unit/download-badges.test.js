'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

test('counts come from GitHub release assets and ProGet totalDownloads', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, auth: options.headers.Authorization });
    let body;
    if (url.startsWith('https://api.github.com/')) {
      body = url.endsWith('page=1')
        ? [{ assets: [{ download_count: 10 }, { download_count: 2 }] }, { assets: [] }]
        : [];
    } else if (url.includes('/stepforge-rpm/')) {
      body = [];
    } else {
      body = [{ totalDownloads: 18, downloads: 1 }, { totalDownloads: 18, downloads: 17 }];
    }
    return { ok: true, status: 200, json: async () => body };
  };
  const counts = await fetchCounts(Object.keys(SOURCES), { fetchImpl, token: 't0k' });
  assert.deepEqual(counts, {
    'GitHub downloads': 12,
    'APT downloads': 18,
    'DNF downloads': 0,
    'Chocolatey downloads': 18,
  });
  assert.ok(requested.some((r) => r.url.includes('/repos/Twest2/StepForge/releases') && r.auth === 'Bearer t0k'));
  assert.ok(requested.some((r) => r.url === 'https://packages.twestbrook.com/api/packages/stepforge-choco/versions?name=stepforge'));
});

test('a failed request aborts the sort', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchCounts(['APT downloads'], { fetchImpl }), /HTTP 503/);
});
