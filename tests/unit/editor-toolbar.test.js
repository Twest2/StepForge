'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * The editor's canvas toolbar: which tool and zoom buttons look pressed, and
 * whether assistive tech sees the same state (aria-pressed).
 *
 * The editor mounts into a minimal fake DOM. Nodes keep their classes,
 * attributes and listeners, which is all the toolbar code reads.
 */
class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { names.forEach((n) => this.names.add(n)); }
  remove(...names) { names.forEach((n) => this.names.delete(n)); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name); else this.names.delete(name);
    return on;
  }
  contains(name) { return this.names.has(name); }
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.nodeType = 1; // el() keeps element children only when they look like nodes
    this.classList = new FakeClassList();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.textContent = '';
    this.innerHTML = '';
  }
  append(...nodes) { nodes.forEach((n) => { n.parent = this; }); this.children.push(...nodes); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return new FakeNode('input'); }
  querySelectorAll() { return []; }
  contains() { return false; }
  focus() {}
  blur() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
}

// A 2D context that accepts every drawing call, so the canvas renders headlessly.
function fakeContext() {
  const fn = () => proxy;
  const proxy = new Proxy(fn, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
  });
  return proxy;
}

function fakeDocument() {
  return {
    activeElement: null,
    createElement(tag) {
      const node = new FakeNode(tag);
      if (tag === 'canvas') {
        node.parentElement = { clientWidth: 1040, clientHeight: 840 };
        node.getContext = () => fakeContext();
        node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
      }
      return node;
    },
    createTextNode: (text) => ({ nodeType: 3, text: String(text) }),
    addEventListener() {},
    removeEventListener() {},
  };
}

function loadEditorClass(api) {
  const context = {
    ...rendererI18n(),
    document: fakeDocument(),
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
  };
  // The renderer scripts are plain browser scripts: window is the global, so
  // their bare references (AnnotationCanvas, debounce) resolve.
  context.window = context;
  context.stepforge = api;
  for (const file of ['util.js', 'canvas.js', 'editor.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  }
  return context.window.GuideEditor;
}

/** An editor opened on guides that have no steps, served from an in-memory store. */
function makeEditor(guides) {
  const json = (value) => JSON.parse(JSON.stringify(value));
  const api = {
    guide: {
      get: async ({ guideId }) => ({ guide: json(guides[guideId]), steps: [] }),
    },
    ai: { cancel: async () => {} },
  };
  const GuideEditor = loadEditorClass(api);
  const editor = new GuideEditor({ root: new FakeNode('div') });
  // The panels other than the canvas toolbar are not under test.
  Object.assign(editor, {
    renderStepList() {}, syncStepFields() {}, syncFocusedControls() {},
    renderAnnotationPanel() {}, renderBlocksPanel() {}, emitMeta() {},
  });
  return editor;
}

const TOOLS = ['select', 'rect', 'oval', 'line', 'arrow', 'text', 'tooltip', 'number', 'blur', 'highlight', 'magnify', 'cursor', 'crop'];

// Checks every tool and zoom button: pressed (class and aria-pressed) exactly when it matches the editor state.
function assertToolbar(editor, { tool, zoom }) {
  const toolNodes = TOOLS.map((name) => editor.dom[`tool-${name}`]).filter(Boolean);
  assert.ok(toolNodes.length >= 2, 'the tool buttons are in the toolbar');
  for (const node of toolNodes) {
    const on = node.dataset.tool === tool;
    assert.equal(node.classList.contains('active'), on, `tool ${node.dataset.tool} active class`);
    assert.equal(node.getAttribute('aria-pressed'), String(on), `tool ${node.dataset.tool} aria-pressed`);
  }
  // The zoom menu shows the zoom: 'fit', or a number for a fixed zoom.
  assert.equal(editor.dom.zoomSelect.value, zoom === 'fit' ? 'fit' : String(zoom), 'zoom select shows the zoom');
}

const GUIDES = {
  g1: { guideId: 'g1', title: 'First', stepsOrder: [] },
  g2: { guideId: 'g2', title: 'Second', stepsOrder: [] },
};

test('when the editor mounts, Select and Fit are highlighted and announced as pressed', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  assert.equal(editor.currentTool, 'select');
  assert.equal(editor.currentZoom, 'fit');
  assertToolbar(editor, { tool: 'select', zoom: 'fit' });
});

test('clicking a tool or a zoom moves the highlight and keeps aria-pressed in step', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  editor.setTool('rect');
  editor.setZoom(1.25);
  assertToolbar(editor, { tool: 'rect', zoom: 1.25 });
  editor.setTool('select');
  editor.setZoom(1);
  assertToolbar(editor, { tool: 'select', zoom: 1 });
});

