'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The brand profile editor (app/renderer/branding.js) in a small DOM stand-in:
 * a refused file or too much CSS is reported under the part of the editor
 * that was used, not somewhere out of view.
 */

function ui() {
  function el(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split('.');
    const classSet = new Set(classes);
    const node = {
      tag, hidden: false, disabled: false, children: [], isConnected: true, dataset: {}, style: {}, value: '',
      get className() { return [...classSet].join(' '); },
      set className(value) { classSet.clear(); for (const c of String(value).split(/\s+/)) if (c) classSet.add(c); },
      classList: {
        add: (c) => classSet.add(c), remove: (c) => classSet.delete(c), contains: (c) => classSet.has(c),
        toggle: (c, on = !classSet.has(c)) => { if (on) classSet.add(c); else classSet.delete(c); return on; },
      },
      get textContent() { return this._text ?? this.children.map((c) => (typeof c === 'object' ? c.textContent : String(c))).join(''); },
      set textContent(value) { this.children = []; this._text = String(value); },
      setAttribute(name, value) { this[name] = value; },
      append(...items) {
        this._text = undefined;
        for (const child of items.flat()) {
          if (child == null || child === false) continue;
          this.children.push(child);
          if (typeof child === 'object') child.parent = this;
        }
      },
      replaceChildren(...items) { this.children = []; this._text = undefined; this.append(...items); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); },
      addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
      focus() { focused.push(this); },
    };
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'className') node.className = value;
      else node[key] = value;
    }
    node.append(...children);
    if (tag === 'select') node.value = node.children.find((c) => c.selected)?.value ?? node.children[0]?.value;
    return node;
  }
  const focused = [];
  const root = el('div');
  const context = {
    document: { activeElement: null, getElementById: () => root, addEventListener() {}, removeEventListener() {} },
    window: {}, setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  load('util.js');
  context.el = el;
  context.setButtonLoading = () => {};
  load('branding.js');

  const visible = (node) => {
    for (let n = node; n; n = n.parent) if (n.hidden) return false;
    return true;
  };
  const all = (node, out = []) => {
    if (node && typeof node === 'object') { out.push(node); for (const child of node.children) all(child, out); }
    return out;
  };
  const button = (within, text) => all(within).find((n) => n.tag === 'button' && n.textContent === text);
  const buttons = (within, text) => all(within).filter((n) => n.tag === 'button' && n.textContent === text);
  const click = (node) => node.listeners.click({ preventDefault() {} });
  // The shown error lines, each with the editor part it sits in.
  const errors = () => all(root).filter((n) => n.classList.contains('brand-row-error') && visible(n)).map((n) => {
    let part = n.parent;
    while (part && !['brand-asset-row', 'brand-font-row', 'settings-card'].some((c) => part.classList.contains(c))) part = part.parent;
    return { text: n.textContent, part: all(part).find((c) => c.classList.contains('setting-title') || c.classList.contains('settings-card-title'))?.textContent };
  });
  const footerStatus = () => all(root).find((n) => n.classList.contains('brand-footer-status')).textContent;
  return { context, root, all, button, buttons, click, errors, footerStatus, focused };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi(chooseAsset, overrides = {}) {
  const saved = [];
  return {
    saved,
    branding: {
      chooseAsset,
      setRaster: async ({ id }) => ({ id, kind: 'image', needsRaster: false }),
      save: async ({ profile }) => { saved.push(JSON.parse(JSON.stringify(profile))); return { profile: { ...profile, id: 'brand-1' }, assets: {} }; },
      preview: async () => ({ file: '/tmp/x.html' }),
      ...overrides,
    },
    shell: { openProduced: async () => ({ ok: true }) },
  };
}

test('editor: a refused logo is reported under the logo, and choosing again clears it', async () => {
  const t = ui();
  let next = Promise.reject(new Error('This image is larger than 10 MB. Choose a smaller one.'));
  next.catch(() => {});
  const api = fakeApi(() => next);
  void t.context.showBrandProfileEditor(api);
  await settle();
  assert.deepEqual(t.errors(), []);

  t.click(t.buttons(t.root, 'Choose…')[0]);
  await settle();
  assert.deepEqual(t.errors(), [{ text: 'This image is larger than 10 MB. Choose a smaller one.', part: 'Company logo' }]);
  assert.equal(t.footerStatus(), '', 'not in the footer, and not at the bottom of the editor');

  // A cancelled picker leaves the message; a good file replaces it.
  next = Promise.resolve(null);
  t.click(t.buttons(t.root, 'Choose…')[0]);
  await settle();
  assert.equal(t.errors().length, 1);
  next = Promise.resolve({ id: 'a'.repeat(32), kind: 'image', name: 'logo.png', needsRaster: false, dataUrl: 'data:image/png;base64,AA==' });
  t.click(t.buttons(t.root, 'Choose…')[0]);
  await settle();
  assert.deepEqual(t.errors(), []);
});

test('editor: a refused banner or font file is reported in its own row', async () => {
  const t = ui();
  const api = fakeApi(({ kind }) => Promise.reject(new Error(kind === 'font' ? 'This font file is larger than 10 MB.' : 'Choose a PNG, JPG or SVG image.')));
  void t.context.showBrandProfileEditor(api);
  t.click(t.buttons(t.root, 'Choose…')[1]);
  t.click(t.buttons(t.root, 'Upload font…')[1]);
  await settle();
  assert.deepEqual(t.errors(), [
    { text: 'Choose a PNG, JPG or SVG image.', part: 'Banner' },
    { text: 'This font file is larger than 10 MB.', part: 'Body text' },
  ]);
});

test('editor: CSS over the limit is flagged under the box and stops Save and Preview; a refused file too', async () => {
  const t = ui();
  let previews = 0;
  const api = fakeApi(() => Promise.reject(new Error('This CSS file is longer than 200,000 characters, the most a profile can hold.')),
    { preview: async () => { previews += 1; return { file: '/tmp/x.html' }; } });
  void t.context.showBrandProfileEditor(api);
  const name = t.all(t.root).find((n) => n['aria-label'] === 'Profile name');
  name.value = 'Acme';
  name.listeners.input();
  const css = t.all(t.root).find((n) => n['aria-label'] === 'Advanced CSS');

  css.value = 'a{}'.repeat(70000);
  css.listeners.input();
  assert.deepEqual(t.errors(), [{ text: 'This CSS is 210,000 characters long. A profile can hold 200,000.', part: 'Advanced CSS' }]);
  await t.click(t.button(t.root, 'Save'));
  await t.click(t.button(t.root, 'Preview'));
  assert.equal(api.saved.length, 0, 'not saved, and never cut short');
  assert.equal(previews, 0);
  assert.equal(t.focused.at(-1), css, 'Save takes you to the box');

  css.value = 'a { color: red; }';
  css.listeners.input();
  assert.deepEqual(t.errors(), []);
  t.click(t.button(t.root, 'Load .css file…'));
  await settle();
  assert.deepEqual(t.errors(), [{ text: 'This CSS file is longer than 200,000 characters, the most a profile can hold.', part: 'Advanced CSS' }]);
  assert.equal(css.value, 'a { color: red; }', 'what was there is kept');

  await t.click(t.button(t.root, 'Save'));
  assert.equal(api.saved.length, 1);
  assert.equal(api.saved[0].html.css, 'a { color: red; }');
});

test('editor: a missing name is said under the name; a failed save is said beside Save', async () => {
  const t = ui();
  const api = fakeApi(async () => null, { save: async () => { throw new Error('StepForge couldn’t save the profile.'); } });
  void t.context.showBrandProfileEditor(api);
  await t.click(t.button(t.root, 'Save'));
  assert.deepEqual(t.errors(), [{ text: 'Give the profile a name.', part: 'Profile name' }]);
  const name = t.all(t.root).find((n) => n['aria-label'] === 'Profile name');
  assert.ok(name.classList.contains('invalid'));
  name.value = 'Acme';
  name.listeners.input();
  assert.deepEqual(t.errors(), []);
  await t.click(t.button(t.root, 'Save'));
  assert.equal(t.footerStatus(), 'StepForge couldn’t save the profile.');
});

test('editor: annotation colors are off until turned on, and then saved with the profile', async () => {
  const open = () => {
    const t = ui();
    const api = fakeApi(async () => null);
    void t.context.showBrandProfileEditor(api);
    const name = t.all(t.root).find((n) => n['aria-label'] === 'Profile name');
    name.value = 'Acme';
    name.listeners.input();
    const own = t.all(t.root).find((n) => n.tag === 'label' && n.title === 'Use your own annotation colors').children[0];
    const shapes = t.all(t.root).find((n) => n['aria-label'] === 'Shapes color code');
    return { t, api, own, shapes };
  };
  const visible = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };

  const untouched = open();
  assert.equal(untouched.own.checked, false);
  assert.equal(visible(untouched.shapes), false, 'no color pickers until the option is on');
  assert.equal(untouched.shapes.value, '#E5484D', 'they start at StepForge’s colors');
  await untouched.t.click(untouched.t.button(untouched.t.root, 'Save'));
  assert.deepEqual(untouched.api.saved[0].annotations, { custom: false, shapes: '#E5484D', numbers: '#1F6FEB', tooltips: '#111827' });

  const turnedOn = open();
  turnedOn.own.checked = true;
  turnedOn.own.listeners.change();
  assert.equal(visible(turnedOn.shapes), true);
  turnedOn.shapes.value = '#173f7a';
  turnedOn.shapes.listeners.input();
  await turnedOn.t.click(turnedOn.t.button(turnedOn.t.root, 'Save'));
  assert.deepEqual(turnedOn.api.saved[0].annotations, { custom: true, shapes: '#173F7A', numbers: '#1F6FEB', tooltips: '#111827' });
});

