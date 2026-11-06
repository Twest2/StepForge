'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const raster = require('../../core/raster');
const shapes = require('../../core/annotation-shapes');
const { encodePng, decodePng } = require('../../core/png');
const { normalizeAnnotation, normalizeStep, validateStep, createGuide, createStep } = require('../../core/schema');
const { diffGuides } = require('../../core/guide-diff');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { buildRenderAst } = require('../../core/renderast');
const { exportImageBundle } = require('../../exporters/image-bundle');
const { createAgentTools } = require('../../core/agent-tools');
const { makeTmpDir, rmrf, rendererI18n } = require('./helpers');

const RED = [255, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

function px(img, x, y) {
  const p = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [...img.data.subarray(p, p + 4)];
}

const pen = (extra = {}) => ({
  id: 'p1', type: 'pen', x: 0.1, y: 0.2, w: 0.6, h: 0.6,
  // A V: down to the bottom middle and back up.
  points: [[0, 0], [0.5, 1], [1, 0]],
  style: { stroke: '#FF0000', strokeWidth: 20 },
  ...extra,
});

const curved = (extra = {}) => ({
  id: 'c1', type: 'curvedArrow', x: 0.1, y: 0.5, w: 0.8, h: 0,
  bend: [0.5, -0.3],
  style: { stroke: '#FF0000', strokeWidth: 20 },
  ...extra,
});

test('a pen stroke is burned in as a smooth curve through its points', () => {
  const out = raster.renderAnnotations(raster.createImage(200, 100), [pen()]);
  // Box 20..140 x 20..80: points (20,20), (80,80), (140,20).
  assert.deepEqual(px(out, 21, 21), RED, 'the stroke starts at the first point');
  assert.deepEqual(px(out, 139, 21), RED, 'and ends at the last');
  // Smoothed: from the first point it curves, with the corner as control
  // point, to the middle of the second leg, so it never reaches the corner.
  const mid = { x: 0.25 * 20 + 0.5 * 80 + 0.25 * 110, y: 0.25 * 20 + 0.5 * 80 + 0.25 * 50 };
  assert.deepEqual(px(out, mid.x, mid.y), RED, 'the rounded bottom of the V');
  assert.deepEqual(px(out, 80, 79), WHITE, 'the sharp corner is smoothed away');
  assert.deepEqual(px(out, 80, 25), WHITE, 'inside the V is untouched');
  assert.deepEqual(px(out, 180, 50), WHITE, 'outside the box is untouched');
});

test('a see-through pen color is blended once where the stroke overlaps itself', () => {
  const loop = pen({ points: [[0, 0.5], [1, 0.5], [1, 0], [0.5, 1], [0.5, 0]], style: { stroke: '#FF000080', strokeWidth: 20 } });
  const out = raster.renderAnnotations(raster.createImage(200, 100), [loop]);
  const colors = new Set();
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 1] !== 255) colors.add(out.data.subarray(i, i + 4).join(','));
  }
  assert.deepEqual([...colors], ['255,127,127,255']);
});

