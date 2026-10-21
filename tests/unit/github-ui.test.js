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
  const windowListeners = {};
  const toasts = [];
  const context = {
    document: { activeElement: null, getElementById: () => root, addEventListener() {}, removeEventListener() {} },
    window: {
      addEventListener: (type, fn) => { (windowListeners[type] ||= new Set()).add(fn); },
      removeEventListener: (type, fn) => { windowListeners[type]?.delete(fn); },
    },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  load('util.js');
  context.el = el;
  context.setButtonLoading = (button, loading, label) => { button.loadingLabel = loading ? label : undefined; };
  context.toast = (message, options) => { toasts.push([message, options?.error === true]); };
  load('cloud.js');
  load('privacy.js');
  load('confluence.js');
  load('wikijs.js');
  load('github.js');
  load('dialogs.js');

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
  const focusWindow = () => { for (const fn of windowListeners.focus || []) fn(); };
  return { context, root, el, visible, all, find, click, toasts, focusWindow, windowListeners };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi(github = {}) {
  const calls = [];
  const progressListeners = new Set();
  const api = {
    calls,
    progress: (update) => { for (const fn of progressListeners) fn(update); },
    shell: { openExternal: async ({ url }) => { calls.push(['open', url]); return { ok: true }; } },
    confluence: {
      status: async () => ({ connected: false }),
      onStatus: () => () => {},
    },
    wikijs: {
      status: async () => ({ connected: false }),
      onStatus: () => () => {},
    },
    redact: {
      check: async (args) => { calls.push(['redact:check', args]); return { checked: 1, added: 0, blurs: [], text: [], steps: 0 }; },
      onProgress: () => () => {},
    },
    cloud: {
      status: async () => ({ connected: true, enabled: true, email: 'casey@example.com', phase: 'synced' }),
      onStatus: () => () => {},
      guides: async () => [], storage: async () => ({ bytes: 0 }), deletedGuides: async () => [],
    },
    github: {
      status: async () => ({ available: true, connected: false, links: { install: 'https://github.com/apps/stepforge/installations/new', newRepository: 'https://github.com/new?name=stepforge-guides' }, expiryDays: [1, 7, 30], defaultExpiryDays: 7, ...github }),
      onStatus: () => () => {},
      onProgress: (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); },
      repositories: async () => { calls.push(['repositories']); return []; },
      published: async () => [],
      publish: async (args) => { calls.push(['publish', args]); return { slug: 'a'.repeat(24), url: 'https://octo.github.io/guides/g/aaa/', expiresAt: '2026-10-06T12:00:00Z', pagesReady: true }; },
      unpublish: async (args) => { calls.push(['unpublish', args]); return []; },
      extend: async (args) => { calls.push(['extend', args]); return []; },
      waitUntilLive: async (args) => { calls.push(['waitUntilLive', args]); return { live: true }; },
      copy: async (args) => { calls.push(['copy', args]); return { ok: true }; },
      connect: async () => { calls.push(['connect']); return { connected: true, login: 'octo' }; },
      cancel: async () => { calls.push(['cancel']); return { ok: true }; },
    },
  };
  return api;
}

test('Accounts lists every sync service, then GitHub, Confluence and Wiki.js, and opens each one’s panel', async () => {
  const u = ui();
  const accounts = u.context.makeAccountsSettings(fakeApi());
  await settle();
  const rows = u.all(accounts.node).filter((n) => n.tag === 'button' && n.classList.contains('account-row'));
  const names = rows.map((row) => row.children[1].children[0]);
  assert.deepEqual(names.map((name) => name.children[0]),
    ['Google Drive', 'OneDrive', 'Dropbox', 'Nextcloud or WebDAV', 'GitHub', 'Confluence', 'Wiki.js']);
  // The publishing services are new, and say so.
  assert.deepEqual(names.map((name) => name.children.find((c) => c.classList?.contains('beta-badge'))?.textContent || ''),
    ['', '', '', '', '', 'Beta', 'Beta']);
  const logos = rows.map((row) => row.children[0].children[0].src);
  assert.deepEqual(logos, ['google-drive', 'onedrive', 'dropbox', 'nextcloud', 'github', 'confluence', 'wikijs'].map((name) => `../assets/icons/${name}.svg`));
  for (const logo of logos) {
    const file = path.join(__dirname, '../../app/renderer', logo);
    assert.match(fs.readFileSync(file, 'utf8'), /^<svg /, `${logo} ships with the app as a local SVG`);
  }
  assert.equal(rows[0].textContent.includes('casey@example.com'), true, 'Drive row shows who is signed in');
  for (const row of rows.slice(1)) assert.equal(row.textContent.includes('Not connected'), true);
  const panels = u.all(accounts.node).filter((n) => n.tag === 'fieldset');
  assert.equal(panels.length, 7);
  const [drivePanel, oneDrivePanel, , , githubPanel, confluencePanel, wikijsPanel] = panels;
  assert.equal(u.visible(drivePanel), false, 'no service panel until one is chosen');

  u.click(rows[4]);
  assert.equal(u.visible(githubPanel), true);
  assert.equal(u.visible(drivePanel), false);
  assert.equal(u.visible(rows[0]), false);
  u.click(u.find(accounts.node, 'All accounts'));
  assert.equal(u.visible(rows[0]), true);
  assert.equal(u.visible(githubPanel), false);

  u.click(rows[0]);
  assert.equal(u.visible(drivePanel), true);
  assert.equal(u.visible(oneDrivePanel), false);
  u.click(u.find(accounts.node, 'All accounts'));
  u.click(rows[5]);
  assert.equal(u.visible(confluencePanel), true);
  assert.match(confluencePanel.textContent, /Publish guides as Confluence pages/);
  u.click(u.find(accounts.node, 'All accounts'));
  u.click(rows[6]);
  assert.equal(u.visible(wikijsPanel), true);
  assert.equal(u.visible(confluencePanel), false);
  assert.match(wikijsPanel.textContent, /Publish guides as Wiki\.js pages/);
  accounts.dispose();

  const direct = u.context.makeAccountsSettings(fakeApi(), { view: 'github' });
  const directPanels = u.all(direct.node).filter((n) => n.tag === 'fieldset');
  assert.equal(u.visible(directPanels[4]), true, 'Settings can open straight to a service');
  direct.dispose();
  const dropbox = u.context.makeAccountsSettings(fakeApi(), { view: 'dropbox' });
  assert.equal(u.visible(u.all(dropbox.node).filter((n) => n.tag === 'fieldset')[2]), true);
  dropbox.dispose();
});

