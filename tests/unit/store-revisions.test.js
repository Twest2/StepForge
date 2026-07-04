'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GuideStore, RevisionConflictError } = require('../../core/store');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

// ---- revisions --------------------------------------------------------------

test('revisions start at 0 and increment on every save', (t) => {
  const root = makeTmpDir('store-rev');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);

  const guide = store.createGuide({ title: 'G' });
  assert.equal(guide.revision, 0);

  const step = store.addStep(guide.guideId, { title: 'S' }, TINY_PNG, { width: 1, height: 1 });
  const r0 = store.getStep(guide.guideId, step.stepId).revision;

  const saved1 = store.saveStep(guide.guideId, { ...step, title: 'S1' });
  assert.equal(saved1.revision, r0 + 1);
  const saved2 = store.saveStep(guide.guideId, { ...saved1, title: 'S2' });
  assert.equal(saved2.revision, r0 + 2);
});

test('compare-and-swap: a stale expectedRevision is rejected, not clobbered', (t) => {
  const root = makeTmpDir('store-cas');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });
  const step = store.addStep(guide.guideId, { title: 'S' }, TINY_PNG, { width: 1, height: 1 });

  const base = store.getStep(guide.guideId, step.stepId);
  // A user edit lands first (no expectedRevision -> last-write-wins).
  store.saveStep(guide.guideId, { ...base, title: 'user edit' });

  // A background writer that read `base` tries to save with the stale revision.
  assert.throws(
    () => store.saveStep(guide.guideId, { ...base, title: 'stale background' }, { expectedRevision: base.revision }),
    (err) => err instanceof RevisionConflictError && err.code === 'STEPFORGE_REVISION_CONFLICT'
  );
  // The user edit survived.
  assert.equal(store.getStep(guide.guideId, step.stepId).title, 'user edit');
});

test('compare-and-swap succeeds when the revision still matches', (t) => {
  const root = makeTmpDir('store-cas-ok');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });
  const step = store.addStep(guide.guideId, { title: 'S' }, TINY_PNG, { width: 1, height: 1 });
  const base = store.getStep(guide.guideId, step.stepId);

  const saved = store.saveStep(guide.guideId, { ...base, title: 'ok' }, { expectedRevision: base.revision });
  assert.equal(saved.title, 'ok');
  assert.equal(saved.revision, base.revision + 1);
});

test('guide saves are revision-aware too', (t) => {
  const root = makeTmpDir('store-guide-cas');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });
  const base = store.getGuide(guide.guideId);
  store.saveGuide({ ...base, title: 'first' });
  assert.throws(
    () => store.saveGuide({ ...base, title: 'stale' }, { expectedRevision: base.revision }),
    RevisionConflictError
  );
});

test('v1 data without a revision field reads as revision 0 and upgrades on save', (t) => {
  const root = makeTmpDir('store-v1');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });

  // Simulate legacy on-disk data: strip the revision field.
  const file = path.join(store.guidesDir, guide.guideId, 'guide.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.revision;
  fs.writeFileSync(file, JSON.stringify(raw));

  const loaded = store.getGuide(guide.guideId);
  assert.equal(loaded.revision, 0);
  const saved = store.saveGuide(loaded);
  assert.equal(saved.revision, 1);
});

// ---- corruption quarantine --------------------------------------------------

test('a corrupt guide is quarantined and reported, not silently dropped', (t) => {
  const root = makeTmpDir('store-quarantine-guide');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const good = store.createGuide({ title: 'Good' });
  const bad = store.createGuide({ title: 'Bad' });

  // Corrupt the bad guide's JSON.
  fs.writeFileSync(path.join(store.guidesDir, bad.guideId, 'guide.json'), '{ not valid json');

  const listed = store.listGuides();
  assert.deepEqual(listed.map((g) => g.guideId), [good.guideId]);

  const report = store.getRecoveryReport();
  assert.equal(report.length, 1);
  assert.equal(report[0].kind, 'guide');
  // The original bytes are preserved in quarantine, not deleted.
  assert.ok(fs.existsSync(report[0].quarantined));
  // The bad guide dir is gone from the live library.
  assert.equal(fs.existsSync(path.join(store.guidesDir, bad.guideId)), false);
});

test('a corrupt step is quarantined and reported', (t) => {
  const root = makeTmpDir('store-quarantine-step');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });
  const good = store.addStep(guide.guideId, { title: 'good' }, TINY_PNG, { width: 1, height: 1 });
  const bad = store.addStep(guide.guideId, { title: 'bad' }, TINY_PNG, { width: 1, height: 1 });

  fs.writeFileSync(path.join(store.stepDir(guide.guideId, bad.stepId), 'step.json'), 'nonsense');

  const steps = store.listSteps(guide.guideId);
  assert.ok(steps.has(good.stepId));
  assert.equal(steps.has(bad.stepId), false);
  const report = store.getRecoveryReport();
  assert.equal(report.some((r) => r.kind === 'step'), true);
});

test('an empty/in-progress guide directory is not treated as corruption', (t) => {
  const root = makeTmpDir('store-empty-dir');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  // A directory with no guide.json (e.g. mid-create) must be skipped quietly.
  fs.mkdirSync(path.join(store.guidesDir, 'orphan-dir'), { recursive: true });
  assert.doesNotThrow(() => store.listGuides());
  assert.equal(store.getRecoveryReport().length, 0);
});
