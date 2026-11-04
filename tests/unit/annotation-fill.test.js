'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const raster = require('../../core/raster');
const { normalizeAnnotation } = require('../../core/schema');
const { rendererI18n } = require('./helpers');

/**
 * The Fill picker in the annotation style panel (app/renderer/editor.js) in a
 * small DOM stand-in: a filled rectangle or oval can go back to Transparent,
 * presets and Custom color… apply with undo, the popover works from the
 * keyboard, and an empty fill survives Apply to all, a save and an export.
 */

function makeDom() {
  const document = {
    activeElement: null,
    listeners: [],
    addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn); },
    dispatch(type, event) { for (const l of [...this.listeners]) if (l.type === type) l.fn(event); },
  };
  function node(tag) {
    const classes = new Set();
    const attrs = {};
    const listeners = {};
    return {
      tag, children: [], parent: null, style: {}, dataset: {}, value: '', hidden: false, tabIndex: 0, title: '', type: '',
      clicked: 0,
      classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
      get className() { return [...classes].join(' '); },
      set className(value) { for (const c of String(value).split(/\s+/)) if (c) classes.add(c); },
      setAttribute(name, value) { attrs[name] = String(value); },
      getAttribute(name) { return name in attrs ? attrs[name] : null; },
      get textContent() { return this.children.map((c) => (typeof c === 'object' ? c.textContent : String(c))).join(''); },
      get isConnected() { let n = this; while (n.parent) n = n.parent; return Boolean(n.root); },
      append(...items) {
        for (const child of items.flat()) {
          if (child == null || child === false) continue;
          this.children.push(child);
          if (typeof child === 'object') child.parent = this;
        }
      },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },
      closest(selector) { for (let n = this; n; n = n.parent) if (n.classList.contains(selector.slice(1))) return n; return null; },
      querySelectorAll(selector) {
        const [, name, prefix] = /^\[([\w-]+)\^="([^"]*)"\]$/.exec(selector);
        return all(this).filter((n) => n !== this && (n.getAttribute(name) || '').startsWith(prefix));
      },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, event = {}) {
        const full = { key: '', preventDefault() {}, stopPropagation() {}, target: this, ...event };
        for (const fn of listeners[type] || []) fn(full);
        return full;
      },
      focus() { document.activeElement = this; },
      scrollIntoView() {},
      click() { this.clicked += 1; this.dispatch('click'); },
    };
  }
  function el(spec, props = {}, ...children) {
    const [tag, ...rest] = spec.split(/(?=[.#])/);
    const n = node(tag || 'div');
    for (const part of rest) if (part.startsWith('.')) n.classList.add(part.slice(1));
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith('on') && typeof value === 'function') n.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'style') Object.assign(n.style, value);
      else if (key in n) n[key] = value;
      else n.setAttribute(key, value);
    }
    n.append(...children);
    return n;
  }
  return { document, el, clearNode: (n) => { n.children = []; } };
}

const all = (n, out = []) => {
  if (n && typeof n === 'object') { out.push(n); for (const child of n.children) all(child, out); }
  return out;
};

