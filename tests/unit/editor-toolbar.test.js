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
  append(...nodes) { this.children.push(...nodes); }
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
  remove() {}
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
  const zoomButtons = [
    [editor.dom.zoomFitBtn, 'fit', 'Fit'],
    [editor.dom.zoom100Btn, 1, '100%'],
    [editor.dom.zoom125Btn, 1.25, '125%'],
    [editor.dom.zoom150Btn, 1.5, '150%'],
  ];
  for (const [node, mode, label] of zoomButtons) {
    const on = mode === zoom;
    assert.equal(node.classList.contains('active'), on, `zoom ${label} active class`);
    assert.equal(node.getAttribute('aria-pressed'), String(on), `zoom ${label} aria-pressed`);
  }
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

test('zoom shortcuts never leave a stale preset highlighted at a custom zoom', async () => {
  const editor = makeEditor(GUIDES);
  await editor.open('g1');
  editor.applyZoomShortcut('in');
  assertToolbar(editor, { tool: 'select', zoom: 1.25 });
  editor.applyZoomShortcut('in');
  assertToolbar(editor, { tool: 'select', zoom: 1.5 });
  editor.applyZoomShortcut('in');
  assertToolbar(editor, { tool: 'select', zoom: 1.75 });
  editor.applyZoomShortcut('fit');
  assertToolbar(editor, { tool: 'select', zoom: 'fit' });
});
