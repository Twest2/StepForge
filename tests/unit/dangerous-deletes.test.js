'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Settings } = require('../../core/settings');
const { makeTmpDir, rmrf, rendererI18n } = require('./helpers');

/**
 * Settings → Editor → Dangerous deletes: the editor deletes steps without
 * asking. Runs the real confirm dialog (app/renderer/util.js) on a DOM stand-in and the real
 * editor against an in-memory main process.
 */

function fakeDom(context) {
  function el(spec, props = {}, ...children) {
    const node = { spec, hidden: false, inert: false, ...props, children: [], isConnected: true,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this[name] = value; },
      append(...items) { for (const child of items.flat()) { if (child == null || child === false) continue; this.children.push(child); if (typeof child === 'object') child.parent = this; } },
      remove() { this.parent.children = this.parent.children.filter((n) => n !== this); this.isConnected = false; },
      addEventListener(type, fn) { this[`on${type}`] = fn; },
      focus() {},
    };
    node.append(...children);
    return node;
  }
  const root = el('root');
  context.document = { activeElement: null, getElementById: () => root, addEventListener() {}, removeEventListener() {} };
  const all = (node, out = []) => {
    if (node && typeof node === 'object') { out.push(node); for (const child of node.children) all(child, out); }
    return out;
  };
  const text = (node) => (typeof node === 'object' ? node.children.map(text).join('') : String(node));
  return {
    el,
    root,
    // The open dialog, if any: its message and buttons.
    dialog() {
      const nodes = all(root);
      if (nodes.length === 1) return null;
      return {
        text: text(root),
        button: (label) => nodes.find((n) => n.spec?.startsWith('button') && n.children.includes(label)),
      };
    },
  };
}

function setup({ settings = {}, language = 'en' } = {}) {
  const db = {
    order: ['a', 'b', 'c'],
    steps: new Map(['a', 'b', 'c'].map((id) => [id, { stepId: id, title: `Step ${id}`, revision: 1, annotations: [] }])),
  };
  const api = {
    guide: { get: async () => ({ guide: { stepsOrder: db.order }, steps: db.order.map((id) => structuredClone(db.steps.get(id))) }) },
    step: {
      delete: async ({ stepId }) => { db.steps.delete(stepId); db.order = db.order.filter((id) => id !== stepId); },
    },
  };
  const context = { ...rendererI18n(language), StepForgeLocales: require('../../core/locales'),
    window: { stepforge: api, StepForgeOutline: require('../../core/step-outline') }, setTimeout, clearTimeout };
  const dom = fakeDom(context);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  context.el = dom.el;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, {
    guideId: 'g1', canvasHistory: [], canvasFuture: [], beforeCanvasSnapshot: null, pendingSave: false,
    steps: [], stepMap: new Map(), selectedSteps: new Set(),
    onToast() {}, renderStepBulkBar() {},
    reload: async (stepId) => {
      const { steps } = await api.guide.get();
      editor.steps = steps;
      editor.stepMap = new Map(steps.map((s) => [s.stepId, s]));
      editor.selectedStepId = stepId && editor.stepMap.has(stepId) ? stepId : steps[0]?.stepId;
    },
  });
  editor.settings = settings;
  return { editor, db, dom, context };
}

// Wait for the dialog the editor opened, or for the delete to finish without one.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Dangerous deletes is off by default and the choice is saved', (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const settings = new Settings(dir);
  assert.equal(settings.get('editor.dangerousDeletes'), false);
  settings.set('editor.dangerousDeletes', true);
  assert.equal(new Settings(dir).get('editor.dangerousDeletes'), true);
});

test('a settings file from before Dangerous deletes keeps asking', (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ schemaVersion: 1, editor: { returnToSelect: false } }));
  const settings = new Settings(dir);
  assert.equal(settings.get('editor.dangerousDeletes'), false);
  assert.equal(settings.get('editor.returnToSelect'), false);
});

test('with the setting off, deleting a step asks first, and Cancel keeps it', async () => {
  const { editor, db, dom } = setup();
  await editor.reload('b');
  const deleting = editor.deleteSelectedStep();
  await settle();
  const dialog = dom.dialog();
  assert.ok(dialog, 'expected a confirmation');
  assert.match(dialog.text, /Step b/);
  assert.match(dialog.button('Delete').className, /\bprimary\b/);
  assert.match(dialog.button('Delete').className, /\bdanger\b/);
  dialog.button('Cancel').onClick();
  await deleting;
  assert.deepEqual(db.order, ['a', 'b', 'c']);
});

test('confirming deletes the step and the next delete asks again', async () => {
  const { editor, db, dom } = setup();
  await editor.reload('b');
  const deleting = editor.deleteSelectedStep();
  await settle();
  dom.dialog().button('Delete').onClick();
  await deleting;
  assert.deepEqual(db.order, ['a', 'c']);

  const again = editor.deleteSelectedStep();
  await settle();
  assert.ok(dom.dialog(), 'still asks');
  dom.dialog().button('Cancel').onClick();
  await again;
});

test('with Dangerous deletes on, steps are deleted without asking and can still be undone', async () => {
  const { editor, db, dom } = setup({ settings: { editor: { dangerousDeletes: true } } });
  await editor.reload('b');
  await editor.deleteSelectedStep();
  assert.equal(dom.dialog(), null);
  assert.deepEqual(db.order, ['a', 'c']);
  assert.equal(editor.canvasHistory.at(-1).type, 'delete-step');

  editor.selectedSteps = new Set(['a', 'c']);
  await editor.deleteSelectedSteps();
  assert.equal(dom.dialog(), null);
  assert.deepEqual(db.order, []);
  assert.deepEqual([...editor.canvasHistory.at(-1).steps.map((entry) => entry.step.stepId)], ['a', 'c']);
});

test('Dangerous deletes doesn’t skip asking before deleting a guide', async () => {
  const confirms = [];
  const deleted = [];
  const api = { library: { delete: async ({ guideId }) => deleted.push(guideId) } };
  const context = { ...rendererI18n(), window: { stepforge: api }, document: { addEventListener() {} },
    confirmDialog: async (message, options) => { confirms.push([message, options]); return false; } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { settings: { editor: { dangerousDeletes: true } }, library: { guides: [{ guideId: 'g1', title: 'Setup' }] } };
  app.refreshLibrary = async () => {};
  await app.deleteGuide('g1');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0][1].danger, true);
  assert.deepEqual(deleted, []);
});
