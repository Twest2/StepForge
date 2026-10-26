'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const review = require('../../core/review');
const { createGuide, normalizeGuide } = require('../../core/schema');
const { GuideStore } = require('../../core/store');
const { DEFAULT_SETTINGS } = require('../../core/settings');
const { buildRenderAst } = require('../../core/renderast');
const { guideMetaLines } = require('../../exporters/document-layout');
const { exportMarkdown } = require('../../exporters/markdown');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

const DAY = review.DAY_MS;
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const at = (y, m, d) => new Date(y, m - 1, d).getTime();
const guideWith = (updatedAt, metadata = {}) => ({ updatedAt: new Date(updatedAt).toISOString(), metadata });

test('review: the default interval is 6 months, and Settings starts there', () => {
  assert.equal(review.DEFAULT_REVIEW_DAYS, 180);
  assert.equal(DEFAULT_SETTINGS.library.reviewAfterDays, 180);
});

test('review: a guide is flagged once the interval has passed since its last save', () => {
  const saved = at(2026, 1, 10);
  const guide = guideWith(saved);
  const before = review.reviewStatus(guide, 30, saved + 29 * DAY);
  assert.equal(before.overdue, false);
  assert.equal(before.sinceKind, 'saved');
  assert.equal(before.dueDate, '2026-02-09');
  assert.equal(review.reviewStatus(guide, 30, saved + 30 * DAY).overdue, true);
});

test('review: saving or marking verified restarts the clock, whichever is later', () => {
  const now = at(2026, 10, 25);
  // Saved long ago, verified recently: the verification counts.
  const verified = review.reviewStatus(guideWith(at(2025, 1, 1), { lastVerified: '2026-10-01' }), 180, now);
  assert.equal(verified.overdue, false);
  assert.equal(verified.sinceKind, 'verified');
  assert.equal(verified.since, at(2026, 10, 1));
  // Verified long ago, saved recently: the save counts.
  const saved = review.reviewStatus(guideWith(at(2026, 10, 20), { lastVerified: '2024-01-01' }), 180, now);
  assert.equal(saved.overdue, false);
  assert.equal(saved.sinceKind, 'saved');
  // Both old: flagged.
  assert.equal(review.reviewStatus(guideWith(at(2025, 1, 1), { lastVerified: '2025-02-01' }), 180, now).overdue, true);
});

test('review: a guide’s own interval overrides the default, and 0 turns reviews off', () => {
  const now = at(2026, 10, 25);
  const saved = now - 40 * DAY;
  assert.equal(review.reviewStatus(guideWith(saved), 180, now).overdue, false);
  const own = review.reviewStatus(guideWith(saved, { reviewAfterDays: 30 }), 180, now);
  assert.equal(own.overdue, true);
  assert.equal(own.fromGuide, true);
  assert.equal(own.days, 30);
  // Never for this guide, even with a default.
  assert.equal(review.reviewStatus(guideWith(saved - 1000 * DAY, { reviewAfterDays: 0 }), 30, now), null);
  // Off by default, but this guide still asks for a review.
  assert.equal(review.reviewStatus(guideWith(saved), 0, now), null);
  assert.equal(review.reviewStatus(guideWith(saved, { reviewAfterDays: 30 }), 0, now).overdue, true);
  // A missing default falls back to 6 months.
  assert.equal(review.reviewStatus(guideWith(saved), undefined, now).days, 180);
});

test('review: dates and intervals are normalized', () => {
  assert.equal(review.normalizeDateOnly('2026-02-28'), '2026-02-28');
  assert.equal(review.normalizeDateOnly('2026-02-30'), '');
  assert.equal(review.normalizeDateOnly('2026-10-25T13:00:00Z'), '2026-10-25');
  assert.equal(review.normalizeDateOnly('yesterday'), '');
  assert.equal(review.normalizeDateOnly(42), '');
  assert.equal(review.normalizeReviewDays(''), null);
  assert.equal(review.normalizeReviewDays(null), null);
  assert.equal(review.normalizeReviewDays('90'), 90);
  assert.equal(review.normalizeReviewDays(0), 0);
  assert.equal(review.normalizeReviewDays(-5), null);
  assert.equal(review.normalizeReviewDays(1.5), null);
  assert.equal(review.normalizeReviewDays(10 ** 9), 3650);
  assert.equal(review.intervalLabel(365), '1 year');
  assert.equal(review.intervalLabel(45), '45 days');
  assert.equal(review.reviewStatus({ updatedAt: 'garbage', metadata: {} }, 30), null);
});

test('schema: review fields default empty and bad values are dropped', () => {
  const fresh = createGuide({ title: 'x' });
  assert.equal(fresh.metadata.lastVerified, '');
  assert.equal(fresh.metadata.softwareVersion, '');
  assert.equal(fresh.metadata.reviewAfterDays, null);
  const bad = normalizeGuide({
    guideId: 'guide_1',
    metadata: { author: 'A', lastVerified: 'soon', softwareVersion: 7, reviewAfterDays: 'often' },
  });
  assert.equal(bad.metadata.author, 'A');
  assert.equal(bad.metadata.lastVerified, '');
  assert.equal(bad.metadata.softwareVersion, '');
  assert.equal(bad.metadata.reviewAfterDays, null);
  const good = normalizeGuide({
    guideId: 'guide_1',
    metadata: { lastVerified: '2026-10-01', softwareVersion: 'v'.repeat(500), reviewAfterDays: 90 },
  });
  assert.equal(good.metadata.lastVerified, '2026-10-01');
  assert.equal(good.metadata.softwareVersion.length, 200);
  assert.equal(good.metadata.reviewAfterDays, 90);
});

