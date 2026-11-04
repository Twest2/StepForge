'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * Dialog behaviour from app/renderer/util.js (openModal and the helpers
 * built on it), run against a small DOM stand-in: a tree with hidden and
 * inert subtrees, focus that only lands on focusable, rendered nodes, and
 * capture/bubble key and click propagation.
 */

function makeDom() {
  const win = { listeners: [], addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: Boolean(capture) }); } };
  const doc = {
    activeElement: null,
    listeners: [],
    addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: Boolean(capture) }); },
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => makeText(text),
    getElementById: (id) => walk(doc.documentElement).find((n) => n.id === id) || null,
  };

  function makeText(text) {
    return { nodeType: 3, isText: true, textContent: String(text), children: [], parent: null, listeners: [] };
  }

  function makeNode(tag) {
    const classes = new Set();
    const attrs = new Map();
    const node = {
      nodeType: 1, tagName: tag.toUpperCase(), localName: tag.toLowerCase(),
      children: [], parent: null, listeners: [], style: {}, dataset: {},
      hidden: false, inert: false, disabled: false, tabIndex: 0, type: '', value: '', title: '', role: '', id: '',
      classList: {
        add: (...names) => names.forEach((c) => classes.add(c)),
        remove: (...names) => names.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c, on = !classes.has(c)) => { if (on) classes.add(c); else classes.delete(c); return on; },
      },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return textOf(this); },
      set textContent(value) { this.replaceChildren(String(value)); },
      get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc.documentElement; },
      append(...items) {
        for (const item of items.flat()) {
          if (item == null || item === false) continue;
          const child = typeof item === 'object' ? item : makeText(item);
          child.parent?.children.splice(child.parent.children.indexOf(child), 1);
          child.parent = this;
          this.children.push(child);
        }
      },
      replaceChildren(...items) { for (const c of this.children) c.parent = null; this.children = []; this.append(...items); },
      remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
        if (doc.activeElement && (doc.activeElement === this || this.contains(doc.activeElement))) doc.activeElement = null;
      },
      contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },
      setAttribute(name, value) { attrs.set(name, String(value)); if (name === 'id') this.id = String(value); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      hasAttribute(name) { return attrs.has(name); },
      addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: Boolean(capture) }); },
      focus() {
        if (!rendered(this)) return;
        doc.activeElement = this;
        dispatch(this, { type: 'focusin' });
      },
      click() { dispatch(this, { type: 'click' }); },
    };
    return node;
  }

  function rendered(node) {
    if (!node.isConnected) return false;
    for (let n = node; n; n = n.parent) if (n.hidden || n.inert) return false;
    return true;
  }

  function textOf(node) {
    if (node.isText) return node.textContent;
    return node.children.map(textOf).join('');
  }

  function walk(node, out = []) {
    out.push(node);
    for (const child of node.children || []) walk(child, out);
    return out;
  }

  function dispatch(target, event) {
    let stopped = false;
    event.target = target;
    event.defaultPrevented = false;
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopPropagation = () => { stopped = true; };
    const path = [];
    for (let n = target; n; n = n.parent) path.unshift(n);
    path.unshift(doc, win);
    const run = (node, phase) => {
      for (const l of [...(node.listeners || [])]) {
        if (stopped) return;
        if (l.type !== event.type) continue;
        if (phase === 'capture' ? !l.capture : l.capture) continue;
        l.fn.call(node, event);
      }
    };
    for (const node of path) run(node, 'capture');
    for (const node of [...path].reverse()) { if (stopped) break; run(node, 'bubble'); }
    return event;
  }

  const html = makeNode('html');
  const body = makeNode('body');
  const app = makeNode('div');
  app.id = 'app';
  const modalRoot = makeNode('div');
  modalRoot.id = 'modal-root';
  html.append(body);
  body.append(app, modalRoot);
  doc.documentElement = html;
  doc.body = body;

  const press = (key, { target = doc.activeElement || body, shiftKey = false } = {}) =>
    dispatch(target, { type: 'keydown', key, shiftKey });

  return { win, doc, body, app, modalRoot, press, walk, textOf, dispatch };
}

