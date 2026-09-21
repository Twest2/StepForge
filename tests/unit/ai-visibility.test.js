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
  const buttons = ['title', 'description', 'block'].map(name => ({ dataset: { aiTitle: `Generate ${name}` } }));
  editor.dom = { titleAiBtn: buttons[0], descAiBtn: buttons[1], blocksList: { querySelectorAll: () => [buttons[2]] } };
  return { editor, buttons };
}

test('all AI buttons hide when disabled and return when enabled without reloading', () => {
  const { editor, buttons } = editorContext();
  for (const enabled of [false, true, false]) {
    editor.setSettings({ ai: { enabled } });
    for (const button of buttons) {
      assert.equal(button.hidden, !enabled);
      assert.equal(button.disabled, !enabled);
      if (enabled) assert.equal(button.title, button.dataset.aiTitle);
    }
  }
});

test('editor quick-action Settings refreshes AI visibility after the dialog closes', async () => {
  let settings = { ai: { enabled: true } };
  const { editor, buttons } = editorContext({
    api: { settings: { all: async () => settings, globalPlaceholders: async () => ({}) } },
    dialogs: { showSettingsDialog: async () => { settings = { ai: { enabled: false } }; } },
  });
  editor.setSettings(settings);
  await editor.openSettings();
  assert.ok(buttons.every(button => button.hidden));
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

test('bulk AI generation follows current settings whenever the More menu opens', () => {
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
  let enabled = false;
  let generated = 0;
  app.editor = { isAiEnabled: () => enabled, generateAllTextFieldsWithAi: () => generated++ };
  app.renderTopbar();
  const menu = app.topbarContext.children.find(node => node.children.includes('More ▾'));
  const event = { target: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } };
  for (const value of [false, true, false]) {
    enabled = value;
    menu.onClick(event);
    const action = items.find(item => item.label?.includes('with AI'));
    assert.equal(Boolean(action), value);
    if (action) action.action();
  }
  assert.equal(generated, 1);
});
