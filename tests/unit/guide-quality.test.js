'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildRenderAst } = require('../../core/renderast');
const { qualityFindings } = require('../../core/quality');
const { stepNumberMap } = require('../../core/step-outline');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

/**
 * Guide quality checks before exporting or publishing: placeholders with no
 * value, steps without a screenshot, and steps without a real title. Each
 * finding names its step so the dialog can jump there.
 */

function withGuide(fn) {
  const dir = makeTmpDir('quality');
  try {
    return fn(buildFixtureGuide(dir));
  } finally {
    rmrf(dir);
  }
}

// As app/main.js does: steps are labelled with the editor's numbers.
function check(store, guideId, globals = {}) {
  const steps = store.listSteps(guideId);
  const numbers = stepNumberMap(store.getGuide(guideId).stepsOrder.map((id) => steps.get(id)));
  return qualityFindings(buildRenderAst(store, guideId, { globals }), numbers);
}

test('a finished guide has nothing to check', () => withGuide(({ store, guide }) => {
  // The fixture's text-only substep (a title and a warning block, no
  // screenshot) is intentional, and its hidden and skipped steps aren't exported.
  assert.deepEqual(check(store, guide.guideId), []);
}));

test('placeholders with no value are flagged where they would print, and globals count as values', () => withGuide(({ store, guide, s1, s2 }) => {
  store.saveGuide({ ...store.getGuide(guide.guideId), title: 'Set up [[Product]] for [[Team]]' });
  const step = store.getStep(guide.guideId, s2.stepId);
  store.saveStep(guide.guideId, { ...step, descriptionHtml: '<p>Ask [[Admin]] then [[Team]].</p>',
    annotations: [...step.annotations, { type: 'text', text: 'See [[Wiki_URL]]', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] });

  assert.deepEqual(check(store, guide.guideId), [
    { kind: 'placeholder', stepId: null, stepNumber: null, names: ['Team'] },
    { kind: 'placeholder', stepId: s2.stepId, stepNumber: '2', names: ['Admin', 'Team', 'Wiki_URL'] },
  ]);
  // A value in Settings → Placeholders resolves it everywhere.
  const withGlobals = check(store, guide.guideId, { Team: 'IT', Admin: 'Sam' });
  assert.deepEqual(withGlobals.map((f) => f.names), [['Wiki_URL']]);
  assert.equal(check(store, guide.guideId).some((f) => f.stepId === s1.stepId), false, 'defined guide placeholders are fine');
}));

test('steps without a screenshot are flagged, but text-only steps are not', () => withGuide(({ store, guide, s1, sub }) => {
  const empty = store.addStep(guide.guideId, { kind: 'empty', title: 'Click Save' });
  // The screenshot file was deleted outside StepForge.
  const shot = store.getStep(guide.guideId, s1.stepId);
  fs.rmSync(path.join(store.stepDir(guide.guideId, s1.stepId), shot.image.workingPath));

  const findings = check(store, guide.guideId).filter((f) => f.kind === 'screenshot');
  assert.deepEqual(findings, [
    { kind: 'screenshot', stepId: s1.stepId, stepNumber: '1', detail: 'file-missing' },
    // Numbered as in the editor's step list, which counts the hidden and
    // skipped steps 3 and 4 that the export leaves out.
    { kind: 'screenshot', stepId: empty.stepId, stepNumber: '5', detail: 'none' },
  ]);
  assert.equal(findings.some((f) => f.stepId === sub.stepId), false);
}));

test('steps with no title or an automatic one are flagged', () => withGuide(({ store, guide, s2 }) => {
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, s2.stepId), title: '  ' });
  const auto = store.addStep(guide.guideId, { kind: 'empty', title: 'Untitled step', descriptionHtml: '<p>Wait for it.</p>' });
  const capture = store.addStep(guide.guideId, { kind: 'empty', title: 'Screen capture', descriptionHtml: '<p>x</p>' });
  // A real title that merely starts like an automatic one is fine.
  store.addStep(guide.guideId, { kind: 'empty', title: 'Screen capture settings', descriptionHtml: '<p>x</p>' });

  assert.deepEqual(check(store, guide.guideId).filter((f) => f.kind === 'title'), [
    { kind: 'title', stepId: s2.stepId, stepNumber: '2', detail: 'empty' },
    { kind: 'title', stepId: auto.stepId, stepNumber: '5', detail: 'automatic', title: 'Untitled step' },
    { kind: 'title', stepId: capture.stepId, stepNumber: '6', detail: 'automatic', title: 'Screen capture' },
  ]);
}));

test('substeps are numbered as in the step list', () => withGuide(({ store, guide, sub }) => {
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, sub.stepId), title: '' });
  assert.deepEqual(check(store, guide.guideId), [{ kind: 'title', stepId: sub.stepId, stepNumber: '1.1', detail: 'empty' }]);
}));

function panel() {
  const node = (tag) => ({ tag, children: [], attrs: {}, append(...kids) { this.children.push(...kids); } });
  const context = vm.createContext({});
  context.el = (spec, props = {}, ...children) => {
    const n = node(spec);
    Object.assign(n.attrs, props);
    n.children = children.flat().filter((c) => c != null && c !== false);
    return n;
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/quality.js'), 'utf8'), context);
  return context;
}
const text = (n) => (typeof n === 'string' ? n : n.children.map(text).join(''));

test('the panel lists each finding as a button that jumps to it', () => {
  const ui = panel();
  assert.equal(ui.qualityPanel([], () => {}), null, 'nothing to show, no panel');
  const findings = [
    { kind: 'placeholder', stepId: null, stepNumber: null, names: ['Team'] },
    { kind: 'screenshot', stepId: 's1', stepNumber: '1', detail: 'file-missing' },
    { kind: 'title', stepId: 's2', stepNumber: '1.1', detail: 'automatic', title: 'Screen capture' },
    { kind: 'placeholder', stepId: 's3', stepNumber: '2', names: ['Admin', 'Team'] },
    { kind: 'screenshot', stepId: 's4', stepNumber: '3', detail: 'none' },
    { kind: 'title', stepId: 's5', stepNumber: '4', detail: 'empty' },
  ];
  const shown = [];
  const box = ui.qualityPanel(findings, (f) => shown.push(f));
  assert.match(text(box.children[0]), /^6 things to check before sharing/);
  const buttons = box.children[1].children;
  assert.deepEqual(buttons.map(text), [
    'Guide[[Team]] has no value',
    'Step 1Screenshot file is missing',
    'Step 1.1Still has the automatic title “Screen capture”',
    'Step 2[[Admin]], [[Team]] have no value',
    'Step 3No screenshot',
    'Step 4No title',
  ]);
  assert.ok(buttons.every((b) => b.tag === 'button.quality-item' && b.attrs.type === 'button'));
  buttons[2].attrs.onClick();
  assert.deepEqual(shown, [findings[2]]);
});
