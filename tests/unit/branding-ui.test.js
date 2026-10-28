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
    const [tag, ...rest] = spec.split(/(?=[.#])/);
    const classSet = new Set(rest.filter((p) => p.startsWith('.')).map((p) => p.slice(1)));
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

function fakeApi(chooseAsset, overrides = {}, ai = {}) {
  const saved = [];
  const cancelled = [];
  return {
    saved,
    cancelled,
    branding: {
      chooseAsset,
      setRaster: async ({ id }) => ({ id, kind: 'image', needsRaster: false }),
      save: async ({ profile }) => { saved.push(JSON.parse(JSON.stringify(profile))); return { profile: { ...profile, id: 'brand-1' }, assets: {} }; },
      preview: async () => ({ file: '/tmp/x.html' }),
      ...overrides,
    },
    // Local AI is off unless a test turns it on.
    ai: {
      status: async () => ({ ready: false }),
      brandCss: async () => ({ ok: false, reason: 'AI is off.' }),
      cancel: async ({ guideId }) => { cancelled.push(guideId); return true; },
      ...ai,
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

/** The profile editor with a name typed in, and helpers for the Advanced CSS card. */
function openEditor({ ai = {}, data = null, chooseAsset = async () => null } = {}) {
  const t = ui();
  const api = fakeApi(chooseAsset, {}, ai);
  let closed = null;
  t.context.showBrandProfileEditor(api, data).then((value) => { closed = { value }; });
  const name = t.all(t.root).find((n) => n['aria-label'] === 'Profile name');
  name.value = 'Acme';
  name.listeners.input();
  const css = t.all(t.root).find((n) => n['aria-label'] === 'Advanced CSS');
  const request = t.all(t.root).find((n) => n.classList.contains('brand-ai-request'));
  const panel = t.all(t.root).find((n) => n.classList.contains('brand-ai'));
  const result = t.all(t.root).find((n) => n.classList.contains('brand-ai-result'));
  const visible = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };
  const shown = (text) => t.buttons(t.root, text).filter(visible);
  const type = (value) => { request.value = value; request.listeners.input(); };
  return { t, api, css, request, panel, result, visible, shown, type, closed: () => closed };
}

test('editor: Write with AI is offered only when local AI is on and its model is installed', async () => {
  const off = openEditor();
  await settle();
  assert.deepEqual(off.shown('Write with AI…'), [], 'AI off or not installed: no button at all');
  assert.equal(off.visible(off.panel), false);

  const on = openEditor({ ai: { status: async () => ({ ready: true, model: 'gemma3:4b' }) } });
  assert.deepEqual(on.shown('Write with AI…'), [], 'not before the check answers');
  await settle();
  assert.equal(on.shown('Write with AI…').length, 1);
  assert.ok(on.t.all(on.t.root).some((n) => n.classList.contains('brand-ai-model') && n.textContent === 'Written by gemma3:4b through Ollama.'));
});

test('editor: Write with AI shows the model’s CSS for review, and Add to CSS appends it under a comment', async () => {
  const requests = [];
  const e = openEditor({
    ai: {
      status: async () => ({ ready: true, model: 'gemma3:4b' }),
      brandCss: async (args) => { requests.push(JSON.parse(JSON.stringify(args))); return { ok: true, css: '.step-num { border-radius: 4px; }' }; },
    },
  });
  await settle();
  e.css.value = 'body { font-size: 15px; }';
  e.css.listeners.input();
  e.t.click(e.shown('Write with AI…')[0]);
  assert.equal(e.visible(e.panel), true);
  assert.deepEqual(e.shown('Write with AI…'), [], 'the button gives way to the panel');
  assert.equal(e.shown('Write CSS')[0].disabled, true, 'nothing to write yet');

  e.type('Square step numbers');
  assert.equal(e.shown('Write CSS')[0].disabled, false);
  e.t.click(e.shown('Write CSS')[0]);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request, 'Square step numbers');
  assert.equal(requests[0].css, 'body { font-size: 15px; }', 'the model sees the CSS so far');
  assert.deepEqual(requests[0].profile.colors, { primary: '#2563EB', accent: '#0EA5E9', text: '#18212B' });
  assert.equal(e.visible(e.result), true);
  assert.equal(e.result.textContent, '.step-num { border-radius: 4px; }');
  assert.equal(e.css.value, 'body { font-size: 15px; }', 'nothing changes until it’s added');
  assert.deepEqual(['Discard', 'Try again', 'Add to CSS'].map((label) => e.shown(label).length), [1, 1, 1]);

  e.t.click(e.shown('Add to CSS')[0]);
  assert.equal(e.css.value, 'body { font-size: 15px; }\n\n/* Square step numbers */\n.step-num { border-radius: 4px; }\n');
  assert.equal(e.visible(e.panel), false);
  assert.ok(e.t.all(e.t.root).some((n) => n.classList.contains('brand-css-note') && e.visible(n)));
  await e.t.click(e.t.button(e.t.root, 'Save'));
  assert.match(e.api.saved[0].html.css, /\/\* Square step numbers \*\/\n\.step-num/);
});

test('editor: Write with AI says what went wrong in its panel, and Discard keeps the CSS as it was', async () => {
  let reply = { ok: false, reason: 'AI request timed out.' };
  const e = openEditor({ ai: { status: async () => ({ ready: true, model: 'llama3.2:1b' }), brandCss: async () => reply } });
  await settle();
  e.t.click(e.shown('Write with AI…')[0]);
  e.type('Navy step titles');
  e.t.click(e.shown('Write CSS')[0]);
  await settle();
  assert.deepEqual(e.t.errors(), [{ text: 'AI request timed out.', part: 'Advanced CSS' }]);
  assert.equal(e.shown('Write CSS').length, 1, 'ready to try again');

  reply = { ok: true, css: '.step-head h2 { color: navy; }' };
  e.t.click(e.shown('Write CSS')[0]);
  await settle();
  assert.deepEqual(e.t.errors(), []);
  e.t.click(e.shown('Discard')[0]);
  assert.equal(e.visible(e.result), false);
  assert.equal(e.css.value, '');
  e.t.click(e.shown('Cancel')[0]);
  assert.equal(e.visible(e.panel), false);
  assert.equal(e.shown('Write with AI…').length, 1);
});

test('editor: Stop, or closing the editor, cancels the model’s request and drops its answer', async () => {
  let answer;
  const e = openEditor({
    ai: {
      status: async () => ({ ready: true, model: 'gemma3:4b' }),
      brandCss: () => new Promise((resolve) => { answer = resolve; }),
    },
  });
  await settle();
  e.t.click(e.shown('Write with AI…')[0]);
  e.type('Bigger logo');
  e.t.click(e.shown('Write CSS')[0]);
  assert.equal(e.request.disabled, true);
  e.t.click(e.shown('Stop')[0]);
  assert.deepEqual(e.api.cancelled, ['branding-css']);
  answer({ ok: true, css: '.brand-logo { max-height: 96px; }' });
  await settle();
  assert.equal(e.visible(e.result), false, 'a stopped answer is never shown');

  // Write again, then leave with the editor's own Cancel while it's writing.
  e.t.click(e.shown('Write CSS')[0]);
  e.t.click(e.t.buttons(e.t.root, 'Cancel').at(-1));
  await settle();
  assert.deepEqual(e.api.cancelled, ['branding-css', 'branding-css']);
  assert.equal(e.closed().value, null);
});

test('editor: Pick from logo appears with a logo, sets the three colors, and Undo puts them back', async () => {
  const logo = { id: 'a'.repeat(32), kind: 'image', name: 'logo.svg', needsRaster: false, dataUrl: 'data:image/svg+xml;base64,AA==' };
  const e = openEditor({ chooseAsset: async () => logo });
  const palette = { primary: '#0B6E4F', accent: '#0A5C42', text: '#1A2B24' };
  e.t.context.brandColorsFromLogo = async (asset) => { assert.equal(asset.id, logo.id); return palette; };
  const hex = (key) => e.t.all(e.t.root).find((n) => n['aria-label'] === `${key} color code`);
  assert.deepEqual(e.shown('Pick from logo'), [], 'no logo, nothing to pick from');

  e.t.click(e.t.buttons(e.t.root, 'Choose…')[0]);
  await settle();
  assert.equal(e.shown('Pick from logo').length, 1);
  await e.t.click(e.shown('Pick from logo')[0]);
  assert.deepEqual(['Primary', 'Accent', 'Text'].map((k) => hex(k).value), ['#0B6E4F', '#0A5C42', '#1A2B24']);
  assert.equal(e.shown('Undo').length, 1);
  e.t.click(e.shown('Undo')[0]);
  assert.deepEqual(['Primary', 'Accent', 'Text'].map((k) => hex(k).value), ['#2563EB', '#0EA5E9', '#18212B']);
  assert.deepEqual(e.shown('Undo'), []);

  // Changing a color by hand after picking drops the Undo; the picked colors are saved.
  await e.t.click(e.shown('Pick from logo')[0]);
  hex('Text').value = '#111111';
  hex('Text').listeners.input();
  assert.deepEqual(e.shown('Undo'), []);
  await e.t.click(e.t.button(e.t.root, 'Save'));
  assert.deepEqual(e.api.saved[0].colors, { primary: '#0B6E4F', accent: '#0A5C42', text: '#111111' });

  // A white logo has nothing to pick; removing the logo takes the row away.
  const white = openEditor({ chooseAsset: async () => logo });
  white.t.context.brandColorsFromLogo = async () => null;
  white.t.click(white.t.buttons(white.t.root, 'Choose…')[0]);
  await settle();
  await white.t.click(white.shown('Pick from logo')[0]);
  assert.deepEqual(white.t.errors(), [{ text: 'This logo is white or light gray, so there are no colors to pick. Set them above.', part: 'Brand colors' }]);
  white.t.click(white.t.buttons(white.t.root, 'Remove')[0]);
  assert.deepEqual(white.shown('Pick from logo'), []);
  assert.deepEqual(white.t.errors(), []);
});

test('Write with AI uses the ids and limits the main process does', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/branding.js'), 'utf8');
  const { BRAND_CSS_REQUEST } = require('../../app/text-intel');
  const { MAX_REQUEST_CHARS } = require('../../core/ai-brand-css');
  assert.ok(source.includes(`const BRAND_AI_REQUEST = '${BRAND_CSS_REQUEST}';`));
  assert.ok(source.includes(`const BRAND_AI_REQUEST_MAX_CHARS = ${MAX_REQUEST_CHARS};`));
  const index = fs.readFileSync(path.join(__dirname, '../../app/renderer/index.html'), 'utf8');
  assert.ok(index.indexOf('core/brand-palette.js') < index.indexOf('"branding.js"'), 'the palette loads before the editor uses it');
});
