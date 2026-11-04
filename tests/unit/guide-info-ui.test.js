'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

function ui() {
  function el(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split('.');
    const node = {
      tag, hidden: false, disabled: false, children: [], classes: new Set(classes), dataset: {}, style: {},
      classList: { add() {}, remove() {}, contains: (c) => node.classes.has(c), toggle() {} },
      get firstChild() { return this.children[0]; },
      removeChild(child) { this.children = this.children.filter(n => n !== child); },
      get textContent() { return this._text ?? this.children.map((c) => (typeof c === 'object' ? c.textContent : String(c))).join(''); },
      set textContent(value) { this.children = []; this._text = String(value); },
      append(...items) {
        this._text = undefined;
        for (const child of items.flat()) {
          if (child == null || child === false) continue;
          this.children.push(child);
          if (typeof child === 'object') child.parent = this;
        }
      },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); },
      addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      focus() {},
    };
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node[key] = value;
    }
    node.append(...children);
    if (tag === 'select') node.value = node.children.find((c) => c.selected)?.value ?? node.children[0]?.value;
    if (tag === 'textarea') node.value = node.textContent;
    return node;
  }
  const root = el('div');
  const context = { ...rendererI18n(),
    document: { activeElement: null, getElementById: () => root, addEventListener() {}, removeEventListener() {} },
    window: { StepForgeReview: require('../../core/review'), addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  load('util.js');
  context.el = el;
  load('quality.js');
  load('dialogs.js');
  const visible = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };
  const all = (node, out = []) => {
    if (node && typeof node === 'object') { out.push(node); for (const child of node.children) all(child, out); }
    return out;
  };
  return { context, root, visible, all };
}

test('offline Guide information hides cloud controls and preserves existing metadata and sharing', async () => {
  const u = ui(); let saved;
  const done = u.context.window.StepForgeDialogs.showGuideInfoDialog({
    values: { description: 'Keep **Markdown**', sharingEnabled: false }, onSave: async value => { saved = value; },
  });
  const cloud = u.all(u.root).find(n => n.classes?.has('guide-info-cloud'));
  assert.equal(cloud.hidden, true);
  const footer = u.all(u.root).find(n => n.tag === 'footer');
  assert.deepEqual(u.all(footer).filter(n => n.tag === 'button').map(n => n.textContent), ['Cancel', 'Save']);
  await u.all(footer).find(n => n.textContent === 'Save').listeners.click();
  assert.equal(await done, true);
  assert.equal(saved.sharingEnabled, false);
  assert.equal(saved.description, 'Keep **Markdown**');
});

test('description guidance follows its label and describes the textarea with full Markdown examples', () => {
  const u = ui();
  u.context.window.StepForgeDialogs.showGuideInfoDialog();
  const row = u.all(u.root).find(n => n.classes?.has('guide-description'));
  const [label, help, input] = row.children;
  assert.equal(label.htmlFor, input.id);
  assert.equal(input['aria-describedby'], help.id);
  assert.match(help.textContent, /first page of the PDF/);
  assert.match(help.textContent, /\*\*bold\*\*, \*italic\*, `code`, \[link\]/);
  assert.match(help.textContent, /lists that start with - or 1\./);
  assert.equal(input.tag, 'textarea');
});

test('connected cloud actions are outside the footer and successful removal cannot be undone by Save', async () => {
  for (const removed of [false, true, { sharingEnabled: false }]) {
    const u = ui(); let saved; let history = 0;
    u.context.window.StepForgeDialogs.showGuideInfoDialog({ cloudConnected: true,
      values: { sharingEnabled: true }, onSave: async value => { saved = value; },
      onCloudSnapshots: async () => { history++; }, onDeleteCloudSnapshots: async () => removed,
    });
    const cloud = u.all(u.root).find(n => n.classes?.has('guide-info-cloud'));
    assert.equal(cloud.hidden, false);
    await u.all(cloud).find(n => n.tag === 'button' && n.textContent === 'Cloud snapshots').listeners.click();
    assert.equal(history, 1);
    await u.all(cloud).find(n => n.tag === 'button' && n.textContent === 'Remove cloud copies').listeners.click();
    const footer = u.all(u.root).find(n => n.tag === 'footer');
    assert.deepEqual(u.all(footer).filter(n => n.tag === 'button').map(n => n.textContent), ['Cancel', 'Save']);
    await u.all(footer).find(n => n.tag === 'button' && n.textContent === 'Save').listeners.click();
    assert.equal(saved.sharingEnabled, removed === false);
  }
});

test('partial cloud removal reports the persisted opt-out state back to the dialog', async () => {
  let shown;
  const context = { ...rendererI18n(), confirmDialog: async () => true, window: {
    stepforge: {
      guide: { descriptionToMarkdown: async () => '', get: async () => ({ guide: { cloud: { sharingEnabled: false } } }) },
      cloud: { status: async () => ({ connected: true, provider: 'google' }), deleteGuideSnapshots: async () => { throw Error('Transfer interrupted'); } },
    },
    StepForgeDialogs: { showGuideInfoDialog: async options => { shown = options; } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  editor.guideId = 'g'; editor.guide = { metadata: {}, cloud: { sharingEnabled: true } }; editor.onToast = () => {};
  await editor.openGuideInfo();
  const result = await shown.onDeleteCloudSnapshots();
  assert.equal(result.sharingEnabled, false);
  assert.equal(editor.guide.cloud.sharingEnabled, false);
});

test('Guide information only offers cloud actions for a connected compatible active provider', async () => {
  for (const [status, expected] of [
    ...['google', 'onedrive', 'dropbox', 'webdav'].map(provider => [{ provider, connected: true }, true]),
    [{ provider: 'google', connected: false }, false], [{ provider: 'github', connected: true }, false],
    [{ provider: 'google', connected: true, providers: { google: { available: false } } }, false], [null, false],
  ]) {
    let shown;
    const context = { ...rendererI18n(), window: {
      stepforge: { guide: { descriptionToMarkdown: async () => 'Description' }, cloud: { status: async () => { if (!status) throw Error('Unavailable'); return status; } } },
      StepForgeDialogs: { showGuideInfoDialog: async options => { shown = options; } },
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
    const editor = Object.create(context.window.GuideEditor.prototype);
    editor.guide = { guideId: 'g', metadata: {}, descriptionHtml: '' };
    await editor.openGuideInfo();
    assert.equal(shown.cloudConnected, expected, JSON.stringify(status));
  }
});