test('the GitHub panel explains setup step by step and warns that guides are public', async () => {
  const u = ui();
  const api = fakeApi();
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  const text = panel.node.textContent;
  assert.match(text, /Shared guides are public\./);
  const heroIcon = u.all(panel.node).find((n) => n.classList?.contains('cloud-hero-icon'));
  assert.equal(heroIcon.children[0].src, '../assets/icons/github.svg', 'the panel shows the GitHub mark');
  assert.match(text, /Sign in to GitHub/);
  assert.match(text, /Give StepForge one repository/);
  assert.match(text, /use a repository you already have/);
  assert.match(text, /install StepForge on only that repository/);
  assert.match(text, /Only select repositories/);
  assert.match(text, /Choose the repository/);
  u.click(u.find(panel.node, 'Install StepForge on GitHub'));
  u.click(u.find(panel.node, 'Create a repository'));
  assert.deepEqual(api.calls, [
    ['open', 'https://github.com/apps/stepforge/installations/new'],
    ['open', 'https://github.com/new?name=stepforge-guides'],
  ]);
  panel.dispose();
});

test('without a GitHub App the panel says why Install and Sign in are off', async () => {
  const u = ui();
  const panel = u.context.makeGitHubSettings(fakeApi({ available: false, links: { install: '', newRepository: 'https://github.com/new' } }));
  await settle();
  const note = u.all(panel.node).find((n) => n.role === 'note' && n.textContent.includes('isn’t connected to a StepForge GitHub App'));
  assert.ok(note && u.visible(note), 'the explanation is visible');
  assert.equal(u.find(panel.node, 'Install StepForge on GitHub').disabled, true);
  assert.equal(u.find(panel.node, 'Sign in with GitHub').disabled, true);
  assert.equal(u.find(panel.node, 'Create a repository').disabled, false, 'creating a repository still works');
  panel.dispose();

  const ready = u.context.makeGitHubSettings(fakeApi());
  await settle();
  assert.equal(u.visible(u.all(ready.node).find((n) => n.role === 'note' && n.textContent.includes('isn’t connected'))), false);
  ready.dispose();
});

test('choosing an existing repository shows what StepForge will add and waits for confirmation', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo' });
  api.github.repositories = async () => [{ fullName: 'octo/widget', private: false }];
  // Stands in for the main process reporting each setup step.
  api.github.selectRepository = async (args) => {
    api.progress({ task: 'setup', message: 'Checking octo/widget…' });
    api.calls.push(['select', JSON.parse(JSON.stringify(args))]);
    return args.useExisting ? { connected: true, repo: 'octo/widget', setupNote: '' }
      : { needsConfirmation: true, repo: 'octo/widget', changes: ['Add .github/workflows/stepforge-expire.yml to the main branch.', 'Create a gh-pages branch.'] };
  };
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  await settle();
  // The stand-in <select> does not track options added later; pick the one shown.
  u.all(panel.node).find((n) => n.tag === 'select').value = 'octo/widget';
  const useRepo = u.find(panel.node, 'Use this repository');
  const choosing = useRepo.listeners.click();
  await settle();
  assert.equal(useRepo.loadingLabel, 'Checking octo/widget…', 'the button says which setup step is running');
  const confirm = u.root.children.at(-1);
  assert.match(confirm.textContent, /Use octo\/widget for shared guides\?/);
  assert.match(confirm.textContent, /stepforge-expire\.yml to the main branch/);
  assert.match(confirm.textContent, /Nothing else in the repository changes/);
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [['select', { fullName: 'octo/widget' }]], 'waits for the user');
  u.click(u.find(confirm, 'Use this repository'));
  await choosing;
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [
    ['select', { fullName: 'octo/widget' }],
    ['select', { fullName: 'octo/widget', useExisting: true }],
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
  await settle();
  // Arguments come from the sandboxed renderer realm, so compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [
    ['redact:check', { guideId: 'guide-1' }],
    ['publish', { guideId: 'guide-1', days: 7 }],
    ['waitUntilLive', { slug: 'a'.repeat(24) }],
  ]);
  assert.match(modal.textContent, /https:\/\/octo\.github\.io\/guides\/g\/aaa\//);
  assert.match(modal.textContent, /Live\. Anyone with the link can open it now\./);
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

test('the Publish dialog says when a shared guide has changed since', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  api.github.published = async () => [{ slug: 'b'.repeat(24), guideId: 'guide-1', title: 'Reset', publishedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-10-07T00:00:00Z', url: 'https://x/' }];
  api.library = { list: async () => ({ guides: [{ guideId: 'guide-1', updatedAt: '2026-10-02T00:00:00Z' }] }) };
  void u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset' });
  await settle();
  await settle();
  assert.match(u.root.children.at(-1).textContent, /The guide has changed since you shared it\./);

  const quiet = ui();
  api.library = { list: async () => ({ guides: [{ guideId: 'guide-1', updatedAt: '2026-09-29T00:00:00Z' }] }) };
  void quiet.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset' });
  await settle();
  await settle();
  assert.doesNotMatch(quiet.root.children.at(-1).textContent, /changed since/);
});

test('the shared list marks edited guides, opens Publish from the marker, and extends a link', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  const entry = (slug, guideId, title) => ({ slug: slug.repeat(24), guideId, title, publishedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-10-07T00:00:00Z', url: `https://x/${slug}/` });
  api.github.published = async () => [entry('a', 'edited', 'Edited guide'), entry('b', 'same', 'Same guide'), entry('c', 'gone', 'Deleted guide')];
  api.library = { list: async () => ({ guides: [
    { guideId: 'edited', updatedAt: '2026-10-02T00:00:00Z' },
    { guideId: 'same', updatedAt: '2026-09-29T00:00:00Z' },
  ] }) };
  const menus = [];
  u.context.contextMenu = (x, y, items) => { menus.push(items); };
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  await settle();
  const markers = u.all(panel.node).filter((n) => n.tag === 'button' && n.textContent === 'Edited since you shared it');
  assert.equal(markers.length, 1, 'only the guide that changed after publishing is marked');

  // The marker opens the ordinary Publish dialog, which still needs the consent checkbox.
  u.click(markers[0]);
  await settle();
  await settle();
  const modal = u.root.children.at(-1);
  assert.match(modal.textContent, /Publish to the web|already shared/);
  const publish = u.find(modal, 'Publish');
  assert.equal(publish.disabled, true, 'nothing is published until the person ticks the public-content box');
  assert.deepEqual(api.calls.filter(([name]) => name === 'publish'), []);

  const extend = u.all(panel.node).filter((n) => n.tag === 'button' && n.textContent === 'Extend');
  assert.equal(extend.length, 3);
  u.click(extend[1]);
  assert.deepEqual([...menus[0].map((item) => item.label)], ['Keep online for 1 day from now', 'Keep online for 7 days from now', 'Keep online for 30 days from now']);
  await menus[0][2].action();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.filter(([name]) => name === 'extend'))), [['extend', { slug: 'b'.repeat(24), days: 30 }]]);
  panel.dispose();
});

