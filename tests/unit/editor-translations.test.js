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
  // The description toolbar is icons: each button's name and tooltip are in the language.
  assert.deepEqual(ja.dom.richToolbar.children.map((n) => n.props['aria-label']), ['太字', '斜体', '箇条書き', '番号付きリスト', '引用', 'リンク', 'クリア', 'ステップへのリンク']);
  assert.ok(ja.dom.richToolbar.children.every((n) => n.props.title && /<svg/.test(n.props.innerHTML)));
});

test('the delete toast is translated, with plural forms and its Undo button', () => {
  const cases = [
    ['zh-CN', 1, '已删除 1 个步骤。', '撤消'],
    ['fr', 1, '1 étape supprimée.', 'Annuler'],
    ['ru', 1, 'Удалён 1 шаг.', 'Отменить'],
    ['ru', 3, 'Удалено 3 шага.', 'Отменить'],
    ['ru', 5, 'Удалено 5 шагов.', 'Отменить'],
    ['en', 2, '2 steps deleted.', 'Undo'],
  ];
  for (const [language, count, expected, undo] of cases) {
    const toasts = [];
    const editor = Object.create(loadEditor(language).prototype);
    editor.onToast = (message, options) => toasts.push({ message, options });
    editor.toastStepsDeleted(count, { type: 'delete-step' });
    assert.equal(toasts[0].message, expected, `${language} ${count}`);
    assert.equal(toasts[0].options.action.label, undo, `${language} Undo label`);
  }
});
