'use strict';

const crypto = require('node:crypto');

/*
 * Layout and rules for a guide-sharing site hosted on GitHub Pages in the
 * user's own repository. Everything here is pure: the network side lives in
 * app/github-pages.js.
 *
 * The Pages branch holds only what StepForge generates and is always a single
 * commit, so a removed guide leaves no copy in the branch history:
 *
 *   index.html               placeholder page; never lists guides
 *   _stepforge.json          manifest of published guides (Jekyll skips files
 *                            starting with "_", so it is never served)
 *   g/<slug>/index.html      one self-contained guide per random slug
 *
 * The default branch holds a README and a scheduled workflow that removes
 * expired guides while StepForge is closed.
 */

const PAGES_BRANCH = 'gh-pages';
const MANIFEST_PATH = '_stepforge.json';
const ROOT_INDEX_PATH = 'index.html';
const WORKFLOW_PATH = '.github/workflows/stepforge-expire.yml';
const README_PATH = 'README.md';
// Written by GitHub when the user sets a custom domain; carried over on rewrites.
const CNAME_PATH = 'CNAME';
const WORKFLOW_MARKER = 'stepforge-expire v1';
const EXPIRY_DAYS = Object.freeze([1, 7, 30]);
const DEFAULT_EXPIRY_DAYS = 7;
// GitHub rejects files over 100 MB and warns above 50 MB.
const MAX_GUIDE_BYTES = 50 * 1024 * 1024;
const SLUG_PATTERN = /^[a-f0-9]{24}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function newSlug() {
  return crypto.randomBytes(12).toString('hex');
}

function isSlug(value) {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

function guidePath(slug) {
  return `g/${slug}/index.html`;
}

function emptyManifest() {
  return { version: 1, guides: {} };
}

function validDate(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * Parse the manifest read back from the repository. It is remote content, so
 * unknown or malformed entries are dropped rather than trusted; a guide that
 * is not in the manifest is not kept on the next rewrite.
 */
function parseManifest(text) {
  let raw;
  try { raw = JSON.parse(String(text)); } catch { return emptyManifest(); }
  const manifest = emptyManifest();
  const guides = raw && typeof raw === 'object' && raw.guides && typeof raw.guides === 'object' ? raw.guides : {};
  for (const [slug, entry] of Object.entries(guides)) {
    if (!isSlug(slug) || !entry || typeof entry !== 'object') continue;
    if (typeof entry.guideId !== 'string' || !entry.guideId || entry.guideId.length > 200) continue;
    if (!validDate(entry.publishedAt) || !validDate(entry.expiresAt)) continue;
    manifest.guides[slug] = {
      guideId: entry.guideId,
      title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : '',
      publishedAt: entry.publishedAt,
      expiresAt: entry.expiresAt,
    };
  }
  return manifest;
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function expiresAtFor(days, now = Date.now()) {
  if (!EXPIRY_DAYS.includes(days)) throw new Error(`Choose how long the guide stays online: ${EXPIRY_DAYS.join(', ')} days.`);
  return new Date(now + days * DAY_MS).toISOString();
}

function isExpired(entry, now = Date.now()) {
  return !(Date.parse(entry.expiresAt) > now);
}

function slugForGuide(manifest, guideId) {
  return Object.keys(manifest.guides).find((slug) => manifest.guides[slug].guideId === guideId) || null;
}

/**
 * Work out the next manifest. Expired guides are always dropped. `publish`
 * adds or refreshes one guide (keeping its existing link); `remove` drops one
 * slug. Returns the new manifest plus the slugs that were removed.
 */
function planSite(manifest, { now = Date.now(), publish = null, remove = null } = {}) {
  const next = emptyManifest();
  const removed = [];
  for (const [slug, entry] of Object.entries(manifest.guides)) {
    if (slug === remove || isExpired(entry, now)) removed.push(slug);
    else next.guides[slug] = { ...entry };
  }
  let slug = null;
  if (publish) {
    slug = slugForGuide(next, publish.guideId) || publish.slug || newSlug();
    if (!isSlug(slug)) throw new Error('Invalid link id for the published guide.');
    next.guides[slug] = {
      guideId: publish.guideId,
      title: String(publish.title || '').slice(0, 300),
      publishedAt: new Date(now).toISOString(),
      expiresAt: expiresAtFor(publish.days, now),
    };
  }
  return { manifest: next, removed, slug };
}

const ROBOTS_META = '<meta name="robots" content="noindex, nofollow, noarchive">';
const REFERRER_META = '<meta name="referrer" content="no-referrer">';
const PROJECT_URL = 'https://github.com/Twest2/StepForge';
const FOOTER_CREDIT = '<footer class="doc-footer">Made with StepForge';
const FOOTER_LINK = ` · <a href="${PROJECT_URL}" rel="noopener noreferrer">GitHub</a>`;

/**
 * Prepare an exported HTML guide for the public site: ask search engines not
 * to index or archive it, keep the unlisted URL out of Referer headers, and
 * link the "Made with StepForge" footer to the project. Local exports keep no
 * external links; only the published copy gets one.
 */
function prepareGuideHtml(html) {
  const text = String(html);
  const match = /<head[^>]*>/i.exec(text);
  if (!match) throw new Error('The exported guide has no <head> element.');
  const at = match.index + match[0].length;
  const withMeta = `${text.slice(0, at)}\n${ROBOTS_META}\n${REFERRER_META}${text.slice(at)}`;
  const credit = withMeta.lastIndexOf(FOOTER_CREDIT);
  if (credit < 0) return withMeta;
  const end = credit + FOOTER_CREDIT.length;
  return `${withMeta.slice(0, end)}${FOOTER_LINK}${withMeta.slice(end)}`;
}

/** The page title of an exported guide, with placeholders already filled in. */
function titleFromHtml(html) {
  const match = /<title>([^<]*)<\/title>/i.exec(String(html));
  if (!match) return '';
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };
  return match[1].replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name) => entities[name]).trim();
}