test('from Settings, the edited marker publishes through the app, so unsaved editor edits are saved first', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  api.github.published = async () => [{ slug: 'a'.repeat(24), guideId: 'edited', title: 'Edited guide', publishedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-10-07T00:00:00Z', url: 'https://x/' }];
  api.library = { list: async () => ({ guides: [{ guideId: 'edited', updatedAt: '2026-10-02T00:00:00Z' }] }) };
  const published = [];
  const accounts = u.context.makeAccountsSettings(api, { view: 'github', onPublishToWeb: async (guideId, title) => { published.push([guideId, title]); } });
  await settle();
  await settle();
  const marker = u.all(accounts.node).find((n) => n.tag === 'button' && n.textContent === 'Edited since you shared it');
  const dialogs = u.root.children.length;
  u.click(marker);
  await settle();
  assert.deepEqual(published, [['edited', 'Edited guide']]);
  assert.equal(u.root.children.length, dialogs, 'the app opens the dialog, not the panel');
  accounts.dispose();
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

function openExport(u, webPublish) {
  const exported = [];
  const done = u.context.window.StepForgeDialogs.showExportDialog({
    formats: [{ id: 'pdf', label: 'PDF' }, { id: 'html-rich', label: 'Interactive HTML' }, { id: 'html-simple', label: 'HTML' }],
    defaultFormat: 'pdf',
    onLoadDefaults: async () => ({}),
    onExport: async (payload) => { exported.push(JSON.parse(JSON.stringify(payload))); return true; },
    webPublish,
  });
  const modal = u.root.children.at(-1);
  const box = u.all(modal).find((n) => n.tag === 'fieldset' && n.classList.contains('export-publish'));
  const format = u.all(modal).find((n) => n.tag === 'select');
  const choose = (value) => { format.value = value; format.listeners.change(); };
  const toggle = u.all(box).find((n) => n.tag === 'input' && n.type === 'checkbox');
  return { done, modal, box, choose, toggle, exported };
}

test('Export offers Publish on the web for HTML formats and passes the choice to the export', async () => {
  const u = ui();
  const { done, modal, box, choose, toggle, exported } = openExport(u, { ready: true, formats: ['html-simple', 'html-rich'], expiryDays: [1, 7, 30], defaultExpiryDays: 7 });
  await settle();
  assert.equal(u.visible(box), false, 'not offered for PDF');
  choose('html-simple');
  assert.equal(u.visible(box), true, 'offered for HTML');
  const warning = u.all(box).find((n) => n.role === 'note');
  assert.equal(u.visible(warning), false);

  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(u.visible(warning), true);
  assert.match(warning.textContent, /Published guides are public\./);
  const days = u.all(box).find((n) => n.tag === 'select');
  days.value = '30';

  // Switching to a format that can't be published drops the request.
  choose('pdf');
  assert.equal(u.find(modal, 'Export and publish'), undefined);
  choose('html-rich');
  await u.find(modal, 'Export and publish').listeners.click();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].format, 'html-rich');
  assert.deepEqual(exported[0].publish, { days: 30 });
  assert.equal(await done, true);
});

test('Export without publishing sends no publish request, and says how to set up GitHub when it is not', async () => {
  const u = ui();
  const plain = openExport(u, { ready: true, formats: ['html-simple', 'html-rich'], expiryDays: [1, 7, 30], defaultExpiryDays: 7 });
  plain.choose('html-rich');
  await u.find(plain.modal, 'Export').listeners.click();
  assert.equal(plain.exported[0].publish, null);

  const notSetUp = openExport(u, { ready: false, formats: ['html-simple', 'html-rich'], expiryDays: [1, 7, 30], defaultExpiryDays: 7 });
  notSetUp.choose('html-rich');
  assert.equal(notSetUp.toggle.disabled, true);
  assert.match(notSetUp.box.textContent, /Connect GitHub in Settings → Accounts → GitHub/);

  const noApp = openExport(u, null);
  noApp.choose('html-rich');
  assert.equal(u.visible(noApp.box), false, 'hidden when this build has no GitHub App');
});

const stepStates = (u, node) => u.all(node).filter((n) => n.tag === 'li' && n.classList.contains('gh-step'))
  .map((n) => ['done', 'current', 'upcoming'].find((state) => n.classList.contains(state)));

test('setup steps tick off as the user signs in, installs StepForge, and can choose a repository', async () => {
  const u = ui();
  const signedOut = u.context.makeGitHubSettings(fakeApi());
  await settle();
  assert.deepEqual(stepStates(u, signedOut.node), ['current', 'upcoming', 'upcoming']);
  assert.equal(u.find(signedOut.node, 'Use this repository'), undefined, 'no empty repository picker before there is anything to pick');
  assert.equal(u.visible(u.find(signedOut.node, 'Install StepForge on GitHub')), true, 'installing first is fine too');
  signedOut.dispose();

  const api = fakeApi({ connected: true, login: 'octo' });
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  await settle();
  assert.deepEqual(stepStates(u, panel.node), ['done', 'current', 'upcoming']);
  assert.match(panel.node.textContent, /Signed in as @octo\./);
  const waiting = u.all(panel.node).find((n) => n.classList?.contains('gh-waiting') && n.textContent.includes('Waiting for StepForge to be installed'));
  assert.equal(u.visible(waiting), true);

  // Coming back to StepForge after installing the App on GitHub.
  api.github.repositories = async () => { api.calls.push(['repositories']); return [{ fullName: 'octo/stepforge-guides', private: false }]; };
  u.focusWindow();
  await settle();
  await settle();
  assert.deepEqual(stepStates(u, panel.node), ['done', 'done', 'current']);
  assert.match(panel.node.textContent, /StepForge is installed on octo\/stepforge-guides\./);
  assert.equal(u.visible(u.find(panel.node, 'Use this repository')), true);

  panel.dispose();
  assert.equal(u.windowListeners.focus.size, 0, 'stops listening when Settings closes');
});

test('while signing in, the code is shown with how to use it, and Cancel stops only the sign-in', async () => {
  const u = ui();
  const api = fakeApi({ pending: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', copied: true } });
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  const code = u.all(panel.node).find((n) => n.tag === 'code' && n.classList.contains('gh-code'));
  assert.equal(u.visible(code), true);
  assert.equal(code.textContent, 'WDJB-MJHT');
  assert.match(code.parent.textContent, /It’s copied\. Paste it on the GitHub page/);
  u.click(u.find(code.parent, 'Cancel'));
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [['cancel']]);

  // Closing Settings doesn't throw the sign-in away.
  api.calls.length = 0;
  panel.dispose();
  assert.deepEqual(api.calls, []);
});

test('signing in from the panel calls GitHub once and moves on to the repository', async () => {
  const u = ui();
  const api = fakeApi();
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  await u.find(panel.node, 'Sign in with GitHub').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [['connect'], ['repositories']]);
  assert.match(panel.node.textContent, /Signed in\./);
  panel.dispose();
});

test('an expired sign-in offers Sign in again and keeps the site on screen', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, needsSignIn: true, login: 'octo', repo: 'octo/guides', siteUrl: 'https://octo.github.io/guides/', pagesReady: true,
    error: 'Your GitHub sign-in has expired or was revoked. Sign in again to keep sharing guides.' });
  const renewed = { available: true, connected: true, login: 'octo', repo: 'octo/guides', siteUrl: 'https://octo.github.io/guides/', pagesReady: true };
  api.github.connect = async () => {
    api.calls.push(['connect']);
    api.github.status = async () => renewed;
    return renewed;
  };
  const panel = u.context.makeGitHubSettings(api);
  await settle();
  const again = u.find(panel.node, 'Sign in again');
  assert.ok(again && u.visible(again));
  assert.match(panel.node.textContent, /Sign in again to keep sharing/);
  assert.equal(api.calls.some(([name]) => name === 'repositories'), false, 'does not ask to choose a repository again');
  assert.match(panel.node.textContent, /Sign in again to see and manage your shared guides\./);
  api.github.published = async () => { api.calls.push(['published']); return []; };
  await again.listeners.click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls)), [['connect'], ['published']], 'the shared guides load once signed in again');
  assert.match(panel.node.textContent, /Signed in again\. You can keep sharing guides\./);
  panel.dispose();

  const accounts = u.context.makeAccountsSettings(fakeApi({ connected: true, needsSignIn: true, login: 'octo', repo: 'octo/guides' }));
  await settle();
  const row = u.all(accounts.node).filter((n) => n.tag === 'button' && n.classList.contains('account-row')).find((n) => n.textContent.includes('GitHub'));
  assert.match(row.textContent, /Sign in again/);
  accounts.dispose();
});

