'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const site = require('../../core/pages-site');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('publishing a new guide gives it a random unlisted slug and the chosen expiry', () => {
  const plan = site.planSite(site.emptyManifest(), { now: NOW, publish: { guideId: 'guide-a', title: 'Reset a password', days: 7 } });
  assert.ok(site.isSlug(plan.slug));
  assert.deepEqual(plan.manifest.guides[plan.slug], {
    guideId: 'guide-a',
    title: 'Reset a password',
    publishedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 7 * DAY).toISOString(),
  });
  const other = site.planSite(site.emptyManifest(), { now: NOW, publish: { guideId: 'guide-a', title: 'x', days: 1 } });
  assert.notEqual(other.slug, plan.slug, 'slugs must not be predictable');
});

test('republishing a guide keeps its link and restarts its expiry', () => {
  const first = site.planSite(site.emptyManifest(), { now: NOW, publish: { guideId: 'guide-a', title: 'Old title', days: 1 } });
  const later = NOW + 12 * 60 * 60 * 1000;
  const second = site.planSite(first.manifest, { now: later, publish: { guideId: 'guide-a', title: 'New title', days: 30 } });
  assert.equal(second.slug, first.slug);
  assert.equal(Object.keys(second.manifest.guides).length, 1);
  assert.equal(second.manifest.guides[first.slug].title, 'New title');
  assert.equal(second.manifest.guides[first.slug].expiresAt, new Date(later + 30 * DAY).toISOString());
});

test('expired and removed guides are dropped; others are kept', () => {
  let manifest = site.emptyManifest();
  const soon = site.planSite(manifest, { now: NOW, publish: { guideId: 'soon', title: 'Soon', days: 1 } });
  const later = site.planSite(soon.manifest, { now: NOW, publish: { guideId: 'later', title: 'Later', days: 30 } });
  const removeMe = site.planSite(later.manifest, { now: NOW, publish: { guideId: 'remove', title: 'Remove', days: 7 } });
  manifest = removeMe.manifest;

  const plan = site.planSite(manifest, { now: NOW + 2 * DAY, remove: removeMe.slug });
  assert.deepEqual(plan.removed.sort(), [soon.slug, removeMe.slug].sort());
  assert.deepEqual(Object.keys(plan.manifest.guides), [later.slug]);
});

test('only 1, 7, or 30 days can be chosen', () => {
  for (const days of [0, 2, 31, 365, '7', null]) {
    assert.throws(() => site.planSite(site.emptyManifest(), { now: NOW, publish: { guideId: 'g', title: 't', days } }), /1, 7, 30 days/);
  }
});

