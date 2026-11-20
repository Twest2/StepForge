'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * Deleting a step doesn't ask first; its toast has an Undo button that does what
 * Ctrl+Z does. Guide deletes still ask. Runs the real toast and confirm dialog
 * (app/renderer/util.js) on a DOM stand-in, and the real editor against an
 * in-memory main process.
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
    // The open confirmation dialog, if any (the toast's Undo button doesn't count): its message and buttons.
    dialog() {
      const nodes = all(root);
      const buttons = nodes.filter((n) => n.spec?.startsWith('button') && n.spec !== 'button.toast-action');
      if (!buttons.length) return null;
      return {
        text: text(root),
        button: (label) => buttons.find((n) => n.children.includes(label)),
      };
    },
    // The toast's Undo button (only the toast has a button with this class).
    toastUndo: () => all(root).find((n) => n.spec === 'button.toast-action'),
    toastText: () => text(root),
  };
}

function setup({ language = 'en' } = {}) {
  const db = {
    order: ['a', 'b', 'c'],
    steps: new Map(['a', 'b', 'c'].map((id) => [id, { stepId: id, title: `Step ${id}`, revision: 1, annotations: [] }])),
  };
  const api = {
    guide: { get: async () => ({ guide: { stepsOrder: db.order }, steps: db.order.map((id) => structuredClone(db.steps.get(id))) }) },
    step: {
      delete: async ({ stepId }) => { db.steps.delete(stepId); db.order = db.order.filter((id) => id !== stepId); },
      restore: async ({ step, position }) => { db.steps.set(step.stepId, structuredClone(step)); db.order.splice(position, 0, step.stepId); },
      reorder: async ({ order }) => { db.order = [...order]; },
    },
  };
  const context = { ...rendererI18n(language), StepForgeLocales: require('../../core/locales'),
    window: { stepforge: api, StepForgeOutline: require('../../core/step-outline') },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout };
  const dom = fakeDom(context);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  context.el = dom.el;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, {
    guideId: 'g1', canvasHistory: [], canvasFuture: [], beforeCanvasSnapshot: null, pendingSave: false,
    steps: [], stepMap: new Map(), selectedSteps: new Set(),
    // The real toast, as app.js wires it.
    onToast: (message, options) => context.toast(message, options),
    renderStepBulkBar() {}, renderAll() {}, saveStepDebounced: { cancel() {} },
    reload: async (stepId) => {
      const { steps } = await api.guide.get();
      editor.steps = steps;
      editor.stepMap = new Map(steps.map((s) => [s.stepId, s]));
      editor.selectedStepId = stepId && editor.stepMap.has(stepId) ? stepId : steps[0]?.stepId;
    },
  });
  editor.settings = {};
  return { editor, db, dom, context };
}

// Let the editor's pending async work and any dialog it opens settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('deleting a step does not ask, and the toast says so with an Undo button', async () => {
  const { editor, db, dom } = setup();
  await editor.reload('b');
  await editor.deleteSelectedStep();
  assert.equal(dom.dialog(), null, 'no confirmation');
  assert.deepEqual(db.order, ['a', 'c']);
  assert.match(dom.toastText(), /1 step deleted\./);
  assert.ok(dom.toastUndo(), 'toast has an Undo button');
  assert.equal(dom.toastUndo().children.includes('Undo'), true);
});

test('Undo on the toast restores the deleted step', async () => {
  const { editor, db, dom } = setup();
  await editor.reload('b');
  await editor.deleteSelectedStep();
  dom.toastUndo().onClick();
  await settle();
  assert.deepEqual(db.order, ['a', 'b', 'c']);
  assert.equal(db.steps.get('b').title, 'Step b');
});

test('Undo on the toast does nothing once another change has been made', async () => {
  const { editor, db, dom } = setup();
  await editor.reload('b');
  await editor.deleteSelectedStep();
  editor.pushCanvasHistory({ type: 'other-change' });
  dom.toastUndo().onClick();
  await settle();
  assert.deepEqual(db.order, ['a', 'c']);
});

test('deleting several selected steps does not ask, and one Undo restores them all', async () => {
  const { editor, db, dom } = setup();
  await editor.reload('a');
  editor.selectedSteps = new Set(['a', 'c']);
  await editor.deleteSelectedSteps();
  assert.equal(dom.dialog(), null, 'no confirmation');
  assert.deepEqual(db.order, ['b']);
  assert.match(dom.toastText(), /2 steps deleted\./);
  dom.toastUndo().onClick();
  await settle();
  assert.deepEqual(db.order, ['a', 'b', 'c']);
});

test('deleting a guide still asks first, and Cancel keeps it', async () => {
  const confirms = [];
  const deleted = [];
  const api = { library: { delete: async ({ guideId }) => deleted.push(guideId) } };
  const context = { ...rendererI18n(), window: { stepforge: api }, document: { addEventListener() {} },
    confirmDialog: async (message, options) => { confirms.push([message, options]); return false; } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { settings: {}, library: { guides: [{ guideId: 'g1', title: 'Setup' }] } };
  app.refreshLibrary = async () => {};
  await app.deleteGuide('g1');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0][1].danger, true);
  assert.deepEqual(deleted, []);
});