test('a curved arrow is burned in along its bend, with an arrow head at the end', () => {
  const out = raster.renderAnnotations(raster.createImage(200, 100), [curved()]);
  // From (20,50) to (180,50); control point (100, 50 - 0.3 * 160 = 2), so the
  // curve peaks at y = 26 halfway along.
  assert.deepEqual(px(out, 100, 26), RED, 'the top of the bend');
  assert.deepEqual(px(out, 100, 50), WHITE, 'not the straight line between the ends');
  assert.deepEqual(px(out, 21, 50), RED, 'the start');
  // The head points along the curve's end (down and to the right, from the
  // control point), and is the straight arrow's head: as wide as it is long.
  const straight = raster.renderAnnotations(raster.createImage(200, 100), [{ ...curved(), type: 'arrow' }]);
  const count = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 1] === 0) n++; return n; };
  assert.ok(count(out) > count(straight), 'the curve is longer than the straight arrow');
  assert.deepEqual(px(out, 178, 49), RED, 'the tip reaches the end');
  const g = shapes.curvedArrowGeometry(20, 50, 180, 50, [0.5, -0.3], 4);
  const [tip, a, b] = g.head;
  const headLen = Math.hypot(tip[0] - (a[0] + b[0]) / 2, tip[1] - (a[1] + b[1]) / 2);
  assert.ok(Math.abs(headLen - 16) < 0.01, `head length ${headLen} matches the straight arrow (4 x stroke)`);
  const dir = [(tip[0] - (a[0] + b[0]) / 2) / headLen, (tip[1] - (a[1] + b[1]) / 2) / headLen];
  assert.ok(dir[0] > 0.7 && dir[1] > 0.4, `head points down and right along the curve, got ${dir}`);

  // Bent the other way, it dips below the line instead.
  const down = raster.renderAnnotations(raster.createImage(200, 100), [curved({ bend: [0.5, 0.3] })]);
  assert.deepEqual(px(down, 100, 74), RED);
  assert.deepEqual(px(down, 100, 26), WHITE);
});

test('pen and curved arrow survive the schema and a save and reload', (t) => {
  const p = normalizeAnnotation({ type: 'pen', x: 0.1, y: 0.1, w: 0.5, h: 0.5, points: [[0, 0], [0.123456, 1], 'bad', [NaN, 1], [1, 0.5]] });
  assert.deepEqual(p.points, [[0, 0], [0.1235, 1], [1, 0.5]], 'points are kept rounded, junk dropped');
  assert.deepEqual(normalizeAnnotation({ type: 'curvedArrow', x: 0, y: 0, w: 0.5, h: 0.5 }).bend, shapes.DEFAULT_BEND, 'a missing bend is the default');
  assert.deepEqual(normalizeAnnotation({ type: 'curvedArrow', bend: [0.2, 0.4] }).bend, [0.2, 0.4]);
  assert.equal(normalizeAnnotation({ type: 'rect', points: [[0, 0]], bend: [1, 1] }).points, undefined, 'other types get neither');

  const dir = makeTmpDir('pen-curved');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Draw' });
  const step = store.addStep(guide.guideId, { title: 'One', annotations: [pen(), curved({ bend: [0.4, 0.25] })] },
    encodePng(raster.createImage(20, 10)), { width: 20, height: 10 });
  const loaded = store.getStep(guide.guideId, step.stepId);
  validateStep(loaded);
  assert.deepEqual(loaded.annotations.map((a) => a.type), ['pen', 'curvedArrow']);
  assert.deepEqual(loaded.annotations[0].points, pen().points);
  assert.deepEqual(loaded.annotations[1].bend, [0.4, 0.25]);
  assert.deepEqual(normalizeStep(JSON.parse(JSON.stringify(loaded))).annotations, loaded.annotations, 'a second load changes nothing');
});

test('an exported image shows the pen stroke and the curved arrow', (t) => {
  const dir = makeTmpDir('pen-curved-export');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Draw' });
  store.addStep(guide.guideId, { title: 'Point around it', annotations: [curved(), pen({ y: 0, h: 0.3, style: { stroke: '#0000FF', strokeWidth: 20 } })] },
    encodePng(raster.createImage(200, 100)), { width: 200, height: 100 });
  const { folder } = exportImageBundle(buildRenderAst(store, guide.guideId), path.join(dir, 'out'));
  const [file] = fs.readdirSync(folder).filter((name) => name.endsWith('.png'));
  const img = decodePng(fs.readFileSync(path.join(folder, file)));
  assert.deepEqual(px(img, 100, 26), RED, 'curved arrow');
  assert.deepEqual(px(img, 100, 50), WHITE);
  assert.deepEqual(px(img, 21, 1), [0, 0, 255, 255], 'pen');
});