test('a manifest read back from GitHub is sanitized, not trusted', () => {
  const good = { guideId: 'g1', title: 'Fine', publishedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-08T00:00:00.000Z' };
  const parsed = site.parseManifest(JSON.stringify({
    version: 1,
    guides: {
      aaaaaaaaaaaaaaaaaaaaaaaa: good,
      '../../escape': good,
      bbbbbbbbbbbbbbbbbbbbbbbb: { ...good, expiresAt: 'whenever' },
      cccccccccccccccccccccccc: { ...good, guideId: 42 },
      dddddddddddddddddddddddd: { ...good, title: 'x'.repeat(1000), extra: '<script>' },
    },
  }));
  assert.deepEqual(Object.keys(parsed.guides).sort(), ['aaaaaaaaaaaaaaaaaaaaaaaa', 'dddddddddddddddddddddddd']);
  assert.equal(parsed.guides.dddddddddddddddddddddddd.title.length, 300);
  assert.equal(parsed.guides.dddddddddddddddddddddddd.extra, undefined);
  assert.deepEqual(site.parseManifest('not json'), site.emptyManifest());
  assert.deepEqual(site.parseManifest('null'), site.emptyManifest());
});

test('an exported interactive HTML guide is marked noindex and no-referrer for the public site', (t) => {
  const dir = makeTmpDir('pages-site');
  t.after(() => rmrf(dir));
  const { store, guide } = buildFixtureGuide(dir);
  const result = runExport('html-rich', buildRenderAst(store, guide.guideId), `${dir}/out`);
  const html = site.prepareGuideHtml(fs.readFileSync(result.file, 'utf8'));
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert.match(head, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(head, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<title>Configure AcmeSync backups<\/title>/);
  assert.equal(site.titleFromHtml(html), 'Configure AcmeSync backups', 'the shared-guide list shows the resolved title');
  assert.equal(site.titleFromHtml('<title>Q&amp;A: &lt;admin&gt; &quot;tips&quot;</title>'), 'Q&A: <admin> "tips"');
  assert.equal(site.titleFromHtml('<p>none</p>'), '');
  assert.match(html, /data:image\/png;base64,/, 'screenshots stay embedded so the page is one file');
  assert.throws(() => site.prepareGuideHtml('<p>no head</p>'), /no <head>/);
});

test('a published guide links its footer to the StepForge repository; local exports do not', (t) => {
  const dir = makeTmpDir('pages-site');
  t.after(() => rmrf(dir));
  const { store, guide } = buildFixtureGuide(dir);
  const ast = buildRenderAst(store, guide.guideId);
  for (const format of ['html-simple', 'html-rich']) {
    const exported = fs.readFileSync(runExport(format, ast, `${dir}/${format}`).file, 'utf8');
    assert.doesNotMatch(exported, /github\.com/, `${format} exports stay free of external links`);
    const html = site.prepareGuideHtml(exported);
    const footer = html.slice(html.indexOf('<footer class="doc-footer">'), html.indexOf('</footer>'));
    assert.match(footer, /^<footer class="doc-footer">Made with StepForge · <a href="https:\/\/github\.com\/Twest2\/StepForge" rel="noopener noreferrer">GitHub<\/a> · \d{4}-\d{2}-\d{2}$/, format);
    assert.equal(html.split(site.PROJECT_URL).length, 2, `${format} gets exactly one link`);
  }
  assert.equal(site.prepareGuideHtml('<head></head><p>no footer</p>').includes(site.PROJECT_URL), false);
});

test('the root page and manifest never reveal published guide links', () => {
  const plan = site.planSite(site.emptyManifest(), { now: NOW, publish: { guideId: 'g', title: 'Secret steps', days: 7 } });
  assert.doesNotMatch(site.ROOT_INDEX, /g\//);
  assert.match(site.ROOT_INDEX, /noindex/);
  // Jekyll (GitHub Pages' default build) never serves files starting with "_".
  assert.ok(site.MANIFEST_PATH.startsWith('_'));
  assert.equal(site.guidePath(plan.slug), `g/${plan.slug}/index.html`);
});

test('site links follow GitHub Pages addresses', () => {
  assert.equal(site.siteBaseUrl({ owner: 'Octo', repo: 'stepforge-guides' }), 'https://octo.github.io/stepforge-guides/');
  assert.equal(site.siteBaseUrl({ owner: 'Octo', repo: 'octo.github.io' }), 'https://octo.github.io/');
  assert.equal(site.siteBaseUrl({ owner: 'o', repo: 'r', htmlUrl: 'http://guides.example.com' }), 'https://guides.example.com/');
  assert.equal(site.siteBaseUrl({ owner: 'o', repo: 'r', htmlUrl: 'javascript:alert(1)' }), 'https://o.github.io/r/');
  assert.equal(site.guideUrl('https://o.github.io/r/', 'a'.repeat(24)), `https://o.github.io/r/g/${'a'.repeat(24)}/`);
});

test('the clean-up workflow runs on a schedule and only rewrites the Pages branch', () => {
  assert.match(site.WORKFLOW, new RegExp(site.WORKFLOW_MARKER));
  assert.match(site.WORKFLOW, /schedule:\n\s+- cron: '23 \*\/6 \* \* \*'/);
  assert.match(site.WORKFLOW, /permissions:\n\s+contents: write\n/);
  assert.match(site.WORKFLOW, /git push --force-with-lease="gh-pages:\$previous" origin HEAD:gh-pages/);
});