test('after a guide reload, the toolbar shows the editor state, not the last button clicked', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  editor.setTool('blur');
  editor.setZoom(1.5);
  assertToolbar(editor, { tool: 'blur', zoom: 1.5 });

  // Switching guides keeps the editor's tool and zoom, and the buttons agree.
  await editor.open('g2');
  assert.equal(editor.currentTool, 'blur');
  assert.equal(editor.currentZoom, 1.5);
  assertToolbar(editor, { tool: 'blur', zoom: 1.5 });

  // State set directly, as the canvas does on load, is shown on reload too.
  editor.currentTool = 'select';
  editor.currentZoom = 'fit';
  await editor.reload();
  assertToolbar(editor, { tool: 'select', zoom: 'fit' });
});

test('every tool button has an icon and a name in its title and aria-label, with no shortcut text', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  const names = {
    select: 'Select', rect: 'Rectangle', oval: 'Oval', line: 'Line', arrow: 'Arrow', text: 'Text',
    tooltip: 'Tooltip', number: 'Number', blur: 'Blur', highlight: 'Highlight', magnify: 'Magnify',
    cursor: 'Cursor', crop: 'Crop',
  };
  for (const [tool, name] of Object.entries(names)) {
    const node = editor.dom[`tool-${tool}`];
    assert.ok(node, `${tool} button exists`);
    assert.equal(node.getAttribute('aria-label'), name, `${tool} aria-label`);
    assert.equal(node.getAttribute('title'), name, `${tool} title`);
    assert.match(node.innerHTML, /^<svg [^>]*stroke="currentColor"/, `${tool} has an inline svg icon`);
    assert.doesNotMatch(node.getAttribute('title'), /\(|Ctrl|Shift|Alt|\b[A-Z]\)$/, `${tool} tooltip has no shortcut hint`);
    assert.equal(node.textContent, '', `${tool} shows no text, only the icon`);
  }
  for (const [node, name] of [[editor.dom.undoBtn, 'Undo'], [editor.dom.redoBtn, 'Redo']]) {
    assert.equal(node.getAttribute('aria-label'), name);
    assert.equal(node.getAttribute('title'), name);
    assert.match(node.innerHTML, /^<svg /);
  }
});

test('the zoom select lists Fit and fixed zooms, and setZoom and the select stay in step', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  const select = editor.dom.zoomSelect;
  assert.equal(select.getAttribute('aria-label'), 'Zoom');
  assert.deepEqual(select.children.map((o) => o.value), ['fit', '1', '1.25', '1.5']);
  assert.equal(select.value, 'fit', 'Fit is shown by default');

  // Setting the zoom in code moves the select.
  editor.setZoom(1.25);
  assert.equal(select.value, '1.25');
  editor.setZoom('fit');
  assert.equal(select.value, 'fit');

  // Choosing an option fires setZoom, as the user's change does.
  const fire = (value) => {
    select.value = value;
    for (const listener of select.listeners.change || []) listener();
  };
  fire('1.5');
  assert.equal(editor.currentZoom, 1.5);
  assert.equal(editor.canvas.zoomMode, 1.5);
  assertToolbar(editor, { tool: 'select', zoom: 1.5 });
  fire('1');
  assert.equal(editor.currentZoom, 1);
  fire('fit');
  assert.equal(editor.currentZoom, 'fit');
});

test('a zoom set by the keyboard that is not in the list still shows in the select', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  editor.applyZoomShortcut('in');
  assert.equal(editor.currentZoom, 1.25, 'Ctrl+= from Fit goes to 125%');
  editor.applyZoomShortcut('in');
  editor.applyZoomShortcut('in');
  assert.equal(editor.currentZoom, 1.75);
  assert.equal(editor.dom.zoomSelect.value, '1.75');
  assert.equal(editor.dom.zoomSelect.children.at(-1).children[0].text, '175%', 'the extra option is labelled');
  editor.applyZoomShortcut('fit');
  assert.equal(editor.dom.zoomSelect.value, 'fit');
  assert.equal(editor.dom.zoomSelect.children.filter((o) => o.value === '1.75').length, 0, 'the extra option is removed');
});

test('typing and navigation inside the zoom dropdown cannot change tools or delete annotations', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  editor.selectedAnnotationId = 'selected-annotation';
  editor.canvas.deleteSelected = () => { throw new Error('native select key deleted an annotation'); };
  editor.canvas.nudgeSelected = () => { throw new Error('native select key moved an annotation'); };
  for (const key of ['r', 'ArrowDown', 'ArrowUp', 'PageDown', 'Delete', 'Backspace', 'Escape']) {
    let prevented = false;
    editor.onDocumentKeyDown({ key, target: { tagName: 'SELECT' }, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, `${key} is left to the native dropdown`);
    assert.equal(editor.currentTool, 'select');
    assert.equal(editor.selectedAnnotationId, 'selected-annotation');
  }
  let prevented = false;
  editor.onDocumentKeyDown({ key: '=', ctrlKey: true, target: { tagName: 'SELECT' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'the existing Ctrl+= shortcut still works');
  assert.equal(editor.currentZoom, 1.25);
});