test('comparing with a snapshot shows a changed bend or redrawn stroke as changed annotations', () => {
  const image = { originalPath: 'original.png', workingPath: 'original.png', size: { width: 10, height: 10 } };
  const side = (annotations) => {
    const step = createStep({ stepId: 's1', title: 'Point', image, annotations });
    return { guide: { ...createGuide({ title: 'G' }), stepsOrder: ['s1'] }, steps: [step], fileSha: () => 'same' };
  };
  const before = side([curved(), pen()]);
  assert.equal(diffGuides(before, side([curved(), pen()])).identical, true);
  for (const after of [side([curved({ bend: [0.5, 0.3] }), pen()]), side([curved(), pen({ points: [[0, 0], [1, 1]] })])]) {
    const [step] = diffGuides(before, after).steps;
    assert.equal(step.status, 'changed');
    assert.deepEqual(step.changes.map((c) => c.reasons), [['annotations']]);
  }
});

// ---- the editor canvas ------------------------------------------------------

function fakeContext() {
  const fn = () => proxy;
  const proxy = new Proxy(fn, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : proxy),
    set: () => true,
    apply: () => proxy,
  });
  return proxy;
}

function fakeCanvasElement() {
  return {
    width: 0, height: 0,
    parentElement: { clientWidth: 1040, clientHeight: 840 },
    addEventListener() {},
    setPointerCapture() {},
    getContext: () => fakeContext(),
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; },
  };
}