function loadUtil(language = 'en', withDialogs = false) {
  const dom = makeDom();
  const context = { ...rendererI18n(language), document: dom.doc, window: dom.win,
    location: { search: `?lang=${language}` }, setTimeout, clearTimeout,
    StepForgeLocales: require('../../core/locales') };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  if (withDialogs) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8'), context);
  const button = (within, label) => dom.walk(within).find((n) => n.localName === 'button' && dom.textOf(n) === label);
  return { ...dom, ...context, button, text: (node) => dom.textOf(node) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a click on the backdrop closes neither a dialog nor a confirmation on top of it', async () => {
  const u = loadUtil();
  let closed = 0;
  const input = u.el('input', { value: 'typed' });
  u.openModal({ title: 'Settings', body: input, isDirty: () => true, onClose: () => closed++ });
  u.modalRoot.click();
  assert.equal(u.modalRoot.children.length, 1);
  assert.equal(closed, 0);
  const pending = u.confirmDialog('Delete?', { danger: true, okLabel: 'Delete' });
  u.modalRoot.click();
  assert.equal(u.modalRoot.children.length, 2);
  u.button(u.modalRoot.children[1], 'Cancel').click();
  assert.equal(await pending, false);
  assert.equal(u.modalRoot.children.length, 1);
  assert.equal(input.value, 'typed');
});

test('clicks inside a dialog reach the page, so a menu opened from it can close', () => {
  const u = loadUtil();
  u.openModal({ title: 'Settings', body: u.el('button', {}, 'Extend') });
  const seen = [];
  u.doc.addEventListener('click', () => seen.push('page'));
  u.modalRoot.children[0].children[1].children[0].click();
  assert.deepEqual(seen, ['page']);
});

test('Escape closes a dialog with no unsaved changes, without asking', () => {
  const u = loadUtil();
  const input = u.el('input', { value: 'Before' });
  let closed = 0;
  u.openModal({ title: 'Guide information', body: input, isDirty: u.unsavedChanges(() => input.value), onClose: () => closed++ });
  u.press('Escape');
  assert.equal(u.modalRoot.children.length, 0);
  assert.equal(closed, 1);
});

test('Escape and × with unsaved changes ask first: Keep editing keeps the edits, Discard closes', () => {
  const u = loadUtil();
  const input = u.el('input', { value: 'Before' });
  let closed = 0;
  const { node } = u.openModal({ title: 'Settings', body: input, isDirty: u.unsavedChanges(() => input.value), onClose: () => closed++ });
  input.value = 'After';

  u.press('Escape');
  assert.equal(u.modalRoot.children.length, 2);
  const prompt = u.modalRoot.children[1];
  assert.equal(u.text(prompt.children[0].children[0]), 'Discard your changes?');
  assert.equal(u.doc.activeElement, u.button(prompt, 'Keep editing'), 'Keep editing has focus');
  u.button(prompt, 'Keep editing').click();
  assert.equal(u.modalRoot.children.length, 1);
  assert.equal(u.modalRoot.children[0], node);
  assert.equal(input.value, 'After');
  assert.equal(closed, 0);

  // Escape on the prompt itself keeps editing too.
  u.press('Escape');
  assert.equal(u.modalRoot.children.length, 2);
  u.press('Escape');
  assert.equal(u.modalRoot.children.length, 1);
  assert.equal(closed, 0);

  // × asks the same question, and Discard closes without a second prompt.
  const x = u.walk(node).find((n) => n.localName === 'button' && n.className.includes('close'));
  assert.equal(x.getAttribute('aria-label'), 'Close (Esc)');
  x.click();
  assert.equal(u.modalRoot.children.length, 2);
  u.button(u.modalRoot.children[1], 'Discard').click();
  assert.equal(u.modalRoot.children.length, 0);
  assert.equal(closed, 1);
  assert.equal(input.value, 'After');
});

test('the discard prompt is translated', () => {
  const u = loadUtil('ru');
  const input = u.el('input', { value: 'a' });
  u.openModal({ title: 'Настройки', body: input, isDirty: u.unsavedChanges(() => input.value) });
  input.value = 'b';
  u.press('Escape');
  assert.equal(u.text(u.modalRoot.children[1].children[0].children[0]), 'Отклонить изменения?');
  assert.equal(u.text(u.button(u.modalRoot.children[1], 'Продолжить редактирование') || u.modalRoot.children[1]).includes('Продолжить редактирование'), true);
});

test('Enter in a text prompt still submits, and an unchanged prompt closes on Escape', async () => {
  const u = loadUtil();
  const pending = u.promptDialog('Rename template', { value: 'Old' });
  await settle();
  const input = u.walk(u.modalRoot).find((n) => n.localName === 'input');
  assert.equal(u.doc.activeElement, input, 'the field has focus');
  u.press('Escape');
  assert.equal(await pending, null);
  assert.equal(u.modalRoot.children.length, 0);

  const second = u.promptDialog('Rename template', { value: 'Old' });
  await settle();
  const field = u.walk(u.modalRoot).find((n) => n.localName === 'input');
  field.value = 'New';
  u.press('Escape');
  assert.equal(u.modalRoot.children.length, 2, 'changed text asks first');
  u.button(u.modalRoot.children[1], 'Discard').click();
  assert.equal(await second, null);

  const third = u.promptDialog('Rename template', { value: 'Old' });
  await settle();
  const typed = u.walk(u.modalRoot).find((n) => n.localName === 'input');
  typed.value = 'Newer';
  u.press('Enter', { target: typed });
  assert.equal(await third, 'Newer');
  assert.equal(u.modalRoot.children.length, 0);
});