test('publishing shows each stage, the upload as it happens, and when the link is live', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  let finish;
  api.github.publish = (args) => { api.calls.push(['publish', args]); return new Promise((resolve) => { finish = resolve; }); };
  let goLive;
  api.github.waitUntilLive = () => new Promise((resolve) => { goLive = resolve; });
  void u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset a password' });
  await settle();
  await settle();
  const modal = u.root.children.at(-1);
  const consent = u.all(modal).find((n) => n.tag === 'input' && n.type === 'checkbox');
  consent.checked = true;
  consent.listeners.change();
  const publishing = u.find(modal, 'Publish').listeners.click();
  await settle();

  const stages = () => u.all(modal).filter((n) => n.tag === 'li' && n.classList.contains('gh-stage'))
    .map((n) => `${n.children[1].textContent}:${['done', 'active', 'upcoming'].find((s) => n.classList.contains(s))}`);
  const bar = () => u.all(modal).find((n) => n.role === 'progressbar');
  assert.deepEqual(stages(), ['Prepare the page:active', 'Upload to GitHub:upcoming', 'Update your site:upcoming']);
  assert.equal(bar().classList.contains('indeterminate'), true);
  assert.match(modal.textContent, /You can close this window/);

  api.progress({ task: 'publish', guideId: 'someone-else', stage: 'commit' });
  assert.equal(stages()[0], 'Prepare the page:active', 'ignores other guides');
  api.progress({ task: 'publish', guideId: 'guide-1', stage: 'upload', loaded: 3 * 1024 * 1024, total: 12 * 1024 * 1024, bytesPerSecond: 1024 * 1024 });
  assert.deepEqual(stages(), ['Prepare the page:done', 'Upload to GitHub:active', 'Update your site:upcoming']);
  assert.equal(bar().classList.contains('indeterminate'), false);
  assert.equal(bar().children[0].style.width, '25%');
  assert.equal(bar()['aria-valuenow'], '25');
  assert.match(modal.textContent, /3\.0 MB of 12\.0 MB · 1\.0 MB\/s/);
  api.progress({ task: 'publish', guideId: 'guide-1', stage: 'commit' });
  assert.deepEqual(stages(), ['Prepare the page:done', 'Upload to GitHub:done', 'Update your site:active']);

  finish({ slug: 'a'.repeat(24), url: 'https://octo.github.io/guides/g/aaa/', expiresAt: '2026-10-06T12:00:00Z', pagesReady: true });
  await publishing;
  assert.match(modal.textContent, /“Reset a password” is shared until/);
  assert.match(modal.textContent, /Going live on GitHub Pages/);
  assert.equal(u.visible(u.find(modal, 'Done')), true);
  goLive({ live: true });
  await settle();
  assert.match(modal.textContent, /Live\. Anyone with the link can open it now\./);
});

