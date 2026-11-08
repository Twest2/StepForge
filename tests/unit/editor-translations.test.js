'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * The editor in another interface language: the annotation toolbar, the step
 * panel, and the messages about steps all show in that language.
 */

// A stand-in for util.js's el(): a plain tree of tags, props and children.
function fakeEl(spec, props = {}, ...children) {
  const node = {
    spec,
    props: props || {},
    children: children.flat().filter((c) => c != null && c !== false),
    dataset: { ...(props && props.dataset) },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    addEventListener() {},
    setAttribute(name, value) { node.props[name] = value; },
    querySelectorAll: () => [],
    append(...more) { node.children.push(...more); },
    get text() { return node.children.map((c) => (typeof c === 'object' ? c.text : String(c))).join(''); },
  };
  return node;
}

function loadEditor(language, extra = {}) {
  const context = {
    ...rendererI18n(language),
    window: { stepforge: { ai: {} }, StepForgeOutline: require('../../core/step-outline'), StepForgeDialogs: {}, StepForgePaneLayout: require('../../core/editor-layout') },
    document: { activeElement: null },
    el: fakeEl,
    clearNode() {},
    confirmDialog: async () => false,
    setTimeout,
    AnnotationCanvas: class { applyZoom() {} },
    ResizeObserver: class { observe() {} },
    ...extra,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  return context.window.GuideEditor;
}

function mountedEditor(language) {
  const GuideEditor = loadEditor(language);
  const editor = Object.create(GuideEditor.prototype);
  editor.root = { innerHTML: '', append() {} };
  editor.bindShellEvents = () => {};
  editor.mountShell();
  return editor;
}

const TOOLS = ['select', 'rect', 'oval', 'line', 'pen', 'arrow', 'curvedArrow', 'text', 'tooltip', 'number', 'blur', 'highlight', 'magnify', 'cursor', 'spotlight', 'crop'];

test('the annotation toolbar names every tool in the interface language', () => {
  // The tools are icons; each one's name is its name for screen readers, and
  // its tooltip is that name with its key, in the language's own brackets.
  const KEYS = { rect: 'R', oval: 'O', line: 'L', pen: 'P', arrow: 'A', curvedArrow: 'J', text: 'T', tooltip: 'G',
    number: 'N', blur: 'B', highlight: 'H', magnify: 'M', cursor: 'U', spotlight: 'K', crop: 'C' };
  const names = (editor, [open, close] = [' (', ')']) => TOOLS.filter((tool) => tool !== 'select').map((tool) => {
    const { title, 'aria-label': label } = editor.dom[`tool-${tool}`].props;
    assert.equal(title, `${label}${open}${KEYS[tool]}${close}`, tool);
    return label;
  });
  const zh = mountedEditor('zh-CN');
  assert.equal(zh.dom['tool-select'], undefined);
  assert.deepEqual(names(zh, ['（', '）']), ['矩形', '椭圆', '直线', '画笔', '箭头', '曲线箭头', '文本', '提示框', '编号', '模糊', '高亮', '放大镜', '光标', '聚光灯', '裁剪']);
  assert.deepEqual(names(mountedEditor('en')),
    ['Rectangle', 'Oval', 'Line', 'Pen', 'Arrow', 'Curved arrow', 'Text', 'Tooltip', 'Number', 'Blur', 'Highlight', 'Magnify', 'Cursor', 'Spotlight', 'Crop']);
});

test('the step panel’s checkboxes and description toolbar are translated', () => {
  const ja = mountedEditor('ja');
  assert.deepEqual([ja.dom.hiddenToggle, ja.dom.skippedToggle, ja.dom.forceNewPageToggle, ja.dom.focusedViewToggle].map((n) => n.text.trim()),
    ['非表示', 'スキップ', '改ページ', 'フォーカス表示']);
  assert.deepEqual(ja.dom.richToolbar.children.map((n) => n.text), ['太字', '斜体', '箇条書き', '番号付きリスト', '引用', 'リンク', 'クリア', 'ステップ']);
});

test('deleting a step asks in the interface language, with the step’s name', async () => {
  const asked = [];
  const confirmDialog = async (message) => { asked.push(message); return false; };
  for (const [language, expected] of [['zh-CN', '删除“node”？'], ['fr', 'Supprimer « node » ?'], ['en', 'Delete “node”?']]) {
    const editor = Object.create(loadEditor(language, { confirmDialog }).prototype);
    editor.stepMap = new Map([['s1', { stepId: 's1', title: 'node' }]]);
    editor.selectedStepId = 's1';
    asked.length = 0;
    await editor.deleteSelectedStep();
    assert.deepEqual(asked, [expected]);
  }
  // A step without a title is named in the language too.
  const editor = Object.create(loadEditor('zh-CN', { confirmDialog }).prototype);
  editor.stepMap = new Map([['s1', { stepId: 's1', title: '' }]]);
  editor.selectedStepId = 's1';
  asked.length = 0;
  await editor.deleteSelectedStep();
  assert.deepEqual(asked, ['删除“未命名步骤”？']);
});

test('deleting several steps counts them with the language’s plural forms', async () => {
  const asked = [];
  const GuideEditor = loadEditor('ru', { confirmDialog: async (message) => { asked.push(message); return false; } });
  for (const n of [1, 3, 5]) {
    const editor = Object.create(GuideEditor.prototype);
    editor.selectedSteps = new Set(Array.from({ length: n }, (_, i) => `s${i}`));
    await editor.deleteSelectedSteps();
  }
  assert.deepEqual(asked, ['Удалить 1 шаг?', 'Удалить 3 шага?', 'Удалить 5 шагов?']);
});