test('focus moves into a new dialog and returns to the element that opened it', () => {
  const u = loadUtil();
  const opener = u.el('button', {}, 'Edit');
  u.app.append(opener);
  opener.focus();
  assert.equal(u.doc.activeElement, opener);
  const input = u.el('input', { value: '' });
  const dialog = u.openModal({ title: 'Guide information', body: u.el('div', {}, input), footer: [u.el('button.primary', {}, 'Save')] });
  assert.equal(u.doc.activeElement, input, 'first field has focus');
  dialog.close();
  assert.equal(u.doc.activeElement, opener);
});

test('a destructive confirmation opens with Cancel focused; a plain one with its primary button', async () => {
  const u = loadUtil();
  const danger = u.confirmDialog('Delete “Step 1”?', { danger: true, okLabel: 'Delete' });
  const dangerBox = u.modalRoot.children[0];
  assert.equal(u.doc.activeElement, u.button(dangerBox, 'Cancel'));
  u.button(dangerBox, 'Cancel').click();
  assert.equal(await danger, false);

  const plain = u.confirmDialog('Free up space?', { okLabel: 'Free up space' });
  const plainBox = u.modalRoot.children[0];
  assert.equal(u.doc.activeElement, u.button(plainBox, 'Free up space'));
  u.button(plainBox, 'Free up space').click();
  assert.equal(await plain, true);
});

