'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM stand-in with working classes, so visibility can be asserted.
function ui() {
  function el(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split('.');
    const classSet = new Set(classes.filter((c) => !c.includes('#')));
    const node = {
      tag, hidden: false, disabled: false, children: [], isConnected: true, dataset: {}, style: {},
      get className() { return [...classSet].join(' '); },
      set className(value) { classSet.clear(); for (const c of String(value).split(/\s+/)) if (c) classSet.add(c); },
      classList: {
        add: (c) => classSet.add(c), remove: (c) => classSet.delete(c), contains: (c) => classSet.has(c),
        toggle: (c, on = !classSet.has(c)) => { if (on) classSet.add(c); else classSet.delete(c); return on; },
      },
      get textContent() { return this._text ?? this.children.map((c) => (typeof c === 'object' ? c.textContent : String(c))).join(''); },
      set textContent(value) { this.children = []; this._text = String(value); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      append(...items) {
        this._text = undefined;
        for (const child of items.flat()) {
          if (child == null || child === false) continue;
          this.children.push(child);
          if (typeof child === 'object') child.parent = this;
        }
      },
      // Like the real DOM, replaceChildren() turns null into the text "null".
      replaceChildren(...items) { this.children = []; this._text = undefined; this.append(...items.map((item) => (item === null ? 'null' : item))); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.isConnected = false; },
      addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
      focus() {},
      getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
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
  context.toast = () => {};
  load('cloud.js');
  load('github.js');

  const visible = (node) => {
    for (let n = node; n; n = n.parent) if (n.hidden || n.classList?.contains('hidden')) return false;
    return true;
  };
  const all = (node, out = []) => {
    if (node && typeof node === 'object') { out.push(node); for (const child of node.children) all(child, out); }
    return out;
  };
  const find = (within, text, tag = 'button') => all(within).find((n) => n.tag === tag && visible(n) && n.textContent.includes(text));
  const click = (node) => node.listeners.click({ preventDefault() {}, currentTarget: node });
  return { context, root, el, visible, all, find, click };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi(github = {}) {
  const calls = [];
  const api = {
    calls,
    shell: { openExternal: async ({ url }) => { calls.push(['open', url]); return { ok: true }; } },
    cloud: {
      status: async () => ({ connected: true, enabled: true, email: 'casey@example.com', phase: 'synced' }),
      onStatus: () => () => {},
      guides: async () => [], storage: async () => ({ bytes: 0 }), deletedGuides: async () => [],
    },
    github: {
      status: async () => ({ available: true, connected: false, links: { install: 'https://github.com/apps/stepforge/installations/new', newRepository: 'https://github.com/new?name=stepforge-guides' }, expiryDays: [1, 7, 30], defaultExpiryDays: 7, ...github }),
      onStatus: () => () => {},
      repositories: async () => [],
      published: async () => [],
      publish: async (args) => { calls.push(['publish', args]); return { slug: 'a'.repeat(24), url: 'https://octo.github.io/guides/g/aaa/', expiresAt: '2026-10-06T12:00:00Z', pagesReady: true }; },
      unpublish: async (args) => { calls.push(['unpublish', args]); return []; },
      copy: async (args) => { calls.push(['copy', args]); return { ok: true }; },
      cancel: async () => ({ ok: true }),
    },
  };
  return api;
}

test('Accounts lists Google Drive then GitHub and opens each one’s panel', async () => {
  const u = ui();
  const accounts = u.context.makeAccountsSettings(fakeApi());
  await settle();
  const rows = u.all(accounts.node).filter((n) => n.tag === 'button' && n.classList.contains('account-row'));
  assert.deepEqual(rows.map((row) => row.children[1].children[0].textContent), ['Google Drive', 'GitHub']);
  assert.equal(rows[0].textContent.includes('casey@example.com'), true, 'Drive row shows who is signed in');
  assert.equal(rows[1].textContent.includes('Not connected'), true);
  const panels = u.all(accounts.node).filter((n) => n.tag === 'fieldset');
  const [drivePanel, githubPanel] = panels;
  assert.equal(u.visible(drivePanel), false, 'no service panel until one is chosen');

  u.click(rows[1]);
  assert.equal(u.visible(githubPanel), true);
  assert.equal(u.visible(drivePanel), false);
  assert.equal(u.visible(rows[0]), false);
  u.click(u.find(accounts.node, 'All accounts'));
  assert.equal(u.visible(rows[0]), true);
  assert.equal(u.visible(githubPanel), false);

  u.click(rows[0]);
  assert.equal(u.visible(drivePanel), true);
  accounts.dispose();

  const direct = u.context.makeAccountsSettings(fakeApi(), { view: 'github' });
  const directPanels = u.all(direct.node).filter((n) => n.tag === 'fieldset');
  assert.equal(u.visible(directPanels[1]), true, 'Settings can open straight to a service');
  direct.dispose();
});

test('the GitHub panel explains setup step by step and warns that guides are public', async () => {
  const u = ui();
  const api = fakeApi();
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  const text = panel.node.textContent;
  assert.match(text, /Shared guides are public\./);
  assert.match(text, /Create a public repository for shared guides/);
  assert.match(text, /Install StepForge on only that repository/);
  assert.match(text, /Only select repositories/);
  assert.match(text, /Sign in/);
  u.click(u.find(panel.node, 'Install StepForge on GitHub'));
  u.click(u.find(panel.node, 'Create repository on GitHub'));
  assert.deepEqual(api.calls, [
    ['open', 'https://github.com/apps/stepforge/installations/new'],
    ['open', 'https://github.com/new?name=stepforge-guides'],
  ]);
  panel.dispose();
});

test('publishing needs the public-page acknowledgement and then shows the link', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  const done = u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset a password' });
  await settle();
  await settle();
  const modal = u.root.children.at(-1);
  assert.match(modal.textContent, /Shared guides are public\./);
  assert.match(modal.textContent, /Blur tool/);
  assert.doesNotMatch(modal.textContent, /null/, 'optional notes that are not shown leave no stray text');
  const publish = u.find(modal, 'Publish');
  assert.equal(publish.disabled, true, 'cannot publish before acknowledging it will be public');

  const consent = u.all(modal).find((n) => n.tag === 'input' && n.type === 'checkbox');
  consent.checked = true;
  consent.listeners.change();
  assert.equal(publish.disabled, false);
  await publish.listeners.click();
  // Arguments come from the sandboxed renderer realm, so compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [['publish', { guideId: 'guide-1', days: 7 }]]);
  assert.match(modal.textContent, /https:\/\/octo\.github\.io\/guides\/g\/aaa\//);
  assert.equal(await done, true);
});

test('publishing an already shared guide offers removal', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  api.github.published = async () => [{ slug: 'b'.repeat(24), guideId: 'guide-1', title: 'Reset', expiresAt: '2026-10-01T00:00:00Z', url: 'https://x/' }];
  void u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset' });
  await settle();
  await settle();
  const modal = u.root.children.at(-1);
  assert.match(modal.textContent, /already shared/);
  assert.equal(u.visible(u.find(modal, 'Remove from the web')), true);
});

test('publishing before GitHub is set up points to Settings → Accounts', async () => {
  const u = ui();
  let opened = 0;
  const done = u.context.showPublishToWebDialog({ api: fakeApi(), guideId: 'g', guideTitle: 'G', onOpenAccounts: () => { opened += 1; } });
  await settle();
  const modal = u.root.children.at(-1);
  assert.match(modal.textContent, /Settings → Accounts → GitHub/);
  u.click(u.find(modal, 'Set up GitHub'));
  assert.equal(opened, 1);
  assert.equal(await done, false);
});