function setup(annotations, { brandColors = null } = {}) {
  const dom = makeDom();
  const saved = [];
  const context = {
    ...rendererI18n(),
    window: { stepforge: { settings: { set: async () => ({}) }, step: { save: async ({ step }) => { saved.push(JSON.parse(JSON.stringify(step))); return step; } } }, StepForgeDialogs: {}, StepForgeAnnotationProperties: require('../../core/annotation-properties') },
    document: dom.document,
    el: dom.el,
    clearNode: dom.clearNode,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  const steps = [
    { stepId: 's1', annotations: JSON.parse(JSON.stringify(annotations)) },
    { stepId: 's2', annotations: [{ id: 'other', type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, style: { stroke: '#000000', fill: '#00FF00' } }] },
  ];
  const canvasAnnotations = JSON.parse(JSON.stringify(steps[0].annotations));
  const history = [];
  const toasts = [];
  const panelRoot = dom.el('div');
  panelRoot.root = true;
  const annotationEditor = dom.el('div');
  panelRoot.append(annotationEditor);
  Object.assign(editor, {
    guideId: 'g1',
    selectedStepId: 's1',
    selectedAnnotationId: canvasAnnotations[0].id,
    steps,
    stepMap: new Map(steps.map((s) => [s.stepId, s])),
    brandColors,
    dom: { annotationList: dom.el('div'), annotationEditor },
    canvas: { annotations: canvasAnnotations, selected: () => canvasAnnotations[0], render() {} },
    pushCanvasHistory: (record) => history.push(typeof record === 'string' ? { label: record, fill: steps[0].annotations[0].style.fill } : record),
    saveStepDebounced() {},
    emitMeta() {},
    onToast: (text) => toasts.push(text),
    flushStep: async (step) => step,
    reload: async () => {},
  });
  editor.renderAnnotationPanel();
  const picker = (label = 'Fill') => {
    const row = annotationEditor.children[0].children.find((r) => r.children[0] && r.children[0].textContent === label);
    const wrapper = row.children[1];
    const [swatch, popover, custom] = wrapper.children;
    return { wrapper, swatch, popover, custom };
  };
  const entries = () => picker().popover.querySelectorAll('[role^="menuitem"]');
  const entry = (label) => entries().find((n) => n.textContent === label || n.getAttribute('aria-label') === label);
  return { editor, api: context.window.stepforge, steps, history, toasts, saved, document: dom.document, picker, entries, entry, fill: () => steps[0].annotations[0].style.fill };
}

const rect = (fill, type = 'rect') => ({ id: 'a1', type, x: 0.1, y: 0.1, w: 0.8, h: 0.8, style: { stroke: '#FF0000', strokeWidth: 2, fill } });

test('the Fill swatch names the current fill, and Transparent when the shape is empty', () => {
  for (const type of ['rect', 'oval']) {
    const { swatch, popover } = setup([rect('#ffd60a', type)]).picker();
    assert.equal(swatch.textContent, '#FFD60A');
    assert.equal(swatch.getAttribute('aria-label'), 'Fill: #FFD60A');
    assert.equal(swatch.getAttribute('aria-haspopup'), 'menu');
    assert.equal(swatch.getAttribute('aria-expanded'), 'false');
    assert.equal(popover.hidden, true);
    for (const fill of ['transparent', undefined, '']) {
      assert.equal(setup([rect(fill, type)]).picker().swatch.textContent, 'Transparent', `${type} with fill ${fill}`);
    }
  }
});

test('Stroke shares the grouped picker, preserves Fill, records undo and remembers choices', async () => {
  const ui = setup([rect('#ffd60a')]);
  const picker = ui.picker('Stroke');
  assert.equal(picker.swatch.getAttribute('aria-label'), 'Stroke: #FF0000');
  picker.swatch.click();
  const choices = picker.popover.querySelectorAll('[role^="menuitem"]');
  assert.equal(choices.some(n => n.textContent === 'Transparent'), false);
  choices.find(n => n.getAttribute('aria-label') === '#1F6FEB').click();
  await ui.editor.colorSave;
  assert.equal(ui.steps[0].annotations[0].style.stroke, '#1F6FEB');
  assert.equal(ui.fill(), '#ffd60a');
  assert.equal(ui.history.at(-1).label, 'annotation-stroke');
  assert.deepEqual(Array.from(ui.editor.settings.editor.recentColors), ['#1F6FEB']);
});

test('the popover lists Transparent first, then presets with the current color, then Custom color…', () => {
  const ui = setup([rect('#ffd60a')]);
  ui.picker().swatch.click();
  const { swatch, popover } = ui.picker();
  assert.equal(popover.hidden, false);
  assert.equal(swatch.getAttribute('aria-expanded'), 'true');
  assert.equal(popover.getAttribute('role'), 'menu');
  const labels = ui.entries().map((n) => n.getAttribute('aria-label') || n.textContent);
  assert.deepEqual(labels, ['Transparent', '#FFE066', '#E5484D', '#1F6FEB', '#10B981', '#111827', '#FFFFFF', '#FFD60A', 'Custom color…']);
  // The current fill is the checked entry, and it gets the focus.
  assert.equal(ui.entry('#FFD60A').getAttribute('aria-checked'), 'true');
  assert.equal(ui.entry('Transparent').getAttribute('aria-checked'), 'false');
  assert.equal(ui.document.activeElement, ui.entry('#FFD60A'));
});

test('Transparent empties a filled shape at once, as one undo step, and closes the popover', () => {
  const ui = setup([rect('#ffd60a')]);
  ui.picker().swatch.click();
  ui.entry('Transparent').click();
  assert.equal(ui.fill(), 'transparent');
  assert.equal(ui.steps[0].annotations[0].style.stroke, '#FF0000');
  assert.deepEqual(ui.history, [{ label: 'annotation-fill', fill: '#ffd60a' }]);
  const { swatch, popover } = ui.picker();
  assert.equal(popover.hidden, true);
  assert.equal(swatch.textContent, 'Transparent');
  assert.equal(ui.document.activeElement, swatch);
  // The color it replaced is still offered, so it is one click to get back.
  swatch.click();
  assert.ok(ui.entry('#FFD60A'));
  assert.equal(ui.entry('Transparent').getAttribute('aria-checked'), 'true');
  ui.entry('#FFD60A').click();
  assert.equal(ui.fill(), '#FFD60A');
  assert.equal(ui.history.length, 2);
});

test('brand colors supplement the default palette without duplicates', () => {
  const ui = setup([rect('transparent')], { brandColors: ['#0A2540', '#635BFF', '#0a2540'] });
  ui.picker().swatch.click();
  assert.deepEqual(ui.entries().map((n) => n.getAttribute('aria-label') || n.textContent),
    ['Transparent', '#FFE066', '#E5484D', '#1F6FEB', '#10B981', '#111827', '#FFFFFF', '#0A2540', '#635BFF', 'Custom color…']);
  ui.entry('#635BFF').click();
  assert.equal(ui.fill(), '#635BFF');
});

test('the brand colors come from the active profile, and its annotation colors when it sets them', async () => {
  const ui = setup([rect('transparent')]);
  const profile = (custom) => ({
    id: 'brand-1', colors: { primary: '#0A2540', accent: '#635BFF', text: '#18212B' },
    annotations: { custom, shapes: '#E5484D', numbers: '#1F6FEB', tooltips: '#111827' },
  });
  const load = async (list, activeProfileId = 'brand-1') => {
    ui.editor.settings = { branding: { activeProfileId } };
    api.branding = { list: async () => list };
    await ui.editor.loadBrandAnnotations();
    return ui.editor.brandColors && [...ui.editor.brandColors];
  };
  const api = ui.api;
  assert.deepEqual(await load([profile(false)]), ['#0A2540', '#635BFF', '#18212B']);
  assert.deepEqual(await load([profile(true)]), ['#0A2540', '#635BFF', '#18212B', '#E5484D', '#1F6FEB', '#111827']);
  assert.equal(await load([profile(true)], null), null, 'no active profile: StepForge’s own presets');
});

test('Custom color… opens the system picker; its live changes make one undo step', () => {
  const ui = setup([rect('#ffd60a')]);
  ui.picker().swatch.click();
  ui.entry('Custom color…').click();
  const { custom, popover, swatch } = ui.picker();
  assert.equal(popover.hidden, true);
  assert.equal(custom.clicked, 1);
  assert.equal(custom.value, '#ffd60a');
  assert.equal(custom.getAttribute('aria-hidden'), 'true');
  for (const value of ['#112233', '#223344', '#334455']) {
    custom.value = value;
    custom.dispatch('input');
  }
  custom.dispatch('change');
  assert.equal(ui.fill(), '#334455');
  assert.equal(swatch.textContent, '#334455'.toUpperCase());
  assert.deepEqual(ui.history, [{ label: 'annotation-fill', fill: '#ffd60a' }]);
  // A picker that only reports the final color still applies it.
  ui.picker().swatch.click();
  ui.entry('Custom color…').click();
  custom.value = '#abcdef';
  custom.dispatch('change');
  assert.equal(ui.fill(), '#abcdef');
  assert.equal(ui.history.length, 2);
});

test('the popover works from the keyboard and closes on Esc, Tab or a click elsewhere', () => {
  const ui = setup([rect('transparent')]);
  ui.picker().swatch.dispatch('keydown', { key: 'ArrowDown' });
  const { popover, swatch } = ui.picker();
  assert.equal(popover.hidden, false);
  assert.equal(ui.document.activeElement, ui.entry('Transparent'));
  popover.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(ui.document.activeElement, ui.entries()[1]);
  popover.dispatch('keydown', { key: 'End' });
  assert.equal(ui.document.activeElement, ui.entry('Custom color…'));
  popover.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(ui.document.activeElement, ui.entry('Transparent'));
  popover.dispatch('keydown', { key: 'Escape' });
  assert.equal(popover.hidden, true);
  assert.equal(ui.document.activeElement, swatch);

  swatch.click();
  popover.dispatch('keydown', { key: 'Tab' });
  assert.equal(popover.hidden, true);

  swatch.click();
  ui.document.dispatch('pointerdown', { target: swatch.children[0] });
  assert.equal(popover.hidden, false, 'a click inside the picker keeps it open');
  ui.document.dispatch('pointerdown', { target: {} });
  assert.equal(popover.hidden, true);
  assert.equal(ui.document.listeners.length, 0, 'closing removes the outside-click listener');
  assert.equal(ui.fill(), 'transparent', 'closing without a choice changes nothing');
  assert.equal(ui.history.length, 0);
});

test('plain keys in the picker stay in it; Ctrl+Z still undoes', () => {
  const ui = setup([rect('#ffd60a')]);
  const calls = [];
  Object.assign(ui.editor, { active: true, guide: {}, undo: () => calls.push('undo'), setTool: (tool) => calls.push(`tool ${tool}`) });
  Object.assign(ui.editor.canvas, {
    nudgeSelected: () => { calls.push('nudge'); return false; },
    select: () => calls.push('deselect'),
    deleteSelected: () => calls.push('delete'),
  });
  ui.picker().swatch.click();
  for (const key of ['ArrowRight', 'ArrowDown', 'Escape', 'Delete', 'r']) {
    ui.editor.onDocumentKeyDown({ key, preventDefault() {}, target: ui.entry('Transparent') });
    ui.editor.onDocumentKeyDown({ key, preventDefault() {}, target: ui.picker().swatch });
  }
  assert.deepEqual(calls, []);
  ui.editor.onDocumentKeyDown({ key: 'z', ctrlKey: true, preventDefault() {}, target: ui.picker().swatch });
  assert.deepEqual(calls, ['undo']);
});

test('a tooltip gets the same picker without Transparent, since its text sits on the fill', () => {
  const tooltip = { id: 't1', type: 'tooltip', x: 0.1, y: 0.1, w: 0.3, h: 0.1, text: 'Hi', style: { fill: '#111827', stroke: '#111827' } };
  const ui = setup([tooltip]);
  ui.picker().swatch.click();
  assert.equal(ui.entry('Transparent'), undefined);
  assert.equal(ui.entry('#111827').getAttribute('aria-checked'), 'true');
  // An old tooltip saved with no fill shows the color it is drawn with.
  assert.equal(setup([{ ...tooltip, style: { fill: 'transparent' } }]).picker().swatch.textContent, '#1F2937');
});

test('Text color on numbers and tooltips uses the same picker, keeps the other colors and records undo', async () => {
  const number = { id: 'n1', type: 'number', x: 0.1, y: 0.1, w: 0.05, h: 0.05, value: 1, style: { fill: '#1f6feb', stroke: '#1f6feb', textColor: '#ffffff' } };
  const tooltip = { id: 't1', type: 'tooltip', x: 0.1, y: 0.1, w: 0.3, h: 0.1, text: 'Hi', style: { fill: '#111827', stroke: '#111827' } };
  for (const annotation of [number, tooltip]) {
    const ui = setup([annotation]);
    const picker = ui.picker('Text color');
    assert.equal(picker.swatch.getAttribute('aria-label'), 'Text color: #FFFFFF', annotation.type);
    picker.swatch.click();
    assert.equal(picker.popover.querySelectorAll('[role^="menuitem"]').some((n) => n.textContent === 'Transparent'), false);
    picker.popover.querySelectorAll('[role^="menuitem"]').find((n) => n.getAttribute('aria-label') === '#FFE066').click();
    await ui.editor.colorSave;
    const style = ui.steps[0].annotations[0].style;
    assert.equal(style.textColor, '#FFE066');
    assert.equal(style.fill, annotation.style.fill);
    assert.equal(style.stroke, annotation.style.stroke);
    assert.equal(ui.history.at(-1).label, 'annotation-text-color');
  }
});

test('Apply to all carries Transparent to every rectangle in the guide', async () => {
  const ui = setup([rect('#ffd60a')]);
  ui.picker().swatch.click();
  ui.entry('Transparent').click();
  await ui.editor.applyStyleAcross('guide');
  assert.equal(ui.steps[1].annotations[0].style.fill, 'transparent');
  assert.ok(ui.saved.some((step) => step.stepId === 's2' && step.annotations[0].style.fill === 'transparent'));
});

test('a shape set to Transparent is saved and exported with an empty inside', () => {
  const ui = setup([rect('#00ff00')]);
  const white = [255, 255, 255, 255];
  const base = raster.createImage(100, 100, white);
  const inside = (annotation) => {
    const out = raster.renderAnnotations(base, [annotation]);
    const p = (50 * out.width + 50) * 4;
    return [...out.data.slice(p, p + 4)];
  };
  assert.deepEqual(inside(normalizeAnnotation(ui.steps[0].annotations[0])), [0, 255, 0, 255]);
  ui.picker().swatch.click();
  ui.entry('Transparent').click();
  // What a guide file holds after saving and opening it again.
  const reopened = normalizeAnnotation(JSON.parse(JSON.stringify(ui.steps[0].annotations[0])));
  assert.equal(reopened.style.fill, 'transparent');
  assert.deepEqual(inside(reopened), white);
});