const ROOT_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ROBOTS_META}
${REFERRER_META}
<title>Shared guides</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#374151}</style>
</head>
<body>
<h1>Shared guides</h1>
<p>Guides on this site are shared by direct link only. Ask the person who shared a guide for its link.</p>
</body>
</html>
`;

/** Base URL of the Pages site, always ending in "/". */
function siteBaseUrl({ owner, repo, htmlUrl = '' }) {
  if (htmlUrl) {
    try {
      const url = new URL(htmlUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        url.protocol = 'https:';
        return url.href.endsWith('/') ? url.href : `${url.href}/`;
      }
    } catch { /* fall back to the default github.io address */ }
  }
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

function guideUrl(baseUrl, slug) {
  return `${baseUrl}g/${slug}/`;
}

const README = `# Shared StepForge guides

This repository hosts guides shared from [StepForge](https://github.com/Twest2/StepForge)
on GitHub Pages.

**Everything published here is public.** Anyone with a guide's link can open
it, and anyone can browse the \`${PAGES_BRANCH}\` branch of a public repository.

- StepForge replaces the \`${PAGES_BRANCH}\` branch with a single commit every
  time it publishes or removes a guide, so removed guides do not stay in the
  branch history. Don't keep other files on that branch.
- \`${WORKFLOW_PATH}\` removes guides after they expire, even
  when StepForge is closed. You can also run it by hand from the **Actions** tab.
- To stop sharing everything, remove the guides in StepForge, or delete this
  repository.
`;

// The expiry script run by the workflow. It mirrors planSite(): anything that
// is expired or unreadable is removed.
const EXPIRE_SCRIPT = `const fs = require('node:fs');
let manifest = { version: 1, guides: {} };
try { manifest = JSON.parse(fs.readFileSync('${MANIFEST_PATH}', 'utf8')); } catch {}
const guides = manifest && typeof manifest.guides === 'object' && manifest.guides ? manifest.guides : {};
const now = Date.now();
let removed = 0;
for (const [slug, entry] of Object.entries(guides)) {
  if (!/^[a-f0-9]{24}$/.test(slug)) continue;
  if (!(entry && Date.parse(entry.expiresAt) > now)) {
    fs.rmSync('g/' + slug, { recursive: true, force: true });
    delete guides[slug];
    removed += 1;
  }
}
fs.writeFileSync('${MANIFEST_PATH}', JSON.stringify({ version: 1, guides }, null, 2) + '\\n');
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'removed=' + removed + '\\n');
console.log('Removed ' + removed + ' expired guide(s).');`;

const indent = (text, spaces) => text.split('\n').map((line) => (line ? ' '.repeat(spaces) + line : line)).join('\n');

const WORKFLOW = `# Managed by StepForge (${WORKFLOW_MARKER}). StepForge may replace this file.
# Removes shared guides from GitHub Pages after they expire.
name: Remove expired StepForge guides

on:
  schedule:
    - cron: '23 */6 * * *'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: stepforge-pages
  cancel-in-progress: false

jobs:
  expire:
    runs-on: ubuntu-latest
    steps:
      - name: Look for published guides
        id: site
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          if gh api "repos/$GITHUB_REPOSITORY/branches/${PAGES_BRANCH}" --silent 2>/dev/null; then
            echo "published=true" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/checkout@v5
        if: steps.site.outputs.published == 'true'
        with:
          ref: ${PAGES_BRANCH}
          fetch-depth: 1

      - name: Remove expired guides
        id: expire
        if: steps.site.outputs.published == 'true'
        run: |
          node - <<'STEPFORGE'
${indent(EXPIRE_SCRIPT, 10)}
          STEPFORGE

      - name: Publish the site as a single commit
        if: steps.expire.outputs.removed != '' && steps.expire.outputs.removed != '0'
        run: |
          previous="$(git rev-parse HEAD)"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout --quiet --orphan stepforge-next
          git add --all
          git commit --quiet -m "Remove expired StepForge guides"
          git push --force-with-lease="${PAGES_BRANCH}:$previous" origin HEAD:${PAGES_BRANCH}
`;

module.exports = {
  PAGES_BRANCH,
  MANIFEST_PATH,
  ROOT_INDEX_PATH,
  WORKFLOW_PATH,
  README_PATH,
  CNAME_PATH,
  WORKFLOW_MARKER,
  EXPIRY_DAYS,
  DEFAULT_EXPIRY_DAYS,
  MAX_GUIDE_BYTES,
  ROOT_INDEX,
  README,
  WORKFLOW,
  EXPIRE_SCRIPT,
  newSlug,
  isSlug,
  guidePath,
  emptyManifest,
  parseManifest,
  serializeManifest,
  expiresAtFor,
  isExpired,
  slugForGuide,
  planSite,
  prepareGuideHtml,
  PROJECT_URL,
  titleFromHtml,
  siteBaseUrl,
  guideUrl,
};
