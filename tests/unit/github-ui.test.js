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
      waitUntilLive: async (args) => { calls.push(['waitUntilLive', args]); return { live: true }; },
      copy: async (args) => { calls.push(['copy', args]); return { ok: true }; },
      connect: async () => { calls.push(['connect']); return { connected: true, login: 'octo' }; },
      cancel: async () => { calls.push(['cancel']); return { ok: true }; },
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
  const logos = rows.map((row) => row.children[0].children[0].src);
  assert.deepEqual(logos, ['../assets/icons/google-drive.svg', '../assets/icons/github.svg']);
  for (const logo of logos) {
    const file = path.join(__dirname, '../../app/renderer', logo);
    assert.match(fs.readFileSync(file, 'utf8'), /^<svg /, `${logo} ships with the app as a local SVG`);
  }
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
  const row = u.all(accounts.node).filter((n) => n.tag === 'button' && n.classList.contains('account-row'))[1];
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
