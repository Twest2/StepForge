'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Export → Confluence or Wiki.js recommends Share → Publish instead (#171):
 * the dialog says why and offers a button that closes it and opens the
 * publish dialog. Exporting the file still works.
 */
function ui() {
  function el(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split('.');
    const node = {
      tag, hidden: false, disabled: false, children: [], classes: new Set(classes), dataset: {}, style: {},
      classList: { add() {}, remove() {}, contains: (c) => node.classes.has(c), toggle() {} },
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
    return node;
  }
  const root = el('div');
  const context = {
    document: { activeElement: null, getElementById: () => root, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  load('util.js');
  context.el = el;
  load('dialogs.js');
  const visible = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };
  const all = (node, out = []) => {
    if (node && typeof node === 'object') { out.push(node); for (const child of node.children) all(child, out); }
    return out;
  };
  return { context, root, visible, all };
}

function openExport(u, extra = {}) {
  const published = [];
  const exported = [];
  const done = u.context.window.StepForgeDialogs.showExportDialog({
    formats: [{ id: 'pdf', label: 'PDF' }, { id: 'confluence', label: 'Confluence' }, { id: 'wikijs', label: 'Wiki.js' }],
    defaultFormat: 'pdf',
    onLoadDefaults: async () => ({}),
    onExport: async (payload) => { exported.push(payload.format); return true; },
    publishTargets: { confluence: 'Confluence', wikijs: 'Wiki.js' },
    onPublishInstead: (format) => published.push(format),
    ...extra,
  });
  const modal = u.root.children.at(-1);
  const note = u.all(modal).find((n) => n.classes?.has('export-publish-instead'));
  const format = u.all(modal).find((n) => n.tag === 'select');
  const choose = (value) => { format.value = value; format.listeners.change(); };
  const button = (text) => u.all(modal).find((n) => n.tag === 'button' && u.visible(n) && n.textContent === text);
  return { done, modal, note, choose, button, published, exported };
}

test('Export recommends publishing for Confluence and Wiki.js only', async () => {
  const u = ui();
  const { note, choose, button } = openExport(u);
  assert.equal(u.visible(note), false, 'not shown for PDF');

  choose('confluence');
  assert.equal(u.visible(note), true);
  assert.equal(note.role, 'note');
  assert.match(note.textContent, /^Publishing to Confluence is easier\. Share → Publish to Confluence… creates the page for you/);
  assert.ok(button('Publish to Confluence…'));

  choose('wikijs');
  assert.match(note.textContent, /^Publishing to Wiki\.js is easier\./);
  assert.ok(button('Publish to Wiki.js…'));
  assert.equal(button('Publish to Confluence…'), undefined);

  choose('pdf');
  assert.equal(u.visible(note), false);
});

test('Publish to … closes Export without exporting and hands over the format', async () => {
  const u = ui();
  const { done, choose, button, published, exported } = openExport(u);
  choose('wikijs');
  button('Publish to Wiki.js…').listeners.click();
  assert.equal(await done, false);
  assert.deepEqual(published, ['wikijs']);
  assert.deepEqual(exported, []);
  assert.equal(u.root.children.length, 0, 'the Export dialog closed');
});

test('exporting a Confluence file still works with the note showing', async () => {
  const u = ui();
  const { done, choose, button, published, exported } = openExport(u);
  choose('confluence');
  await button('Export').listeners.click();
  assert.equal(await done, true);
  assert.deepEqual(exported, ['confluence']);
  assert.deepEqual(published, []);
});

test('no note without a way to publish', async () => {
  const u = ui();
  const { note, choose } = openExport(u, { onPublishInstead: undefined });
  choose('confluence');
  assert.equal(u.visible(note), false);
});

test('the editor opens the publish dialog after Export closes, and the app routes each format', async () => {
  const calls = [];
  let exportArgs = null;
  const api = {
    export: { formats: async () => [{ id: 'confluence', label: 'Confluence' }] },
    templates: { list: async () => [] },
    settings: { all: async () => ({}) },
    github: { status: async () => null },
  };
  const dialogs = {
    showExportDialog: async (args) => { exportArgs = args; calls.push('export closed'); if (args.publishTargets.confluence) args.onPublishInstead('confluence'); return false; },
  };
  const context = { window: { stepforge: api, StepForgeDialogs: dialogs }, document: { activeElement: null }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  editor.guideId = 'g1';
  editor.onPublish = async (format) => { calls.push(`publish ${format}`); };
  editor.reload = async () => { calls.push('reload'); };
  await editor.openExportDialog();
  assert.deepEqual(JSON.parse(JSON.stringify(exportArgs.publishTargets)), { confluence: 'Confluence', wikijs: 'Wiki.js' });
  assert.deepEqual(calls, ['export closed', 'publish confluence']);

  // Without an onPublish handler the dialog gets no targets, so no note.
  editor.onPublish = null;
  calls.length = 0;
  await editor.openExportDialog();
  assert.deepEqual(JSON.parse(JSON.stringify(exportArgs.publishTargets)), {});
  assert.deepEqual(calls, ['export closed']);

  // The app hands the editor a handler that opens the matching publish dialog.
  const appSrc = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  assert.match(appSrc, /onPublish: \(format\) => \(format === 'confluence'\s*\? this\.publishToConfluence\(this\.editor\.guideId, this\.editor\.guide\?\.title\)\s*: this\.publishToWikiJs\(this\.editor\.guideId, this\.editor\.guide\?\.title\)\)/);
});