test('Tab and Shift+Tab wrap inside the top dialog and pass through in the middle', () => {
  const u = loadUtil();
  const a = u.el('input', { value: '' });
  const b = u.el('input', { value: '' });
  const cancel = u.el('button', {}, 'Cancel');
  const ok = u.el('button.primary', {}, 'OK');
  const { node } = u.openModal({ title: 'Edit', body: u.el('div', {}, a, b), footer: [cancel, ok] });
  const first = u.walk(node).find((n) => n.localName === 'button' && n.className.includes('close'));

  ok.focus();
  assert.equal(u.press('Tab').defaultPrevented, true);
  assert.equal(u.doc.activeElement, first, 'Tab from the last control wraps to the first');

  first.focus();
  assert.equal(u.press('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(u.doc.activeElement, ok, 'Shift+Tab from the first control wraps to the last');

  b.focus();
  assert.equal(u.press('Tab').defaultPrevented, false, 'Tab in the middle is left to the browser');
});

test('a confirmation on top of Settings traps focus there, and closing it returns focus inside Settings', async () => {
  const u = loadUtil();
  const field = u.el('input', { value: 'x' });
  const remove = u.el('button', {}, 'Delete from Drive');
  const settings = u.openModal({ title: 'Settings', body: u.el('div', {}, field, remove) });
  remove.focus();
  const pending = u.confirmDialog('Delete from Drive?', { danger: true, okLabel: 'Delete' });
  const confirm = u.modalRoot.children.at(-1);
  assert.equal(settings.node.hidden, true);
  assert.equal(settings.node.inert, true);

  const ok = u.button(confirm, 'Delete');
  ok.focus();
  u.press('Tab');
  assert.ok(confirm.contains(u.doc.activeElement), 'focus stays in the confirmation');
  assert.equal(settings.node.contains(u.doc.activeElement), false);

  u.press('Escape');
  assert.equal(await pending, false);
  assert.equal(u.modalRoot.children.length, 1);
  assert.equal(settings.node.hidden, false);
  assert.equal(settings.node.inert, false);
  assert.equal(u.doc.activeElement, remove, 'focus returns to the button in Settings that opened it');
});

test('the app behind the dialogs is inert while any dialog is open, including nested ones', () => {
  const u = loadUtil();
  const behind = u.el('button', {}, 'Delete');
  u.app.append(behind);
  assert.equal(u.app.inert, false);
  const outer = u.openModal({ title: 'Outer', body: u.el('div') });
  assert.equal(u.app.inert, true);
  const inner = u.openModal({ title: 'Inner', body: u.el('div') });
  inner.close();
  assert.equal(u.app.inert, true, 'still inert while the outer dialog is open');
  outer.close();
  assert.equal(u.app.inert, false);
  behind.focus();
  assert.equal(u.doc.activeElement, behind, 'controls are focusable again once nothing is open');
});

test('while a dialog is open, focus cannot reach the app and Enter or Space behind it do nothing', () => {
  const u = loadUtil();
  const behind = u.el('button', {}, 'Delete step');
  u.app.append(behind);
  const field = u.el('input', { value: '' });
  u.openModal({ title: 'Guide information', body: u.el('div', {}, field) });
  behind.focus();
  assert.notEqual(u.doc.activeElement, behind);

  const reached = [];
  u.doc.addEventListener('keydown', (e) => reached.push(e.key));
  assert.equal(u.press('Enter', { target: behind }).defaultPrevented, true);
  assert.equal(u.press(' ', { target: behind }).defaultPrevented, true);
  assert.deepEqual(reached, [], 'keys aimed behind the dialog never reach the page');
  u.press('Enter', { target: field });
  assert.deepEqual(reached, ['Enter'], 'keys inside the dialog still reach it');
});

test('focus that lands outside the top dialog is brought back into it', () => {
  const u = loadUtil();
  const outside = u.el('button', {}, 'Elsewhere');
  u.body.append(outside);
  const field = u.el('input', { value: '' });
  u.openModal({ title: 'Guide information', body: u.el('div', {}, field) });
  outside.focus();
  assert.equal(u.doc.activeElement, field);
});

test('dialogs are modal dialogs labelled by their heading', () => {
  const u = loadUtil();
  const { node } = u.openModal({ title: 'Brand profiles', body: u.el('div') });
  assert.equal(node.role, 'dialog');
  assert.equal(node.getAttribute('aria-modal'), 'true');
  const heading = u.walk(node).find((n) => n.id === node.getAttribute('aria-labelledby'));
  assert.equal(heading.localName, 'h2');
  assert.equal(u.text(heading), 'Brand profiles');
});

test('Cancel uses the dirty dismissal guard and resolves only after discarding', async () => {
  const u = loadUtil();
  const pending = u.promptDialog('Rename', { value: 'Old' });
  await settle();
  const dialog = u.modalRoot.children[0];
  const field = u.walk(dialog).find((n) => n.localName === 'input');
  field.value = 'New';
  u.button(dialog, 'Cancel').click();
  assert.equal(u.modalRoot.children.length, 2);
  u.button(u.modalRoot.children[1], 'Keep editing').click();
  assert.equal(u.modalRoot.children[0], dialog);
  assert.equal(field.value, 'New');
  u.button(dialog, 'Cancel').click();
  u.button(u.modalRoot.children[1], 'Discard').click();
  assert.equal(await pending, null);
  assert.equal(u.modalRoot.children.length, 0);
});


test('Add step accepts a title without an image and initially focuses its labelled input', async () => {
  const u = loadUtil('en', true);
  const done = u.window.StepForgeDialogs.showAddStepDialog();
  const field = u.doc.activeElement;
  assert.equal(field.localName, 'input');
  field.value = '  Check settings  ';
  u.button(u.modalRoot, 'Add').click();
  const draft = await done;
  assert.equal(draft.title, 'Check settings');
  assert.equal(draft.image, null);
});

test('Add step keeps the title when the picker is cancelled, allows removing a selected image, and guards dismissal', async () => {
  const u = loadUtil('en', true);
  let result = null;
  const done = u.window.StepForgeDialogs.showAddStepDialog({ onChooseImage: async () => result });
  const field = u.doc.activeElement;
  field.value = 'Keep this title';
  u.button(u.modalRoot, 'Choose image…').click(); await settle();
  assert.equal(field.value, 'Keep this title');
  result = { name: 'Example.webp', size: { width: 320, height: 200 }, imageBase64: 'bytes' };
  u.button(u.modalRoot, 'Choose image…').click(); await settle();
  assert.ok(u.text(u.modalRoot).includes('Example.webp'));
  u.button(u.modalRoot, 'Cancel').click();
  assert.equal(u.modalRoot.children.length, 2);
  u.button(u.modalRoot.children.at(-1), 'Keep editing').click();
  u.button(u.modalRoot, 'Remove image').click();
  u.button(u.modalRoot, 'Add').click();
  const draft = await done;
  assert.equal(draft.title, 'Keep this title'); assert.equal(draft.image, null);
});

test('Add step returns the selected draft image and reports picker failures without clearing edits', async () => {
  const u = loadUtil('en', true); let fail = true;
  const image = { name: 'Screenshot.png', size: { width: 160, height: 90 }, imageBase64: 'bytes' };
  const done = u.window.StepForgeDialogs.showAddStepDialog({ onChooseImage: async () => { if (fail) throw Error('Cannot read'); return image; } });
  u.doc.activeElement.value = 'Imported screenshot';
  u.button(u.modalRoot, 'Choose image…').click(); await settle();
  assert.ok(u.text(u.modalRoot).includes('Could not choose an image: Cannot read'));
  fail = false;
  u.button(u.modalRoot, 'Choose image…').click(); await settle();
  u.button(u.modalRoot, 'Add').click();
  const draft = await done;
  assert.equal(draft.image, image); assert.equal(draft.title, 'Imported screenshot');
});
