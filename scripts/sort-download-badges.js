'use strict';

// Keeps the README's download badges ordered from most to fewest downloads.
// The badges render live counts on their own; only their order is static, so
// the scheduled sort-download-badges workflow runs this and commits the README
// when the order changes.

const fs = require('node:fs');
const path = require('node:path');

const START_MARKER = '<!-- download-badges:start';
const END_MARKER = '<!-- download-badges:end -->';
const GITHUB_REPO = 'Twest2/StepForge';
const PROGET_BASE = 'https://packages.twestbrook.com';

// Each badge is identified by its img alt text.
const SOURCES = {
  'GitHub downloads': { kind: 'github', repo: GITHUB_REPO },
  'APT downloads': { kind: 'proget', feed: 'stepforge' },
  'DNF downloads': { kind: 'proget', feed: 'stepforge-rpm' },
  'Chocolatey downloads': { kind: 'proget', feed: 'stepforge-choco' },
};

function badgeLabel(line) {
  const match = /<img\b[^>]*\balt="([^"]+)"/.exec(line);
  return match ? match[1] : null;
}

// Returns the badge block's line range and the badge lines inside it.
function findBadgeBlock(lines) {
  const start = lines.findIndex((line) => line.startsWith(START_MARKER));
  const end = lines.findIndex((line) => line.startsWith(END_MARKER));
  if (start === -1 || end === -1 || end < start) {
    throw new Error('README is missing the download-badges start/end markers');
  }
  const badges = [];
  for (let i = start + 1; i < end; i += 1) {
    const label = badgeLabel(lines[i]);
    if (label) badges.push({ index: i, label, line: lines[i] });
  }
  if (badges.length === 0) throw new Error('No badges found between the download-badges markers');
  return { start, end, badges };
}

function badgeLabels(readme) {
  return findBadgeBlock(readme.split(/\r?\n/)).badges.map((badge) => badge.label);
}

// Reorders the badge lines by count, highest first. Ties keep their current
// order so equal counts never cause churn.
function sortBadges(readme, counts) {
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  const lines = readme.split(/\r?\n/);
  const { badges } = findBadgeBlock(lines);
  for (const badge of badges) {
    if (!Number.isFinite(counts[badge.label])) {
      throw new Error(`No download count for badge "${badge.label}"`);
    }
  }
  const sorted = badges
    .map((badge, order) => ({ ...badge, order }))
    .sort((a, b) => counts[b.label] - counts[a.label] || a.order - b.order);
  badges.forEach((badge, i) => {
    lines[badge.index] = sorted[i].line;
  });
  return lines.join(eol);
}

async function getJson(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers } });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response.json();
}

// Sum of download_count over every asset of every release.
async function githubDownloads(fetchImpl, repo, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let total = 0;
  for (let page = 1; ; page += 1) {
    const releases = await getJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      headers,
    );
    for (const release of releases) {
      for (const asset of release.assets || []) total += asset.download_count || 0;
    }
    if (releases.length < 100) return total;
  }
}

// ProGet repeats the package-wide totalDownloads on every version entry.
async function progetDownloads(fetchImpl, feed) {
  const versions = await getJson(
    fetchImpl,
    `${PROGET_BASE}/api/packages/${encodeURIComponent(feed)}/versions?name=stepforge`,
  );
  if (!Array.isArray(versions)) throw new Error(`Unexpected ProGet response for feed ${feed}`);
  if (versions.length === 0) return 0;
  const total = versions[0].totalDownloads;
  if (!Number.isFinite(total)) throw new Error(`ProGet feed ${feed} returned no totalDownloads`);
  return total;
}

async function fetchCounts(labels, { fetchImpl = fetch, token } = {}) {
  const counts = {};
  for (const label of labels) {
    const source = SOURCES[label];
    if (!source) throw new Error(`No download source configured for badge "${label}"`);
    counts[label] = source.kind === 'github'
      ? await githubDownloads(fetchImpl, source.repo, token)
      : await progetDownloads(fetchImpl, source.feed);
  }
  return counts;
}

async function main() {
  const readmePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'README.md'));
  const readme = fs.readFileSync(readmePath, 'utf8');
  const counts = await fetchCounts(badgeLabels(readme), { token: process.env.GITHUB_TOKEN });
  for (const [label, count] of Object.entries(counts)) console.log(`${label}: ${count}`);
  const sorted = sortBadges(readme, counts);
  if (sorted === readme) {
    console.log('Download badges are already in order.');
    return;
  }
  fs.writeFileSync(readmePath, sorted);
  console.log('Reordered the download badges.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { SOURCES, badgeLabels, sortBadges, fetchCounts };