test('a failed publish goes back to the form and says why', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  api.github.publish = async () => { throw new Error('GitHub request failed (502).'); };
  const done = u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset' });
  await settle();
  await settle();
  const modal = u.root.children.at(-1);
  const consent = u.all(modal).find((n) => n.tag === 'input' && n.type === 'checkbox');
  consent.checked = true;
  consent.listeners.change();
  await u.find(modal, 'Publish').listeners.click();
  const alert = u.all(modal).find((n) => n.role === 'alert');
  assert.equal(u.visible(alert), true);
  assert.match(alert.textContent, /502/);
  assert.equal(u.find(modal, 'Publish').disabled, false, 'can try again straight away');
  u.click(u.find(modal, 'Cancel'));
  assert.equal(await done, false);
});

test('Export and publish shows the same progress, then the link', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  const done = u.context.showPublishProgressDialog({ api, guideId: 'guide-1', guideTitle: 'Reset', request: { days: 30, format: 'html-simple', options: { theme: 'dark' } } });
  const modal = u.root.children.at(-1);
  assert.match(modal.textContent, /Publishing “Reset”/);
  await settle();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls[0])), ['publish', { guideId: 'guide-1', days: 30, format: 'html-simple', options: { theme: 'dark' } }]);
  assert.match(modal.textContent, /https:\/\/octo\.github\.io\/guides\/g\/aaa\//);
  u.click(u.find(modal, 'Done'));
  await done;
});

test('closing the dialog while publishing still reports the result', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  let fail;
  api.github.publish = () => new Promise((resolve, reject) => { fail = reject; });
  const done = u.context.showPublishProgressDialog({ api, guideId: 'guide-1', guideTitle: 'Reset', request: { days: 7 } });
  const modal = u.root.children.at(-1);
  u.click(u.find(modal, 'Close'));
  await done;
  fail(new Error('GitHub request failed (500).'));
  await settle();
  assert.deepEqual(u.toasts, [['The guide was exported, but publishing it on the web failed: GitHub request failed (500).', true]]);
});

test('the publish dialog checks screenshots for private details first and lets you review the blurs', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  let finish;
  const found = { checked: 2, added: 2, steps: 2,
    blurs: [{ stepId: 's1', stepNumber: 1, annotationId: 'a1', kind: 'email', label: 'Email address' },
      { stepId: 's2', stepNumber: 2, annotationId: 'a2', kind: 'ip', label: 'IP address' }],
    text: [{ stepId: 's2', stepNumber: 2, field: 'title', kind: 'email', key: 'email:abc', label: 'Email address', preview: 'c•••@contoso.com' }] };
  api.redact.check = () => new Promise((resolve) => { finish = resolve; });
  api.redact.keepVisible = async (args) => { api.calls.push(['keepVisible', args]); return { ...found, blurs: found.blurs.slice(1), steps: 1 }; };
  u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset a password' });
  await settle(); await settle();
  const modal = u.root.children.at(-1);
  const consent = u.all(modal).find((n) => n.tag === 'input' && n.type === 'checkbox');
  consent.checked = true;
  consent.listeners.change();
  const publish = u.find(modal, 'Publish');
  assert.equal(publish.disabled, true, 'Publish waits for the check');
  assert.match(modal.textContent, /Checking screenshots for private details/);
  finish(found);
  await settle();
  assert.equal(publish.disabled, false);
  assert.match(modal.textContent, /Blurred 2 possible private details and found 1 more in step text in 2 steps\./);
  u.click(u.find(modal, 'Review'));
  const review = u.root.children.at(-1);
  assert.match(review.textContent, /Step 1.*Email address/);
  assert.match(review.textContent, /c•••@contoso\.com/, 'text findings are masked');
  u.click(u.all(review).find((n) => n.tag === 'button' && n.textContent === 'Not private'));
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.at(-1))), ['keepVisible', { guideId: 'guide-1', stepId: 's1', annotationId: 'a1' }]);
  assert.doesNotMatch(review.textContent, /Step 1/);
});