test('store: Mark as verified records today without counting as an edit', (t) => {
  const root = makeTmpDir('review-store');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Old guide' });
  guide.metadata = { ...guide.metadata, author: 'Casey' };
  guide.updatedAt = '2024-01-01T00:00:00Z';
  store.saveGuide(guide, { touch: false });
  assert.equal(review.reviewStatus(store.getGuide(guide.guideId), 180).overdue, true);

  const now = at(2026, 10, 25) + 15 * 60 * 60 * 1000;
  store.markVerified(guide.guideId, now);
  const after = store.getGuide(guide.guideId);
  assert.equal(after.metadata.lastVerified, '2026-10-25');
  assert.equal(after.metadata.author, 'Casey');
  assert.equal(after.updatedAt, '2024-01-01T00:00:00Z');
  assert.equal(review.reviewStatus(after, 180, now).overdue, false);
});

test('exports: verification lines appear when set, with Review again on only for verified guides', (t) => {
  const root = makeTmpDir('review-export');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));

  // Nobody has verified it: no review lines, even though the default is on.
  const plain = buildRenderAst(store, guide.guideId);
  assert.equal(plain.guide.metadata.reviewAgainOn, '');
  assert.deepEqual(guideMetaLines(plain).filter((l) => /verified|Review|Software/.test(l)), []);

  const g = store.getGuide(guide.guideId);
  g.metadata = { ...g.metadata, softwareVersion: 'AcmeSync [[Version]]', lastVerified: '2026-10-01' };
  g.placeholders = { ...g.placeholders, Version: '4.2' };
  store.saveGuide(g);
  const saved = store.getGuide(guide.guideId).updatedAt;
  const ast = buildRenderAst(store, guide.guideId, { reviewDays: 90 });
  const due = review.toDateOnly(Date.parse(saved) + 90 * DAY);
  assert.deepEqual(guideMetaLines(ast).slice(-3), [
    'Software version: AcmeSync 4.2',
    'Last verified: 2026-10-01',
    `Review again on: ${due}`,
  ]);

  // Turned off for this guide: the verification date stays, the review date goes.
  g.metadata = { ...store.getGuide(guide.guideId).metadata, reviewAfterDays: 0 };
  store.saveGuide(g);
  const off = buildRenderAst(store, guide.guideId, { reviewDays: 90 });
  assert.equal(off.guide.metadata.reviewAgainOn, '');
  assert.ok(guideMetaLines(off).includes('Last verified: 2026-10-01'));

  const md = fs.readFileSync(exportMarkdown(ast, path.join(root, 'md')).file, 'utf8');
  assert.match(md, /Software version: AcmeSync 4\.2 · Last verified: 2026-10-01 · Review again on: \d{4}-\d{2}-\d{2}/);
});

test('exports: the PDF cover and every export path use the shared lines and the Settings default', () => {
  assert.match(read('exporters/pdf.js'), /const metaLines = guideMetaLines\(ast\);/);
  const main = read('app/main.js');
  assert.equal((main.match(/codeStyle: exportCodeStyle\(\)(?!, reviewDays: exportReviewDays\(\))/g) || []).length, 0);
  assert.match(main, /format: 'wikijs',[\s\S]{0,300}reviewDays: exportReviewDays\(\)/);
  assert.match(read('core/export-worker.js'), /buildRenderAst\(store, guideId, \{[^}]*reviewDays/);
  assert.match(read('app/export-runner.js'), /worker\.send\(\{[^}]*reviewDays/);
});

test('library: review.js loads before the renderer scripts that use it', () => {
  const html = read('app/renderer/index.html');
  const pos = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(pos('../../core/review.js') > 0);
  assert.ok(pos('../../core/review.js') < pos('dialogs.js'));
  assert.ok(pos('../../core/review.js') < pos('app.js'));
});

test('library: the "May need review" pill shows only when overdue, just left of the date', () => {
  const app = read('app/renderer/app.js');
  const footer = app.slice(app.indexOf("el('div.card-footer', {},\n      el('span', {}, `${steps} step"));
  const badge = footer.indexOf("reviewState?.overdue ? el('span.badge.review-badge'");
  const date = footer.indexOf("el('span.card-updated'");
  assert.ok(badge > 0 && badge < date, 'the badge comes right before the date');
  assert.doesNotMatch(footer.slice(badge, date), /el\('span(?!\.badge\.review-badge)/);
  assert.match(app, /review\.reviewStatus\(guide, this\.state\.settings\?\.library\?\.reviewAfterDays\)/);
  const css = read('app/renderer/style.css');
  assert.match(css, /\.guide-card \.review-badge \{ margin-left: auto;/);
  assert.match(css, /\.guide-card \.review-badge \+ \.card-updated \{ margin-left: 0; \}/);
});
