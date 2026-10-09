'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Settings } = require('../../core/settings');
const { makeTmpDir, rmrf } = require('./helpers');

function editorContext({ api = {}, dialogs = {} } = {}) {
  const context = { window: { stepforge: api, StepForgeDialogs: dialogs } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  const step = { stepId: 's1', title: 'Click Save' };
  editor.steps = [step];
  editor.stepMap = new Map([['s1', step]]);
  editor.selectedStepId = 's1';
  editor.onToast = () => {};
  editor.onMetaChange = () => {};
  return { editor };
}

const WRITE_ACTIONS = ['Write the whole guide', 'Write the whole step', 'Write the title', 'Write the description', 'Write the blocks'];
const actionItems = (items) => items.filter((item) => item !== 'sep' && WRITE_ACTIONS.includes(item.label));

test('the AI menu lists every writing action, usable only while AI is on', () => {
  const { editor } = editorContext();
  for (const enabled of [false, true, false]) {
    editor.setSettings({ ai: { enabled } });
    const items = editor.aiMenuItems();
    assert.deepEqual([...actionItems(items).map((item) => item.label)], WRITE_ACTIONS);
    assert.ok(actionItems(items).every((item) => item.disabled === !enabled));
    assert.equal(items.some((item) => item.label === 'Turn on AI in Settings…'), !enabled);
  }
  // Whole guide and whole step come first, then a divider, then single fields.
  editor.setSettings({ ai: { enabled: true } });
  assert.deepEqual([...editor.aiMenuItems().map((item) => (item === 'sep' ? 'sep' : item.label))],
    [...WRITE_ACTIONS.slice(0, 2), 'sep', ...WRITE_ACTIONS.slice(2)]);
});

test('step actions are unavailable without a selected step; a running write offers Stop instead', () => {
  const { editor } = editorContext();
  editor.setSettings({ ai: { enabled: true } });
  editor.selectedStepId = null;
  const items = actionItems(editor.aiMenuItems());
  assert.equal(items.find((item) => item.label === 'Write the whole guide').disabled, false);
  assert.ok(items.filter((item) => item.label !== 'Write the whole guide').every((item) => item.disabled));

  editor.aiRun = { cancelled: false, progress: '3/12' };
  assert.deepEqual([...editor.aiMenuItems().map((item) => item.label)], ['Stop writing']);
  assert.equal(editor.aiProgressLabel(), '3/12');
});

test('Turn on AI in Settings opens the AI section and the menu follows the saved choice', async () => {
  let settings = { ai: { enabled: false } };
  let openedSection = null;
  const { editor } = editorContext({
    api: { settings: { all: async () => settings, globalPlaceholders: async () => ({}) } },
    dialogs: { showSettingsDialog: async ({ section }) => { openedSection = section; settings = { ai: { enabled: true } }; } },
  });
  editor.setSettings(settings);
  await editor.aiMenuItems().find((item) => item.label === 'Turn on AI in Settings…').action();
  assert.equal(openedSection, 'ai');
  assert.ok(actionItems(editor.aiMenuItems()).every((item) => !item.disabled));
});

test('focus defaults are enabled but explicit saved choices remain disabled', t => {
  const dir = makeTmpDir('focus-defaults');
  t.after(() => rmrf(dir));
  const settings = new Settings(dir);
  assert.equal(settings.get('capture.smartCropping'), true);
  assert.equal(settings.get('editor.focusedViewDefaultForNewSteps'), true);
  settings.set('capture.smartCropping', false);
  settings.set('editor.focusedViewDefaultForNewSteps', false);
  const loaded = new Settings(dir);
  assert.equal(loaded.get('capture.smartCropping'), false);
  assert.equal(loaded.get('editor.focusedViewDefaultForNewSteps'), false);
});

test('AI ▾ sits right before More ▾, asks the editor for its menu, and shows progress while writing', () => {
  let items;
  const context = {
    window: {}, document: { addEventListener() {} }, clearNode: node => { node.children = []; },
    el: (selector, attrs, ...children) => ({ selector, ...attrs, children }),
    contextMenu: (x, y, next) => { items = next; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { view: 'editor' };
  app.topbarContext = { children: [], append(...nodes) { this.children.push(...nodes); } };
  const aiItems = [{ label: 'Write the whole guide', action() {} }];
  app.editor = { aiMenuItems: () => aiItems };
  app.renderTopbar();
  const labels = app.topbarContext.children.map((node) => node.children?.[0]);
  const aiIndex = labels.indexOf('AI ▾');
  assert.ok(aiIndex >= 0, 'expected an AI ▾ button');
  assert.equal(labels[aiIndex + 1], 'More ▾');
  const event = { currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) }, target: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } };
  app.topbarContext.children[aiIndex].onClick(event);
  assert.equal(items, aiItems);
  // The More menu no longer carries AI actions.
  app.topbarContext.children[aiIndex + 1].onClick(event);
  assert.ok(!items.some((item) => typeof item === 'object' && /AI/.test(item.label)));

  app.editorMeta = { aiProgress: '4/9' };
  app.topbarContext.children = [];
  app.renderTopbar();
  const busy = app.topbarContext.children.find((node) => node.children?.[0] === 'AI · 4/9');
  assert.ok(busy, 'expected the AI button to show progress');
  assert.equal(busy.className, 'ai-busy');
});