test('cancelling Publish while the private-detail check runs resolves only after the check has written its blurs', async () => {
  const u = ui();
  const api = fakeApi({ connected: true, login: 'octo', repo: 'octo/guides', pagesReady: true });
  let finish;
  api.redact.check = () => new Promise((resolve) => { finish = resolve; });
  let resolved = false;
  const dialog = u.context.showPublishToWebDialog({ api, guideId: 'guide-1', guideTitle: 'Reset' }).then(() => { resolved = true; });
  await settle(); await settle();
  u.click(u.find(u.root.children.at(-1), 'Cancel'));
  await settle();
  assert.equal(resolved, false, 'the caller would reload the editor before the blurs are on disk');
  finish({ checked: 1, added: 1, steps: 1, blurs: [{ stepId: 's1', stepNumber: 1, annotationId: 'a1', kind: 'email', label: 'Email address' }], text: [] });
  await dialog;
  assert.equal(resolved, true);
});

test('App.publishToWeb (the marker\'s route) saves the open guide first and reloads it after a cancelled check', async () => {
  const context = vm.createContext({ window: {}, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8').replace('\nboot();', '\n'), context);
  const events = [];
  let finishCheck;
  // The dialog: cancelled at once, but its check finishes (and writes blurs) later.
  context.showPublishToWebDialog = () => new Promise((resolve) => { finishCheck = () => { events.push('check wrote blurs'); resolve(false); }; });
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { view: 'editor' };
  app.editor = { guideId: 'g1', saveAll: async () => { events.push('save'); }, reload: async () => { events.push('reload'); } };
  const done = app.publishToWeb('g1', 'Guide');
  await settle();
  finishCheck();
  await done;
  assert.deepEqual(events, ['save', 'check wrote blurs', 'reload']);
});

function wikiApi(overrides = {}) {
  const api = fakeApi();
  const progressListeners = new Set();
  api.wikijs = {
    status: async () => ({ connected: false }),
    onStatus: () => () => {},
    onProgress: (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); },
    probe: async (args) => { api.calls.push(['probe', args]); return { baseUrl: 'https://wiki.example.com', host: 'wiki.example.com', apiKeyUrl: 'https://wiki.example.com/a/api', strategies: [{ key: 'local', name: 'Local', usernameType: 'email' }] }; },
    connect: async (args) => { api.calls.push(['connect', args]); return { connected: true, host: 'wiki.example.com', method: args.method, user: args.method === 'password' ? 'Casey Jones' : '', strategy: 'Local' }; },
    disconnect: async () => { api.calls.push(['disconnect']); return { connected: false }; },
    cancel: async () => ({ ok: true }),
    defaults: async (args) => { api.calls.push(['defaults', args]); return { path: 'guides/reset-a-password', title: 'Reset a password', locale: 'en', published: null }; },
    publish: async (args) => { api.calls.push(['publish', args]); return { id: 4, url: 'https://wiki.example.com/en/guides/reset-a-password', title: args.title, updated: false }; },
    ...overrides,
  };
  api.wikiProgress = (update) => { for (const fn of progressListeners) fn(update); };
  return api;
}

test('the Wiki.js panel asks for the site, then a username and password or an API key', async () => {
  const u = ui();
  const api = wikiApi();
  const panel = u.context.makeWikiJsSettings(api);
  await settle();
  const inputs = () => u.all(panel.node).filter((n) => n.tag === 'input' || n.tag === 'select');
  const field = (label) => inputs().find((n) => n['aria-label'] === label);
  assert.equal(u.visible(field('Password')), false, 'nothing to sign in to until the site is known');
  field('Wiki.js site address').value = 'wiki.example.com';
  await u.find(panel.node, 'Continue').listeners.click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls[0])), ['probe', { address: 'wiki.example.com' }]);
  assert.equal(u.visible(field('Sign in with')), false, 'no choice when the wiki has one sign-in');
  assert.equal(u.visible(field('Email address')), true, 'local accounts sign in with an email address');
  assert.equal(u.visible(field('API key')), true);
  u.click(u.find(panel.node, 'Open API Access on your wiki'));
  assert.deepEqual(api.calls.at(-1), ['open', 'https://wiki.example.com/a/api']);

  field('Email address').value = 'casey@example.com';
  field('Password').value = 'hunter2';
  await u.find(panel.node, 'Sign in').listeners.click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.at(-1))), ['connect', { address: 'wiki.example.com', method: 'password', username: 'casey@example.com', password: 'hunter2', strategy: 'local' }]);
  assert.equal(field('Password').value, '', 'the password isn’t kept on screen');
  assert.match(panel.node.textContent, /Signed in as Casey Jones\./);
  assert.match(panel.node.textContent, /wiki\.example\.com · Wiki\.js · signed in with Local/);
  await u.find(panel.node, 'Sign out').listeners.click();
  await settle();
  assert.deepEqual(api.calls.at(-1), ['disconnect']);
  assert.match(panel.node.textContent, /Signed out\. Pages you published stay on the wiki\./);
  panel.dispose();
});