test('step editor: new shapes, number badges and tooltips start in the profile’s colors only when it sets its own', async () => {
  const profiles = [];
  const api = { branding: { list: async () => profiles } };
  const context = { window: { stepforge: api, StepForgeDialogs: {} }, document: { activeElement: null }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  const styles = () => JSON.parse(JSON.stringify(['rect', 'oval', 'arrow', 'text', 'number', 'tooltip', 'highlight'].map((tool) => editor.defaultStyleForTool(tool))));

  editor.setSettings({});
  await settle();
  const stepforge = styles();
  assert.equal(stepforge[0].stroke, '#E5484D');
  assert.equal(stepforge[4].fill, '#1f6feb');

  profiles.push({ id: 'brand-1', annotations: { custom: false, shapes: '#173F7A', numbers: '#F5D90A', tooltips: '#FFFFFF' } });
  editor.setSettings({ branding: { activeProfileId: 'brand-1' } });
  await settle();
  assert.deepEqual(styles(), stepforge, 'a profile that keeps StepForge’s colors changes nothing');

  profiles[0].annotations.custom = true;
  editor.setSettings({ branding: { activeProfileId: 'brand-1' } });
  await settle();
  const [rect, oval, arrow, text, number, tooltip, highlight] = styles();
  for (const shape of [rect, oval, arrow, text]) assert.equal(shape.stroke, '#173F7A');
  assert.deepEqual(number, { fill: '#F5D90A', stroke: '#F5D90A', textColor: '#111111' }, 'dark numbers on a light badge');
  assert.deepEqual(tooltip, { fill: '#FFFFFF', textColor: '#111111', stroke: '#FFFFFF', tail: 'bottom' });
  assert.deepEqual(highlight, stepforge[6], 'highlights stay yellow');

  editor.setSettings({ branding: { activeProfileId: '' } });
  await settle();
  assert.deepEqual(styles(), stepforge);
});
