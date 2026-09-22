'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui() {
  const nodes = [];
  function el(spec, props = {}, ...children) {
    const node = { spec, ...props, children: [], hidden: false, inert: false, isConnected: true,
      classList: { add() {}, remove() {}, toggle() {} },
      append(...items) { for (const child of items.flat()) { if (child == null) continue; this.children.push(child); if (typeof child === 'object') child.parent = this; } },
      replaceChildren(...items) { this.children = []; this.textContent = ''; this.append(...items); },
      remove() { this.parent.children = this.parent.children.filter((n) => n !== this); this.isConnected = false; },
      addEventListener(type, fn) { this[`on${type}`] = fn; },
      focus() {},
    };
    node.append(...children);
    if (spec === 'select') node.value = node.children[0]?.value;
    nodes.push(node);
    return node;
  }
  const root = el('root');
  const keys = new Set();
  const context = { document: { activeElement: null, getElementById: () => root,
    addEventListener(type, fn) { if (type === 'keydown') keys.add(fn); },
    removeEventListener(type, fn) { if (type === 'keydown') keys.delete(fn); },
  }, window: {}, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  context.el = el;
  context.setButtonLoading = () => {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/cloud.js'), 'utf8'), context);
  const button = (label, within = root) => {
    const walk = (n) => typeof n === 'object' && !n.hidden
      ? (n.spec?.startsWith('button') && n.children.includes(label) ? n : n.children.map(walk).find(Boolean)) : null;
    return walk(within);
  };
  const escape = () => { for (const fn of [...keys]) { let stop = false; fn({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() { stop = true; } }); if (stop) break; } };
  return { context, root, nodes, el, button, escape };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('nested confirmation cancel, Escape, backdrop and accept all return to the same Settings form', async () => {
  const u = ui();
  const input = u.el('input', { value: 'unsaved setting' });
  let closed = 0;
  const settings = u.context.openModal({ title: 'Settings', body: input, onClose: () => closed++ });
  for (const action of ['Cancel', 'Escape', 'backdrop', 'OK']) {
    const confirming = u.context.confirmDialog('Continue?');
    assert.equal(settings.node.hidden, true);
    assert.equal(settings.node.inert, true);
    if (action === 'Escape') u.escape();
    else if (action === 'backdrop') u.root.onclick();
    else u.button(action).onClick();
    assert.equal(await confirming, action === 'OK');
    assert.equal(u.root.children.length, 1);
    assert.equal(u.root.children[0], settings.node);
    assert.equal(settings.node.hidden, false);
    assert.equal(input.value, 'unsaved setting');
    assert.equal(closed, 0);
  }
  u.escape();
  assert.equal(closed, 1);
  assert.equal(u.root.children.length, 0);
});

function cloud(u, overrides = {}) {
  const calls = [];
  const guides = [{ guideId: 'guide-a', title: 'Setup guide', snapshotCount: 2, bytes: 200, local: true }];
  const api = { cloud: {
    status: async () => ({ connected: true, enabled: true }), onStatus: () => () => {},
    guides: async () => guides,
    storage: async () => ({ bytes: 200, snapshotCount: 2, guideCount: 1 }), deletedGuides: async () => [],
    history: async () => [{ id: 'new', createdTime: '2026-09-22T12:00:00Z', size: 100 }, { id: 'old', createdTime: '2026-09-21T12:00:00Z', size: 100 }],
    restore: async (args) => calls.push(['restore', args.guideId, args.versionId]),
    deleteGuideSnapshots: async (args) => { calls.push(['delete', args.guideId]); guides.length = 0; },
    ...overrides,
  } };
  const panel = u.context.makeCloudSettings(api);
  const settings = u.context.openModal({ title: 'Settings', body: panel.node });
  return { calls, panel, settings };
}

test('Drive browser restores the chosen previous snapshot and returns to Settings', async () => {
  const u = ui(); const { calls, panel, settings } = cloud(u);
  await settle();
  await u.button('Snapshots').onClick();
  u.nodes.find((n) => n.spec === 'select').value = 'old';
  const action = u.button('Restore snapshot').onClick();
  assert.equal(settings.node.hidden, true);
  u.button('Restore snapshot').onClick();
  await action;
  assert.deepEqual(calls, [['restore', 'guide-a', 'old']]);
  assert.equal(settings.node.hidden, false);
  assert.equal(u.root.children.length, 1);
  panel.dispose();
});

test('Drive deletion requires confirmation, refreshes the list, and keeps Settings open', async () => {
  const u = ui(); const { calls, panel, settings } = cloud(u);
  await settle();
  let action = u.button('Delete Drive copies').onClick();
  u.button('Cancel').onClick(); await action;
  assert.deepEqual(calls, []);
  action = u.button('Delete Drive copies').onClick();
  u.button('Delete Drive copies').onClick(); await action;
  assert.deepEqual(calls, [['delete', 'guide-a']]);
  assert.equal(settings.node.hidden, false);
  assert.ok(u.nodes.some((n) => n.textContent === 'No active guides in Google Drive.'));
  panel.dispose();
});

test('failed restore displays an error and preserves Settings for retry', async () => {
  const u = ui(); const { panel, settings } = cloud(u, { restore: async () => { throw new Error('Close the editor first.'); } });
  await settle(); await u.button('Snapshots').onClick();
  const action = u.button('Restore snapshot').onClick();
  u.button('Restore snapshot').onClick(); await action;
  assert.ok(u.nodes.some((n) => n.textContent === 'Close the editor first.'));
  assert.equal(settings.node.hidden, false);
  assert.ok(u.button('Restore snapshot'));
  panel.dispose();
});