test('“Sign in with” appears only for several sign-ins, and an SSO-only wiki points to API keys', async () => {
  const u = ui();
  const strategies = [{ key: 'ldap-1', name: 'Company LDAP', usernameType: 'username' }, { key: 'local', name: 'Local', usernameType: 'email' }];
  const api = wikiApi();
  api.wikijs.probe = async () => ({ baseUrl: 'https://wiki.example.com', host: 'wiki.example.com', apiKeyUrl: 'https://wiki.example.com/a/api', strategies });
  const panel = u.context.makeWikiJsSettings(api);
  await settle();
  const field = (label) => u.all(panel.node).find((n) => ['input', 'select'].includes(n.tag) && n['aria-label'] === label);
  field('Wiki.js site address').value = 'wiki.example.com';
  await u.find(panel.node, 'Continue').listeners.click();
  await settle();
  const choose = field('Sign in with');
  assert.equal(u.visible(choose), true);
  assert.deepEqual(choose.children.map((o) => o.textContent), ['Company LDAP', 'Local']);
  assert.equal(u.visible(field('Username')), true, 'LDAP signs in with a username');
  choose.value = 'local';
  choose.listeners.change();
  assert.equal(u.visible(field('Email address')), true);
  field('Email address').value = 'casey@example.com';
  field('Password').value = 'pw';
  await u.find(panel.node, 'Sign in').listeners.click();
  assert.equal(api.calls.at(-1)[1].strategy, 'local');
  panel.dispose();

  const sso = wikiApi();
  sso.wikijs.probe = async () => ({ baseUrl: 'https://wiki.example.com', host: 'wiki.example.com', apiKeyUrl: 'https://wiki.example.com/a/api', strategies: [] });
  const ssoPanel = u.context.makeWikiJsSettings(sso);
  await settle();
  u.all(ssoPanel.node).find((n) => n['aria-label'] === 'Wiki.js site address').value = 'wiki.example.com';
  await u.find(ssoPanel.node, 'Continue').listeners.click();
  await settle();
  assert.match(ssoPanel.node.textContent, /only offers single sign-on.*Use an API key instead/);
  assert.equal(u.find(ssoPanel.node, 'Sign in'), undefined, 'no password sign-in to offer');
  const key = u.all(ssoPanel.node).find((n) => n['aria-label'] === 'API key');
  key.value = 'eyJ.key.sig';
  await u.find(ssoPanel.node, 'Connect').listeners.click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(sso.calls.at(-1))), ['connect', { address: 'wiki.example.com', method: 'apikey', apiKey: 'eyJ.key.sig' }]);
  assert.match(ssoPanel.node.textContent, /Connected to wiki\.example\.com with an API key\./);
  assert.match(ssoPanel.node.textContent, /signed in with an API key/);
  ssoPanel.dispose();
});

test('Accounts shows who is signed in to Wiki.js', async () => {
  const u = ui();
  const api = wikiApi({ status: async () => ({ connected: true, host: 'wiki.example.com', user: 'Casey Jones', method: 'password' }) });
  const accounts = u.context.makeAccountsSettings(api);
  await settle();
  const row = u.all(accounts.node).filter((n) => n.tag === 'button' && n.classList.contains('account-row')).at(-1);
  assert.match(row.textContent, /Wiki\.js.*Beta.*Casey Jones/);
  accounts.dispose();
  const keyed = u.context.makeAccountsSettings(wikiApi({ status: async () => ({ connected: true, host: 'wiki.example.com', user: '', method: 'apikey' }) }));
  await settle();
  assert.match(u.all(keyed.node).filter((n) => n.classList?.contains('account-row')).at(-1).textContent, /wiki\.example\.com/);
  keyed.dispose();
});

