'use strict';

// Editor steps: adding steps (dialog and clipboard), editing titles,
// reordering, duplicating and deleting with undo. Assertions read step.json
// and guide.json and the stored image pixels.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { withApp, readSteps, readJson, writeTestPng, decodeStoredImage, pixelAt } = require('./lib/fixtures');
const { openGuideCard, openLibrary, eventually, confirmDialog } = require('./lib/flows');

const SAMPLE_ID = 'guide-sample-reset-password';
const SAMPLE_GUIDE = path.join('library', 'guides', SAMPLE_ID);

function guideDir(env) {
  return path.join(env.dataDir, SAMPLE_GUIDE);
}

function titlesOnDisk(env) {
  return readSteps(guideDir(env)).map((s) => s.step.title);
}

/** Opens the sample guide in the editor from the library. */
async function openSample(app) {
  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
}

/** Selects a step in the list by its position number (1-based) as a person would, with a click. */
async function selectStepByNumber(app, number) {
  await app.clickWhere('.step-select', `(el) => (el.getAttribute('aria-label') || '').startsWith('Select step ${number} ')`);
}

/** The editor's list of step titles, in on-screen order. */
async function listedTitles(app) {
  return app.evaluate(`[...document.querySelectorAll('.step-item')].map((item) => (item.querySelector('.step-title, .step-name') || item).textContent.trim())`);
}

test('adding a step with a picked image writes the image and the title to disk', () => withApp('editor-add-image', {}, async (app, env) => {
  const picture = writeTestPng(path.join(env.root, 'pick', 'picked.png'));
  await app.main.stubDialogs({ open: [{ filePaths: [picture] }] });
  await openSample(app);

  await app.clickText('Add');
  await app.waitForVisible('#modal-root input', { label: 'add step dialog' });
  await app.clickText('Choose image…', { scope: '#modal-root' });
  await app.waitForVisible('#modal-root .primary', { label: 'add button' });
  await app.setValue('#modal-root input', 'Picked from disk');
  await app.clickText('Add', { scope: '#modal-root' });

  const added = await eventually(() => readSteps(guideDir(env)).find((s) => s.step.title === 'Picked from disk'), 'new step on disk');
  assert.equal(readSteps(guideDir(env)).length, 7, 'six sample steps plus the new one');
  assert.equal(added.step.image.size.width, 240);
  assert.equal(added.step.image.size.height, 160);

  const stored = await decodeStoredImage(path.join(added.dir, added.step.image.workingPath));
  assert.deepEqual(pixelAt(stored, 30, 80), [220, 30, 30, 255], 'left half is still red');
  assert.deepEqual(pixelAt(stored, 200, 20), [30, 30, 220, 255], 'right half is still blue');
}));

test('Ctrl+V with an image on the clipboard adds it as a new step', () => withApp('editor-paste', {}, async (app, env) => {
  const picture = writeTestPng(path.join(env.root, 'clip', 'clip.png'));
  await app.main.setClipboardImage(picture);
  await openSample(app);

  await app.clickAt(640, 700); // empty canvas area, so the key goes to the editor and not a text field
  await app.key('v', { ctrl: true });

  const pasted = await eventually(() => {
    const steps = readSteps(guideDir(env));
    return steps.length === 7 ? steps[6] : null;
  }, 'pasted step on disk');
  const stored = await decodeStoredImage(path.join(pasted.dir, pasted.step.image.workingPath));
  assert.equal(stored.width, 240);
  assert.deepEqual(pixelAt(stored, 100, 80), [30, 160, 60, 255], 'the green box is where it was drawn');
  assert.deepEqual(pixelAt(stored, 20, 20), [220, 30, 30, 255], 'the pasted pixels are the clipboard pixels');
}));

test('typing a step title is saved to step.json', () => withApp('editor-title', {}, async (app, env) => {
  await openSample(app);
  await selectStepByNumber(app, 2);
  await app.setValue('input[aria-label="Step title"]', 'Turn on the policy');
  const step = await eventually(() => readSteps(guideDir(env)).find((s) => s.stepId === 'step-sample-02-enable-policy' && s.step.title === 'Turn on the policy'), 'title saved');
  assert.equal(step.step.title, 'Turn on the policy');
  assert.equal(readSteps(guideDir(env))[1].step.title, 'Turn on the policy', 'still the second step');
}));

test('Move step up and Move step down reorder the steps on disk', () => withApp('editor-move', {}, async (app, env) => {
  await openSample(app);
  const ids = () => readSteps(guideDir(env)).map((s) => s.stepId);
  const before = ids();
  const review = 'step-sample-03-review-confirmation';
  assert.equal(before[3], review);

  await selectStepByNumber(app, 3);
  await app.click('button[aria-label="Move step up"]');
  // Moving up skips over the sub-step thread of the step above ("2 Enable the reset policy" and its "2.1").
  await eventually(() => ids()[1] === review, 'review step moved up on disk');
  assert.deepEqual(ids(), [before[0], review, before[1], before[2], ...before.slice(4)]);
  assert.deepEqual(readJson(path.join(guideDir(env), 'guide.json')).stepsOrder, ids(), 'guide.json lists the same order');

  await app.click('button[aria-label="Move step down"]');
  await eventually(() => ids()[3] === review, 'review step moved back down on disk');
  assert.deepEqual(ids(), before);
}));

test('dragging a step in the list reorders it on disk', () => withApp('editor-drag', {}, async (app, env) => {
  await openSample(app);
  const ids = () => readSteps(guideDir(env)).map((s) => s.stepId);
  const before = ids();
  const review = 'step-sample-03-review-confirmation';

  await selectStepByNumber(app, 3);
  const from = await app.centerOf('.step-select[aria-label^="Select step 3 "]');
  const to = await app.centerOf('.step-select[aria-label^="Select step 1 "]');
  await app.drag(from, { x: to.x, y: to.y - 6 });
  await eventually(() => ids()[0] === review, 'dragged step is first on disk');
  assert.deepEqual(ids().slice().sort(), before.slice().sort(), 'no step was lost or copied');
}));

test('Duplicate adds a copy; Delete then Ctrl+Z brings the step back', () => withApp('editor-undo', {}, async (app, env) => {
  await openSample(app);
  const before = titlesOnDisk(env);

  await selectStepByNumber(app, 1);
  await app.clickText('Duplicate');
  await eventually(() => readSteps(guideDir(env)).length === 7, 'duplicate on disk');
  assert.equal(titlesOnDisk(env).filter((t) => t === `${before[0]} copy`).length, 1, 'the copy is named "<title> copy"');

  await selectStepByNumber(app, 2);
  await app.clickText('Delete');
  if (await app.isVisible('#modal-root .primary')) await confirmDialog(app, 'Delete');
  await eventually(() => readSteps(guideDir(env)).length === 6, 'step deleted on disk');

  await app.key('z', { ctrl: true });
  await eventually(() => readSteps(guideDir(env)).length === 7, 'Ctrl+Z restored the step on disk');
  assert.equal(titlesOnDisk(env).filter((t) => t === `${before[0]} copy`).length, 1, 'the copy is still there');
}));
