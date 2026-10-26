'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Settings → About: "Check for updates" and, for Windows installs registered
 * with Chocolatey, "Update now" (makeUpdateCheck in app/renderer/dialogs.js),
 * driven through a DOM stand-in with scripted main-process answers.
 */

function setup({ check, updateNow = async () => ({ ok: true }), confirm = true, flushEdits = null }) {
  function el(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split('.');
    const classSet = new Set(classes);
    const node = {
      tag, disabled: false, children: [], listeners: {},
      get className() { return [...classSet].join(' '); },
      set className(value) { classSet.clear(); for (const c of String(value).split(/\s+/)) if (c) classSet.add(c); },
      classList: {
        add: (c) => classSet.add(c), remove: (c) => classSet.delete(c), contains: (c) => classSet.has(c),
        toggle: (c, on = !classSet.has(c)) => { if (on) classSet.add(c); else classSet.delete(c); return on; },
      },
      get textContent() { return this._text ?? this.children.map((c) => (typeof c === 'object' ? c.textContent : String(c))).join(''); },
      set textContent(value) { this.children = []; this._text = String(value); },
      // Like the DOM's append(): anything that isn't a node becomes text, so a stray null shows as "null".
      append(...items) {
        this._text = undefined;
        for (const child of items) this.children.push(child && typeof child === 'object' ? child : String(child));
      },
      addEventListener(type, fn) { this.listeners[type] = fn; },
    };
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node[key] = value;
    }
    node.append(...children.flat().filter((child) => child != null && child !== false));
    return node;
  }
  const calls = [];
  const confirms = [];
  const context = {
    window: {}, setTimeout, el,
    clearNode: (node) => { node.children = []; node._text = undefined; },
    setButtonLoading: (button, loading, label) => { button.disabled = loading; button.loadingLabel = loading ? label : undefined; },
    confirmDialog: async (message, options) => { confirms.push([message, options]); return confirm; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8'), context);
  const api = {
    app: {
      checkForUpdates: async () => { calls.push('check'); return check; },
      updateNow: async (args) => { calls.push(['updateNow', args]); return updateNow(); },
    },
  };
  const openLink = (url) => () => calls.push(['open', url]);
  const { checkUpdatesBtn, updateStatus } = context.window.StepForgeDialogs.makeUpdateCheck(api, { openLink, flushEdits });
  const all = (node, out = []) => {
    if (node && typeof node === 'object') { out.push(node); for (const child of node.children) all(child, out); }
    return out;
  };
  const buttons = () => all(updateStatus).filter((n) => n.tag === 'button');
  const button = (text) => buttons().find((n) => n.textContent === text);
  const press = (node) => node.listeners.click({ preventDefault() {} });
  return { checkUpdatesBtn, updateStatus, calls, confirms, buttons, button, press };
}

const available = (extra = {}) => ({
  status: 'update-available', currentVersion: '1.4', latestVersion: '1.4.1',
  releaseUrl: 'https://github.com/Twest2/StepForge/releases/tag/v1.4.1', hint: 'Some hint.', ...extra,
});

test('without Chocolatey, only the download button is offered, as the main action', async () => {
  const u = setup({ check: available({ updateNow: false }) });
  await u.press(u.checkUpdatesBtn);
  assert.deepEqual(u.buttons().map((b) => b.textContent), ['View release and download']);
  assert.equal(u.button('View release and download').classList.contains('primary'), true);
  assert.match(u.updateStatus.textContent, /You have 1\.4\. Some hint\./);
  assert.doesNotMatch(u.updateStatus.textContent, /null/, 'no stray "null" after the download button');
});

test('a registered install gets Update now first, with download as the secondary action', async () => {
  const u = setup({ check: available({ updateNow: true }) });
  await u.press(u.checkUpdatesBtn);
  assert.deepEqual(u.buttons().map((b) => b.textContent), ['Update now', 'View release and download']);
  assert.equal(u.button('Update now').classList.contains('primary'), true);
  assert.equal(u.button('View release and download').classList.contains('primary'), false);
  u.press(u.button('View release and download'));
  assert.deepEqual(u.calls.at(-1), ['open', 'https://github.com/Twest2/StepForge/releases/tag/v1.4.1']);
});

test('Update now confirms, saves open edits, then asks the main process with no arguments', async () => {
  const order = [];
  const u = setup({
    check: available({ updateNow: true }),
    flushEdits: async () => { order.push('flush'); return true; },
    updateNow: async () => { order.push('updateNow'); return { ok: true }; },
  });
  await u.press(u.checkUpdatesBtn);
  const updateNow = u.button('Update now');
  await u.press(updateNow);
  assert.equal(u.confirms.length, 1);
  assert.equal(u.confirms[0][0], 'StepForge will close to install version 1.4.1. Continue?');
  assert.equal(u.confirms[0][1].okLabel, 'Update now');
  assert.deepEqual(order, ['flush', 'updateNow']);
  assert.deepEqual(u.calls.find((c) => c[0] === 'updateNow'), ['updateNow', undefined]);
  assert.equal(updateNow.disabled, true, 'stays off while StepForge closes');
  assert.equal(updateNow.loadingLabel, 'Closing StepForge…');
});

test('cancelling the confirmation does nothing', async () => {
  const u = setup({ check: available({ updateNow: true }), confirm: false });
  await u.press(u.checkUpdatesBtn);
  await u.press(u.button('Update now'));
  assert.equal(u.calls.some((c) => c[0] === 'updateNow'), false);
});

test('a declined UAC prompt shows "Update cancelled" and leaves Update now available', async () => {
  const u = setup({ check: available({ updateNow: true }), updateNow: async () => ({ ok: false, reason: 'declined', message: 'Update cancelled' }) });
  await u.press(u.checkUpdatesBtn);
  const updateNow = u.button('Update now');
  await u.press(updateNow);
  assert.equal(updateNow.disabled, false);
  const note = u.updateStatus.children.at(-1);
  assert.equal(note.textContent, 'Update cancelled');
  assert.equal(note.classList.contains('error'), false, 'a choice, not an error');

  // Pressing it again tries again.
  await u.press(updateNow);
  assert.equal(u.calls.filter((c) => c[0] === 'updateNow').length, 2);
});

test('unsaved edits that fail to save stop the update; other failures are shown as errors', async () => {
  const u = setup({ check: available({ updateNow: true }), flushEdits: async () => false });
  await u.press(u.checkUpdatesBtn);
  await u.press(u.button('Update now'));
  assert.equal(u.calls.some((c) => c[0] === 'updateNow'), false);
  assert.match(u.updateStatus.textContent, /couldn’t be saved, so the update didn’t start/);

  const failing = setup({ check: available({ updateNow: true }), updateNow: async () => { throw new Error('boom'); } });
  await failing.press(failing.checkUpdatesBtn);
  const button = failing.button('Update now');
  await failing.press(button);
  const note = failing.updateStatus.children.at(-1);
  assert.match(note.textContent, /Couldn’t start the update/);
  assert.equal(note.classList.contains('error'), true);
  assert.equal(button.disabled, false);
});