function loadRenderer() {
  const context = {
    ...rendererI18n(),
    window: { stepforge: {}, StepForgeDialogs: {}, StepForgeAnnotationShapes: shapes },
    document: { createElement: () => fakeCanvasElement() },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/canvas.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  return context.window;
}

// A 1000x800 screenshot shown at 1:1, with the editor's tool wiring.
function editorWithCanvas() {
  const { AnnotationCanvas, GuideEditor } = loadRenderer();
  const editor = Object.create(GuideEditor.prototype);
  const button = (tool) => ({ dataset: { tool }, classList: { toggle() {} }, setAttribute() {} });
  editor.dom = { 'tool-pen': button('pen'), 'tool-curvedArrow': button('curvedArrow'), zoomSelect: { value: 'fit', children: [{ value: 'fit', dataset: {} }], append() {} } };
  editor.currentZoom = 'fit';
  editor.setSettings({});
  const changes = [];
  editor.canvas = new AnnotationCanvas(fakeCanvasElement(), {
    onChange: (annotations) => changes.push(JSON.parse(JSON.stringify(annotations))),
    onToolUsed: () => editor.onCanvasToolUsed(),
  });
  editor.canvas.setImage({}, 1000, 800);
  return { editor, canvas: editor.canvas, changes };
}

// Arrays made inside the vm context aren't this realm's, so compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const ev = (x, y) => ({ pointerId: 1, clientX: x, clientY: y });

test('pen coordinates use the CSS viewport on a HiDPI canvas, including focused view', () => {
  const { canvas } = editorWithCanvas();
  canvas.viewW = 1000;
  canvas.viewH = 800;
  canvas.canvas.width = 2000;
  canvas.canvas.height = 1600;
  assert.deepEqual(plain(canvas.fromPx(250, 200)), { x: 0.25, y: 0.25 });
  canvas.focusedView = { enabled: true, zoom: 2, panX: 0.5, panY: 0.5 };
  assert.deepEqual(plain(canvas.fromPx(250, 200)), { x: 0.375, y: 0.375 });
});

function drag(canvas, points) {
  canvas.onDown(ev(...points[0]));
  for (const p of points.slice(1)) canvas.onMove(ev(...p));
  const last = points[points.length - 1];
  canvas.onUp(ev(...last));
}

test('P and J pick the pen and curved arrow tools', () => {
  const { editor } = editorWithCanvas();
  for (const [key, tool] of [['p', 'pen'], ['j', 'curvedArrow'], ['J', 'curvedArrow']]) {
    editor.setTool('select');
    Object.assign(editor, { active: true, guide: {} });
    editor.onDocumentKeyDown({ key, target: {}, preventDefault() {} });
    assert.equal(editor.currentTool, tool, key);
  }
});

test('drawing with the pen keeps a thinned, smooth stroke and goes back to Select', () => {
  const { editor, canvas, changes } = editorWithCanvas();
  editor.setTool('pen');
  // A slow half circle: 181 pointer moves one degree apart.
  const arc = Array.from({ length: 181 }, (_, i) => [500 + 200 * Math.cos(Math.PI * i / 180), 400 + 200 * Math.sin(Math.PI * i / 180)]);
  drag(canvas, arc);
  assert.equal(editor.currentTool, 'select');
  assert.equal(changes.length, 1);
  const [ann] = canvas.annotations;
  assert.equal(ann.type, 'pen');
  assert.equal(canvas.selectedId, ann.id);
  assert.ok(ann.points.length < 60, `${ann.points.length} points kept of 181`);
  assert.ok(ann.points.length > 8, 'enough points to keep the curve');
  // The box is the stroke's: x 300..700, y 400..600 of a 1000x800 image.
  assert.ok(Math.abs(ann.x - 0.3) < 0.001 && Math.abs(ann.w - 0.4) < 0.001, `x ${ann.x} w ${ann.w}`);
  assert.ok(Math.abs(ann.y - 0.5) < 0.001 && Math.abs(ann.h - 0.25) < 0.003, `y ${ann.y} h ${ann.h}`);
  // Every kept point is still on the circle drawn.
  for (const [fx, fy] of ann.points) {
    const r = Math.hypot(ann.x * 1000 + fx * ann.w * 1000 - 500, ann.y * 800 + fy * ann.h * 800 - 400);
    assert.ok(Math.abs(r - 200) < 1, `point off the stroke by ${r - 200}`);
  }

  // A click picks the stroke, not the empty middle of its box.
  canvas.select(null);
  assert.equal(canvas.hitTest(canvas.toNorm(ev(500, 600))), ann, 'on the stroke');
  assert.equal(canvas.hitTest(canvas.toNorm(ev(500, 450))), null, 'inside the box, away from the stroke');

  // A click with the pen draws nothing.
  editor.setTool('pen');
  drag(canvas, [[100, 100]]);
  assert.equal(canvas.annotations.length, 1);
  assert.equal(changes.length, 1);
});

test('moving and resizing a pen stroke carries its points, including flipping it over', () => {
  const { canvas } = editorWithCanvas();
  canvas.setAnnotations([pen({ x: 0.1, y: 0.1, w: 0.4, h: 0.4, points: [[0, 0], [0.5, 1], [1, 0.25]] })]);
  // Drag the stroke by its first point.
  drag(canvas, [[100, 80], [200, 160]]);
  const ann = canvas.annotations[0];
  assert.deepEqual([ann.x, ann.y].map((v) => Number(v.toFixed(4))), [0.2, 0.2]);
  assert.deepEqual(plain(ann.points), [[0, 0], [0.5, 1], [1, 0.25]]);
  // Drag the right edge's handle past the left edge: the stroke mirrors, and the box stays positive.
  drag(canvas, [[600, 320], [100, 320]]);
  assert.ok(ann.w > 0);
  assert.deepEqual([Number(ann.x.toFixed(4)), Number(ann.w.toFixed(4))], [0.1, 0.1]);
  assert.deepEqual(plain(ann.points), [[1, 0], [0.5, 1], [0, 0.25]]);
});

test('a curved arrow is drawn with a gentle bend, picked on its curve, and bent by its middle handle', () => {
  const { editor, canvas, changes } = editorWithCanvas();
  editor.setTool('curvedArrow');
  drag(canvas, [[100, 400], [500, 400], [900, 400]]);
  assert.equal(editor.currentTool, 'select');
  const [ann] = canvas.annotations;
  assert.equal(ann.type, 'curvedArrow');
  assert.deepEqual(plain(ann.bend), shapes.DEFAULT_BEND);
  assert.deepEqual([ann.x, ann.y, ann.w, ann.h], [0.1, 0.5, 0.8, 0]);
  // Halfway along, the curve is 0.15 x 800 = 120 px above the line.
  canvas.select(null);
  assert.equal(canvas.hitTest(canvas.toNorm(ev(500, 280))), ann, 'on the curve');
  assert.equal(canvas.hitTest(canvas.toNorm(ev(500, 400))), null, 'on the straight line between the ends');
  assert.equal(canvas.hitTest(canvas.toNorm(ev(120, 395))), ann, 'near the start');

  // Selected, it has its two ends and a bend handle on the curve.
  canvas.select(ann.id);
  assert.deepEqual(plain(canvas.handles(ann)).map((h) => [h.id, Math.round(h.px), Math.round(h.py)]),
    [['p1', 100, 400], ['p2', 900, 400], ['bend', 500, 280]]);
  // Dragging the bend handle below the line bends it the other way, through the drop point.
  drag(canvas, [[500, 280], [500, 600]]);
  const mid = shapes.curveMidpoint(100, 400, 900, 400, ann.bend);
  assert.ok(Math.abs(mid.x - 500) < 0.5 && Math.abs(mid.y - 600) < 0.5, `midpoint ${mid.x},${mid.y}`);
  assert.equal(canvas.hitTest(canvas.toNorm(ev(500, 600))), ann);
  assert.equal(changes.length, 2, 'drawing and bending each save once');

  // Moving the end keeps the bend's shape relative to the ends.
  const bend = [...ann.bend];
  drag(canvas, [[900, 400], [900, 200]]);
  assert.deepEqual(plain(ann.bend), bend);
  assert.ok(Math.abs(ann.h + 0.25) < 1e-9);
});

// ---- agents -------------------------------------------------------------------

test('agents can draw and read back a pen stroke and a curved arrow in screenshot pixels', async (t) => {
  const dir = makeTmpDir('pen-curved-agent');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  new Settings(store.settingsDir).set('ai.agents', { enabled: true, screenshots: true });
  const guide = store.createGuide({ title: 'Lab' });
  const step = store.addStep(guide.guideId, { title: 'Shot' }, encodePng(raster.createImage(200, 100)), { width: 200, height: 100 });
  const tools = createAgentTools({ store, agentSettings: () => new Settings(store.settingsDir).get('ai.agents'), onChange() {} });
  const call = (name, args) => tools.find((tool) => tool.name === name).handler(args);

  await call('add_annotations', {
    guide_id: guide.guideId,
    step_id: step.stepId,
    annotations: [
      { type: 'curvedArrow', from: [20, 50], to: [180, 50], via: [100, 20], color: '#FF0000' },
      { type: 'pen', points: [[20, 20], [80, 80], [140, 20]] },
      { type: 'curvedArrow', from: [20, 90], to: [180, 90] },
    ],
  });
  const saved = store.getStep(guide.guideId, step.stepId).annotations;
  assert.deepEqual(saved.map((a) => a.type), ['curvedArrow', 'pen', 'curvedArrow']);
  assert.deepEqual(saved[1].points, [[0, 0], [0.5, 1], [1, 0]]);
  assert.deepEqual(saved[2].bend, shapes.DEFAULT_BEND, 'no via: the gentle default bend');
  // The curve passes through the via point.
  const img = raster.renderAnnotations(raster.createImage(200, 100), saved.slice(0, 1));
  assert.deepEqual(px(img, 100, 20), RED);

  const shown = JSON.parse((await call('get_step', { guide_id: guide.guideId, step_id: step.stepId })).content[0].text);
  const [arrow, stroke] = shown.annotations;
  assert.deepEqual([arrow.from, arrow.to, arrow.via], [[20, 50], [180, 50], [100, 20]]);
  assert.deepEqual(stroke.points, [[20, 20], [80, 80], [140, 20]]);

  for (const [annotations, message] of [
    [[{ type: 'pen', points: [[1, 1]] }], /a pen needs points/],
    [[{ type: 'pen', points: [[1, 1], [2]] }], /a pen needs points/],
    [[{ type: 'curvedArrow', from: [1, 1], to: [50, 50], via: 'up' }], /via must be/],
  ]) {
    const bad = await call('add_annotations', { guide_id: guide.guideId, step_id: step.stepId, annotations });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, message);
  }
});
