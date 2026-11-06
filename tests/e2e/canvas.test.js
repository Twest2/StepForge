'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withApp, readSteps, writeTestPng, readJson, decodePngFile, pixelAt } = require('./lib/fixtures');
const { openLibrary, openGuideCard, addPictureStep, showWholeImage, eventually, exportThroughUi } = require('./lib/flows');

test('drawing, moving and deleting a rectangle saves geometry; undo and redo restore it', () => withApp('canvas-rectangle', {}, async (app, env) => {
  const guideDir = path.join(env.dataDir, 'library/guides/guide-sample-reset-password');
  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
  const id = await addPictureStep(app, { guideDir, title: 'Canvas target', picture: writeTestPng(path.join(env.root, 'picture.png')) });
  await showWholeImage(app, id, guideDir);
  const annotations = () => readSteps(guideDir).find((s) => s.stepId === id).step.annotations;
  const canvas = await app.waitForVisible('canvas[aria-label="Screenshot editor"]');
  const point = (x, y) => ({ x: canvas.x + (x - 0.5) * canvas.width, y: canvas.y + (y - 0.5) * canvas.height });
  await app.click('[data-tool="rect"]');
  await app.drag(point(0.15, 0.15), point(0.65, 0.65));
  const [rect] = await eventually(() => annotations().length === 1 && annotations(), 'rectangle saved');
  assert.equal(rect.type, 'rect');
  for (const [key, expected] of Object.entries({ x: 0.15, y: 0.15, w: 0.5, h: 0.5 })) {
    assert.ok(Math.abs(rect[key] - expected) < 0.02, `${key}: ${rect[key]} vs ${expected}`);
  }
  await app.key('Escape');
  await app.drag(point(0.4, 0.4), point(0.5, 0.5));
  await eventually(() => annotations()[0].x > rect.x + 0.08, 'rectangle moved');
  const moved = annotations()[0];
  assert.ok(Math.abs(moved.y - rect.y - 0.1) < 0.02);
  assert.equal(moved.w, rect.w);
  await app.key('z', { ctrl: true });
  await eventually(() => Math.abs(annotations()[0].x - rect.x) < 0.001, 'undo move');
  await app.key('z', { ctrl: true, shift: true });
  await eventually(() => Math.abs(annotations()[0].x - moved.x) < 0.001, 'redo move');
  await app.key('Delete');
  await eventually(() => annotations().length === 0, 'rectangle deleted');
  await app.key('z', { ctrl: true });
  await eventually(() => annotations().length === 1, 'undo deletion');
  assert.equal(annotations()[0].id, rect.id);
  const exported = await exportThroughUi(app, env, 'json', '.json');
  const output = readJson(exported).steps.find((s) => s.title === 'Canvas target');
  const image = decodePngFile(path.resolve(path.dirname(exported), output.image.relPath));
  const edge = Math.round(annotations()[0].x * image.width);
  const middle = Math.round((annotations()[0].y + annotations()[0].h / 2) * image.height);
  const stroke = annotations()[0].style.stroke.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16));
  assert.ok([-2, -1, 0, 1, 2].some((dx) => pixelAt(image, edge + dx, middle).slice(0, 3).every((c, i) => c === stroke[i])),
    'the rectangle drawn with the mouse is burned into the exported PNG');
}));

test('drawing a blur and changing its radius saves its region and properties', () => withApp('canvas-blur', {}, async (app, env) => {
  const guideDir = path.join(env.dataDir, 'library/guides/guide-sample-reset-password');
  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
  const id = await addPictureStep(app, { guideDir, title: 'Blur target', picture: writeTestPng(path.join(env.root, 'picture.png')) });
  await showWholeImage(app, id, guideDir);
  const annotations = () => readSteps(guideDir).find((s) => s.stepId === id).step.annotations;
  const box = await app.waitForVisible('canvas[aria-label="Screenshot editor"]');
  await app.click('[data-tool="blur"]');
  await app.drag({ x: box.x - box.width * 0.2, y: box.y - box.height * 0.3 }, { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 });
  await eventually(() => annotations().length === 1, 'blur saved');
  assert.equal(annotations()[0].type, 'blur');
  await app.setValue('.annotation-editor-inner input[type="number"]', '18');
  await app.key('Tab');
  await eventually(() => annotations()[0].radius === 18, 'blur radius saved');
}));