test('Publish to Wiki.js prefills the path, warns before replacing a page edited on the wiki, and links to the page', async () => {
  const u = ui();
  let answers = [{ edited: { path: 'guides/reset-a-password', title: 'Reset a password' } }];
  const api = wikiApi({
    status: async () => ({ connected: true, host: 'wiki.example.com', method: 'apikey' }),
    publish: async (args) => {
      api.calls.push(['publish', args]);
      api.wikiProgress({ guideId: 'guide-1', stage: 'upload', index: 1, count: 2, loaded: 10, total: 20 });
      return answers.shift() || { id: 4, url: 'https://wiki.example.com/en/guides/reset-a-password', title: args.title, updated: true };
    },
  });
  const done = u.context.showPublishToWikiJsDialog({ api, guideId: 'guide-1', guideTitle: 'Reset a password' });
  await settle(); await settle();
  const modal = u.root.children.at(-1);
  const field = (label) => u.all(modal).find((n) => n.tag === 'input' && n['aria-label'] === label);
  assert.deepEqual([field('Page path').value, field('Page title').value, field('Language').value], ['guides/reset-a-password', 'Reset a password', 'en']);
  assert.match(modal.textContent, /The page will be at wiki\.example\.com\/en\/guides\/reset-a-password/);
  assert.match(modal.textContent, /No private details found|Blurred|private/);
  const publish = u.find(modal, 'Publish');
  assert.equal(publish.disabled, false);
  field('Page path').value = 'guides/it/reset';
  field('Page path').listeners.input();
  publish.listeners.click();
  await settle();
  // Asked first, with nothing replaced yet.
  const confirm = u.root.children.at(-1);
  assert.match(confirm.textContent, /This page was edited on the wiki since you last published\. Replace it\?/);
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.filter(([name]) => name === 'publish').map(([, args]) => args))),
    [{ guideId: 'guide-1', path: 'guides/it/reset', title: 'Reset a password', locale: 'en', replace: false }]);
  u.click(u.find(confirm, 'Replace page'));
  await settle(); await settle();
  assert.equal(api.calls.filter(([name]) => name === 'publish').at(-1)[1].replace, true);
  assert.match(modal.textContent, /Updated “Reset a password” on Wiki\.js\./);
  assert.match(modal.textContent, /https:\/\/wiki\.example\.com\/en\/guides\/reset-a-password/);
  u.click(u.find(modal, 'Open in browser'));
  assert.deepEqual(api.calls.at(-1), ['open', 'https://wiki.example.com/en/guides/reset-a-password']);
  u.click(u.find(modal, 'Done'));
  assert.equal(await done, true);

  // Saying no keeps the wiki's version and goes back to the form.
  answers = [{ conflict: { path: 'guides/shared', title: 'Shared' } }];
  u.context.showPublishToWikiJsDialog({ api, guideId: 'guide-1', guideTitle: 'Reset a password' });
  await settle(); await settle();
  const second = u.root.children.at(-1);
  u.find(second, 'Publish').listeners.click();
  await settle();
  const ask = u.root.children.at(-1);
  assert.match(ask.textContent, /A page already exists at guides\/shared\. Replace it\?/);
  u.click(u.find(ask, 'Cancel'));
  await settle();
  assert.equal(api.calls.filter(([name]) => name === 'publish').at(-1)[1].replace, false);
  assert.equal(u.visible(u.find(second, 'Publish')), true);
});

test('Publish to Wiki.js before signing in points to Settings → Accounts', async () => {
  const u = ui();
  let opened = 0;
  const done = u.context.showPublishToWikiJsDialog({ api: wikiApi(), guideId: 'g', guideTitle: 'G', onOpenAccounts: () => { opened += 1; } });
  await settle();
  const modal = u.root.children.at(-1);
  assert.match(modal.textContent, /Settings → Accounts → Wiki\.js/);
  u.click(u.find(modal, 'Set up Wiki.js'));
  assert.equal(opened, 1);
  assert.equal(await done, false);
});

test('Export marks the Confluence and Wiki.js formats as Beta', async () => {
  const u = ui();
  u.context.window.StepForgeDialogs.showExportDialog({
    formats: [{ id: 'pdf', label: 'PDF', description: 'A document.' }, { id: 'wikijs', label: 'Wiki.js', description: 'A Wiki.js page.', badge: 'Beta' }],
    defaultFormat: 'pdf',
    onLoadDefaults: async () => ({}),
  });
  const modal = u.root.children.at(-1);
  const format = u.all(modal).find((n) => n.tag === 'select');
  assert.deepEqual(format.children.map((o) => o.textContent), ['PDF', 'Wiki.js (Beta)']);
  const desc = u.all(modal).find((n) => n.classList?.contains('export-format-desc'));
  assert.equal(u.all(desc).some((n) => n.classList?.contains('beta-badge')), false);
  format.value = 'wikijs';
  format.listeners.change();
  assert.equal(u.all(desc).find((n) => n.classList?.contains('beta-badge'))?.textContent, 'Beta');
  assert.match(desc.textContent, /A Wiki\.js page\./);

  const { FORMAT_INFO } = require('../../exporters');
  assert.deepEqual(Object.keys(FORMAT_INFO).filter((id) => FORMAT_INFO[id].badge === 'Beta'), ['confluence', 'wikijs']);
});

test('the guide menus offer Publish to Wiki.js beside Confluence, both marked Beta', async () => {
  const context = vm.createContext({ window: {}, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8').replace('\nboot();', '\n'), context);
  let items = null;
  context.contextMenu = (x, y, list) => { items = list; };
  const opened = [];
  context.showPublishToWikiJsDialog = async (args) => { opened.push(args.guideId); return false; };
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { view: 'library', library: { guideFolders: {}, folders: [] } };
  app.editor = { guideId: null };
  app.guideContextMenu({ clientX: 0, clientY: 0 }, { guideId: 'g1', title: 'Guide' });
  const publishing = items.filter((item) => /^Publish to (Confluence|Wiki\.js)/.test(item.label));
  assert.deepEqual(JSON.parse(JSON.stringify(publishing.map((item) => [item.label, item.badge]))), [['Publish to Confluence…', 'Beta'], ['Publish to Wiki.js…', 'Beta']]);
  await publishing[1].action();
  assert.deepEqual(opened, ['g1']);
  // The editor's Share menu has the same two items.
  const src = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  assert.equal((src.match(/label: 'Publish to Wiki\.js…', badge: 'Beta'/g) || []).length, 2);
  assert.equal((src.match(/label: 'Publish to Confluence…', badge: 'Beta'/g) || []).length, 2);

  // The menu draws the badge as the same chip Settings uses.
  const appended = [];
  const ui2 = ui();
  ui2.context.document.querySelectorAll = () => [];
  ui2.context.document.body = { append: (node) => appended.push(node) };
  ui2.context.innerWidth = 1000; ui2.context.innerHeight = 800;
  ui2.context.contextMenu(0, 0, [{ label: 'Publish to Wiki.js…', badge: 'Beta', action() {} }]);
  const chip = ui2.all(appended[0]).find((n) => n.classList?.contains('beta-badge'));
  assert.ok(chip && chip.classList.contains('settings-chip'));
});
