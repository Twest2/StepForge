'use strict';

// Keeps the README's download badges ordered from most to fewest downloads.
// The badges render live counts on their own; only their order is static, so
// the scheduled sort-download-badges workflow runs this and commits the README
// when the order changes.

const fs = require('node:fs');
const path = require('node:path');

const { BADGE_BRANCH, BADGE_FILE } = require('./microsoft-store-downloads');

const START_MARKER = '<!-- download-badges:start';
const END_MARKER = '<!-- download-badges:end -->';
const GITHUB_REPO = 'Twest2/StepForge';
const PROGET_BASE = 'https://packages.twestbrook.com';
const SHIELDS_JSON = 'https://img.shields.io/badge/dynamic/json.json';

// Each badge is identified by its img alt text.
const SOURCES = {
  'GitHub downloads': { kind: 'github', repo: GITHUB_REPO },
  'APT downloads': { kind: 'proget', feed: 'stepforge' },
  'DNF downloads': { kind: 'proget', feed: 'stepforge-rpm' },
  'Chocolatey downloads': { kind: 'proget', feed: 'stepforge-choco' },
  'Microsoft Store downloads': { kind: 'badge-branch', repo: GITHUB_REPO, branch: BADGE_BRANCH, file: BADGE_FILE },
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
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(10_000),
  });
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

class ProGetUnavailableError extends Error {}

async function shieldsDownloads(fetchImpl, publicUrl) {
  const shieldsUrl = `${SHIELDS_JSON}?url=${encodeURIComponent(publicUrl)}&query=${encodeURIComponent('$[0].totalDownloads')}&label=downloads`;
  const badge = await getJson(fetchImpl, shieldsUrl);
  const value = String(badge.value ?? badge.message ?? '');
  if (/^\d+$/.test(value)) return Number(value);
  // An empty feed has no $[0] to query.
  if (/^no result$/i.test(value)) return 0;
  throw new Error(value || 'empty response');
}

async function directProgetDownloads(fetchImpl, url) {
  const versions = await getJson(fetchImpl, url);
  if (Array.isArray(versions)) {
    if (versions.length === 0) return 0;
    // Each version contains the same package-wide totalDownloads.
    const total = versions[0]?.totalDownloads;
    if (Number.isSafeInteger(total) && total >= 0) return total;
  }
  throw new Error('missing or invalid totalDownloads');
}

async function progetDownloads(fetchImpl, feed, directBase) {
  const versionsPath = `/api/packages/${encodeURIComponent(feed)}/versions?name=stepforge`;
  const directUrl = `${(directBase || PROGET_BASE).replace(/\/+$/, '')}${versionsPath}`;
  const publicUrl = `${PROGET_BASE}${versionsPath}`;
  const direct = ['Direct', () => directProgetDownloads(fetchImpl, directUrl)];
  const shields = ['Shields.io', () => shieldsDownloads(fetchImpl, publicUrl)];
  // GitHub Actions has a ProGet host that can serve counts directly. For local
  // runs, use the same public Shields.io lookup as the README badge first.
  const sources = directBase ? [direct, shields] : [shields, direct];
  const failures = [];
  for (const [name, read] of sources) {
    try {
      return await read();
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  throw new ProGetUnavailableError(`Could not read ProGet feed ${feed} (${failures.join('. ')}).`);
}

// Partner Center has no public count, so the workflow's first job writes it
// to the badges branch. Read it through the contents API, which, unlike
// raw.githubusercontent.com, isn't cached for minutes after that push.
async function badgeBranchDownloads(fetchImpl, { repo, branch, file }, token) {
  const headers = { Accept: 'application/vnd.github.raw+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const badge = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/contents/${file}?ref=${branch}`, headers);
  const value = String(badge.message ?? '');
  if (/^\d+$/.test(value)) return Number(value);
  throw new Error(`${file} on the ${branch} branch has no count: ${value || 'empty message'}`);
}

async function fetchCounts(labels, { fetchImpl = fetch, token, progetBase } = {}) {
  const counts = {};
  for (const label of labels) {
    const source = SOURCES[label];
    if (!source) throw new Error(`No download source configured for badge "${label}"`);
    if (source.kind === 'github') counts[label] = await githubDownloads(fetchImpl, source.repo, token);
    else if (source.kind === 'badge-branch') counts[label] = await badgeBranchDownloads(fetchImpl, source, token);
    else counts[label] = await progetDownloads(fetchImpl, source.feed, progetBase);
  }
  return counts;
}

async function main() {
  const readmePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'README.md'));
  const readme = fs.readFileSync(readmePath, 'utf8');
  const counts = await fetchCounts(badgeLabels(readme), {
    token: process.env.GITHUB_TOKEN,
    progetBase: process.env.PROGET_BADGE_BASE_URL,
  });
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
    if (error instanceof ProGetUnavailableError && process.env.GITHUB_ACTIONS === 'true') {
      const message = error.message.replace(/[\r\n]+/g, ' ');
      console.log(`::warning::${message} Skipping badge sort until all counts are available.`);
      return;
    }
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { SOURCES, badgeLabels, sortBadges, fetchCounts };
