'use strict';

/*
 * Settings → Accounts, the GitHub Pages sharing panel, and the "Publish to
 * the web" dialog. Like the Drive panel, GitHub actions apply immediately and
 * all network access happens in the main process.
 */

const PUBLIC_WARNING_TITLE = 'Shared guides are public.';
const PUBLIC_WARNING_TEXT = 'Anyone with the link can open a shared guide, and anyone who looks at your repository on GitHub can find it. '
  + 'Removing a guide takes it off the site, but someone may already have saved a copy.';

function githubPublicWarning(extra = null) {
  return el('div.gh-warning', { role: 'note' },
    el('span.gh-warning-icon', { 'aria-hidden': 'true' }, '!'),
    el('div', {},
      el('strong', {}, PUBLIC_WARNING_TITLE), ' ', PUBLIC_WARNING_TEXT,
      extra ? el('p', {}, extra) : null));
}

function githubExpiryLabel(days) {
  return days === 1 ? '1 day' : `${days} days`;
}

function githubWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'an unknown date'
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function githubTimeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return 'Expired';
  const hours = Math.round(ms / 3600000);
  if (hours < 1) return 'Removed in under an hour';
  if (hours < 48) return `Removed in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `Removed in ${Math.round(hours / 24)} days`;
}

function makeGitHubSettings(api) {
  let current = {};
  let busy = false;
  let disposed = false;
  let signingIn = false;
  let repos = null;
  let listRequest = 0;

  const open = (url) => () => { if (url) void api.shell.openExternal({ url }).catch(() => {}); };
  const banner = el('div.cloud-banner.hidden', { role: 'status', 'aria-live': 'polite' });
  const say = (message, tone = 'info') => {
    banner.textContent = message || '';
    banner.className = `cloud-banner ${tone}${message ? '' : ' hidden'}`;
  };

  const run = async (button, label, action) => {
    if (busy || disposed) return;
    busy = true;
    update(current);
    if (button) setButtonLoading(button, true, label);
    try {
      await action();
    } catch (err) {
      if (!disposed) say(err.message, 'error');
    } finally {
      busy = false;
      if (!disposed) {
        try { current = await api.github.status(); } catch { /* keep the last status */ }
        if (button) setButtonLoading(button, false);
        update(current);
      }
    }
  };

  /* Signed out: what this is, the warning, and the setup steps. */
  const createRepo = el('button', { type: 'button', onClick: () => open(current.links?.newRepository)() }, 'Create a new repository');
  const install = el('button', { type: 'button', onClick: () => open(current.links?.install)() }, 'Install StepForge on GitHub');
  const signIn = el('button.primary', { type: 'button', onClick: () => run(signIn, 'Waiting for GitHub…', async () => {
    signingIn = true;
    cancel.classList.remove('hidden');
    say('Enter the code below on the GitHub page that just opened, then approve StepForge.');
    try {
      await api.github.connect();
      say('Signed in. Now choose the repository for shared guides.', 'success');
      await loadRepositories();
    } finally { signingIn = false; cancel.classList.add('hidden'); }
  }) }, 'Sign in with GitHub');
  const cancel = el('button.hidden', { type: 'button', onClick: () => api.github.cancel().catch((err) => say(err.message, 'error')) }, 'Cancel sign-in');

  const codeText = el('code.gh-code', {}, '');
  const copyCode = el('button', { type: 'button', onClick: async () => {
    try {
      const result = await api.github.copy({ kind: 'code' });
      if (result.ok) say('Code copied. Paste it on the GitHub page.', 'success');
    } catch (err) { say(err.message, 'error'); }
  } }, 'Copy code');
  const reopen = el('button', { type: 'button', onClick: () => open(current.pending?.verificationUri)() }, 'Open GitHub again');
  const codeBox = el('div.gh-code-box.hidden', { role: 'status' },
    el('span.muted', {}, 'Your sign-in code'), codeText,
    el('div.row', {}, copyCode, reopen),
    el('p.muted', {}, 'Waiting for you to approve StepForge on github.com…'));

  const step = (number, title, text, ...actions) => el('li.gh-step', {},
    el('span.gh-step-number', { 'aria-hidden': 'true' }, String(number)),
    el('div.gh-step-body', {}, el('strong', {}, title), el('p.muted', {}, text),
      actions.length ? el('div.row', {}, ...actions) : null));
  // Builds without a registered StepForge GitHub App have nothing to install
  // or sign in to, so say so where the disabled buttons are.
  const unavailable = el('p.gh-note.error.hidden', { role: 'note' },
    'This copy of StepForge isn’t connected to a StepForge GitHub App yet, so the Install and Sign in buttons are turned off. '
    + 'Official releases include it. If you run StepForge from source, see “GitHub Pages sharing: maintainer guide” in the docs.');
  const signedOut = el('div.cloud-stack', {},
    el('div.cloud-hero', {},
      el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, '↗'),
      el('div.cloud-hero-text', {},
        el('strong', {}, 'Share guides on the web'),
        el('p.muted', {}, 'Publish a guide as a web page for 1, 7, or 30 days using GitHub Pages. The page lives in a GitHub repository you own; StepForge doesn’t host anything. When the time is up, the guide is removed automatically.'))),
    githubPublicWarning(),
    el('section.cloud-card', {},
      el('header.cloud-card-head', {}, el('h4', {}, 'Set up sharing (one time)')),
      unavailable,
      el('ol.gh-steps', {},
        step(1, 'Choose a repository for shared guides',
          'The simplest choice is a new public repository just for this, such as “stepforge-guides”. You can also use a repository you already have, as long as it doesn’t already publish a GitHub Pages site. StepForge adds a gh-pages branch and one workflow file to it and leaves everything else alone.',
          createRepo),
        step(2, 'Install StepForge on only that repository',
          'On the GitHub page that opens, choose “Only select repositories”, pick the repository from step 1, and select Install. StepForge asks for access to that repository’s contents, Pages, and workflows, and to nothing else.',
          install),
        step(3, 'Sign in',
          'StepForge shows a short code and opens GitHub. Enter the code there and approve StepForge.',
          signIn, cancel)),
      codeBox,
      el('p.muted', {}, 'Then choose your repository here. StepForge turns on GitHub Pages and adds a small workflow to the repository that removes guides when they expire, even when StepForge is closed.')),
  );

  /* Account header */
  const avatar = el('div.cloud-avatar.gh-avatar', { 'aria-hidden': 'true' }, '?');
  const login = el('strong.cloud-email', {}, 'GitHub account');
  const dot = el('span.cloud-dot', { 'aria-hidden': 'true' });
  const repoLine = el('span', {}, '');
  const disconnect = el('button', { type: 'button', onClick: async () => {
    if (busy || disposed) return;
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, 'Disconnect GitHub?'),
      el('p', {}, 'Shared guides stay online until they expire. To take them down now, remove them before you disconnect.'),
      el('p.muted', {}, 'To fully revoke StepForge’s access, also remove it under Applications in your GitHub settings.')),
    { okLabel: 'Disconnect' });
    if (!ok) return;
    await run(disconnect, 'Disconnecting…', async () => {
      await api.github.disconnect();
      repos = null;
      say('Disconnected on this computer.');
    });
  } }, 'Disconnect');
  const account = el('div.cloud-account', {},
    avatar,
    el('div.cloud-account-info', {}, login, el('div.cloud-status-line', {}, dot, repoLine)),
    el('div.cloud-account-actions', {}, disconnect));

  /* Repository picker */
  const repoSelect = el('select', { 'aria-label': 'Repository for shared guides' });
  const useRepo = el('button.primary', { type: 'button', onClick: () => run(useRepo, 'Setting up…', async () => {
    const fullName = repoSelect.value;
    if (!fullName) throw new Error('Choose a repository first.');
    let status = await api.github.selectRepository({ fullName });
    // A repository with other work in it is used only after the user sees
    // exactly what StepForge will add to it.
    if (status.needsConfirmation) {
      const ok = await confirmDialog(el('div.cloud-confirm', {},
        el('strong', {}, `Use ${status.repo} for shared guides?`),
        el('p', {}, 'This repository already has other files in it. StepForge will:'),
        el('ul.gh-changes', {}, ...status.changes.map((change) => el('li', {}, change))),
        el('p', {}, 'Nothing else in the repository changes.'),
        el('p.muted', {}, 'StepForge’s GitHub App can change any file in a repository it’s installed on, so a separate repository just for shared guides is still the safer choice.')),
      { okLabel: 'Use this repository' });
      if (!ok) return;
      status = await api.github.selectRepository({ fullName, useExisting: true });
    }
    say(status.setupNote ? 'The repository is almost ready. See the steps below.' : `Ready. Guides you share are published from ${fullName}.`,
      status.setupNote ? 'info' : 'success');
    await refreshPublished();
  }) }, 'Use this repository');
  const reloadRepos = el('button', { type: 'button', onClick: () => run(reloadRepos, 'Checking…', loadRepositories) }, 'Refresh');
  const installMore = el('button', { type: 'button', onClick: () => open(current.links?.install)() }, 'Install StepForge on GitHub');
  const repoHint = el('p.muted', {}, '');
  const repoPicker = el('section.cloud-card.hidden', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Choose the repository for shared guides')),
    repoHint,
    el('div.row.gh-repo-row', {}, repoSelect, useRepo),
    el('div.row', {}, installMore, reloadRepos));

  /* Site card */
  const siteLink = el('a.gh-link', { href: '#', onClick: (e) => { e.preventDefault(); open(current.siteUrl)(); } }, '');
  const pagesChip = el('span.cloud-chip', {}, '');
  const expireChip = el('span.cloud-chip', {}, '');
  const privateNote = el('p.gh-note.hidden', {}, 'This repository is private. GitHub Pages sites are public even when the repository is private, and a free GitHub plan can’t publish Pages from a private repository.');
  const setupNote = el('p.gh-note.hidden', {}, '');
  const openPagesSettings = el('button', { type: 'button', onClick: () => open(current.links?.pagesSettings)() }, 'Open Pages settings');
  const checkAgain = el('button', { type: 'button', onClick: () => run(checkAgain, 'Checking…', async () => {
    const status = await api.github.setup();
    say(status.setupNote ? 'Still not ready. See the note above.' : 'Everything is set up.', status.setupNote ? 'error' : 'success');
  }) }, 'Check again');
  const setupActions = el('div.row.hidden', {}, openPagesSettings, checkAgain);
  const openRepo = el('button', { type: 'button', onClick: () => open(current.links?.repository)() }, 'Open repository');
  const siteCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Your site'), openRepo),
    el('div.gh-site', {}, siteLink, el('div.cloud-chips', {}, pagesChip, expireChip)),
    privateNote, setupNote, setupActions);

  /* Shared guides */
  const sharedCount = el('span.cloud-card-meta', {}, '');
  const sharedList = el('div.cloud-guide-list', {}, el('p.muted', {}, 'Loading shared guides…'));
  const refresh = el('button', { type: 'button', onClick: () => run(refresh, 'Refreshing…', refreshPublished) }, 'Refresh');
  const sharedCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Shared guides'), sharedCount, refresh),
    el('p.muted', {}, 'To share a guide, open it and choose Share → Publish to the web. Guides are removed automatically when their time is up.'),
    sharedList);

  /* Advanced */
  const changeRepo = el('button', { type: 'button', onClick: async () => {
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, 'Use a different repository?'),
      el('p', {}, 'Guides already shared from the current repository stay there until they expire. Remove them first if you want them gone now.')),
    { okLabel: 'Choose another' });
    if (!ok) return;
    await run(changeRepo, 'Switching…', async () => {
      await api.github.changeRepository();
      await loadRepositories();
    });
  } }, 'Change repository');
  const advancedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, 'Advanced')),
    el('div.cloud-setting', {},
      el('div', {}, el('strong', {}, 'Use a different repository'),
        el('p.muted', {}, 'Publish future guides from another repository that StepForge is installed on.')),
      changeRepo));

  const ready = el('div.cloud-stack.hidden', {}, githubPublicWarning(), siteCard, sharedCard, advancedCard);

  const renderRepos = () => {
    repoSelect.replaceChildren();
    const list = repos || [];
    for (const repo of list) repoSelect.append(el('option', { value: repo.fullName }, `${repo.fullName}${repo.private ? ' (private)' : ''}`));
    repoSelect.disabled = busy || !list.length;
    useRepo.disabled = busy || !list.length;
    repoHint.textContent = repos === null
      ? 'Loading the repositories StepForge is installed on…'
      : list.length
        ? 'These are the repositories StepForge is installed on. Pick the one for shared guides.'
        : 'StepForge isn’t installed on any of your repositories yet. Install it on the repository you made for shared guides, then select Refresh.';
  };

  let loadingRepos = null;
  function loadRepositories() {
    loadingRepos ||= (async () => {
      repos = null;
      renderRepos();
      try { repos = await api.github.repositories(); } catch (err) { repos = []; if (!disposed) say(err.message, 'error'); }
      if (!disposed) renderRepos();
    })().finally(() => { loadingRepos = null; });
    return loadingRepos;
  }

  async function refreshPublished() {
    if (!current.repo) return;
    const request = ++listRequest;
    let guides;
    try { guides = await api.github.published(); } catch (err) {
      if (!disposed && request === listRequest) sharedList.replaceChildren(el('p.cloud-empty.muted', {}, err.message));
      return;
    }
    if (disposed || request !== listRequest) return;
    sharedCount.textContent = guides.length ? `${guides.length} shared` : '';
    sharedList.replaceChildren();
    if (!guides.length) { sharedList.append(el('p.cloud-empty.muted', {}, 'No guides are shared right now.')); return; }
    for (const guide of guides) {
      const copy = el('button', { type: 'button', onClick: async () => {
        try { const result = await api.github.copy({ kind: 'link', slug: guide.slug }); if (result.ok) say(`Link copied for “${guide.title}”.`, 'success'); }
        catch (err) { say(err.message, 'error'); }
      } }, 'Copy link');
      const view = el('button', { type: 'button', onClick: open(guide.url) }, 'Open');
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(el('div.cloud-confirm', {},
          el('strong', {}, `Stop sharing “${guide.title}”?`),
          el('p', {}, 'The page is removed from your GitHub Pages site and its link stops working within a few minutes. The guide stays in your library.')),
        { danger: true, okLabel: 'Remove from the web' });
        if (!ok) return;
        await run(remove, 'Removing…', async () => {
          await api.github.unpublish({ slug: guide.slug });
          say(`“${guide.title}” is no longer shared.`, 'success');
          await refreshPublished();
        });
      } }, 'Remove');
      sharedList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title || 'Untitled guide'),
            el('div.cloud-chips', {},
              el('span.cloud-chip.local', {}, githubTimeLeft(guide.expiresAt)),
              el('span.muted', { title: guide.url }, `Until ${githubWhen(guide.expiresAt)}`))),
          el('div.cloud-guide-actions', {}, copy, view, remove))));
    }
  }

  function update(next) {
    const wasRepo = current.repo;
    current = next || {};
    const connected = Boolean(current.connected);
    const hasRepo = connected && Boolean(current.repo);
    signedOut.classList.toggle('hidden', connected);
    account.classList.toggle('hidden', !connected);
    repoPicker.classList.toggle('hidden', !connected || hasRepo);
    ready.classList.toggle('hidden', !hasRepo);
    unavailable.classList.toggle('hidden', current.available !== false);
    signIn.disabled = busy || connected || current.available === false;
    install.disabled = !current.links?.install;
    installMore.disabled = !current.links?.install;
    disconnect.disabled = busy;
    changeRepo.disabled = busy;
    checkAgain.disabled = busy;
    refresh.disabled = busy;
    renderRepos();

    codeBox.classList.toggle('hidden', !current.pending);
    codeText.textContent = current.pending?.userCode || '';

    login.textContent = current.login ? `@${current.login}` : 'GitHub account';
    avatar.textContent = (current.login || '?').slice(0, 1).toUpperCase();
    const problem = current.error || current.setupNote;
    dot.className = `cloud-dot ${current.error ? 'error' : !hasRepo || problem ? 'warn' : 'ok'}`;
    repoLine.textContent = hasRepo ? `Sharing from ${current.repo}` : 'Choose a repository to finish setting up';
    if (current.error) say(current.error, 'error');

    siteLink.textContent = current.siteUrl || '';
    siteLink.title = current.siteUrl || '';
    pagesChip.textContent = current.pagesReady ? 'GitHub Pages on' : 'GitHub Pages off';
    pagesChip.className = `cloud-chip${current.pagesReady ? ' local' : ''}`;
    expireChip.textContent = current.autoExpire ? 'Automatic removal on' : 'Removed only while StepForge is open';
    expireChip.className = `cloud-chip${current.autoExpire ? ' local' : ''}`;
    privateNote.classList.toggle('hidden', !current.repoPrivate);
    setupNote.textContent = current.setupNote || '';
    setupNote.classList.toggle('hidden', !current.setupNote);
    setupActions.classList.toggle('hidden', !current.setupNote);

    if (hasRepo && wasRepo !== current.repo) void refreshPublished();
    if (connected && !hasRepo && repos === null && !busy && !loadingRepos) void loadRepositories();
  }

  const node = el('fieldset.cloud-panel.gh-panel', {},
    el('legend', {}, 'GitHub Pages sharing'),
    signedOut, account, banner, repoPicker, ready);
  const unsubscribe = api.github.onStatus((next) => { if (!disposed) update(next); });
  api.github.status().then((next) => { if (!disposed) update(next); }).catch((err) => say(err.message, 'error'));
  return {
    node,
    dispose() { disposed = true; unsubscribe(); if (signingIn) void api.github.cancel().catch(() => {}); },
  };
}

/**
 * Settings → Accounts: a short list of connected services. Choosing one shows
 * its panel with a way back to the list.
 */
function makeAccountsSettings(api, { view = null } = {}) {
  const drive = makeCloudSettings(api);
  const github = makeGitHubSettings(api);
  let disposed = false;

  const driveState = el('span.account-state', {}, 'Checking…');
  const githubState = el('span.account-state', {}, 'Checking…');
  // Service logos ship with the app (app/assets/icons); nothing is fetched.
  const row = (id, icon, name, description, state) => el('button.account-row', { type: 'button', onClick: () => show(id) },
    el(`span.account-icon.${id}`, { 'aria-hidden': 'true' }, el('img', { src: `../assets/icons/${icon}`, alt: '' })),
    el('span.account-text', {}, el('strong', {}, name), el('span.muted', {}, description)),
    state,
    el('span.account-chevron', { 'aria-hidden': 'true' }, '›'));
  const list = el('div.account-list', {},
    row('drive', 'google-drive.svg', 'Google Drive', 'Back up and sync guides between your computers.', driveState),
    row('github', 'github.svg', 'GitHub', 'Share guides on the web for a limited time with GitHub Pages.', githubState));

  const back = el('button.account-back', { type: 'button', onClick: () => show(null) }, '‹ All accounts');
  const detail = el('div.account-detail.hidden', {}, back, drive.node, github.node);

  function show(id) {
    list.classList.toggle('hidden', Boolean(id));
    detail.classList.toggle('hidden', !id);
    drive.node.classList.toggle('hidden', id !== 'drive');
    github.node.classList.toggle('hidden', id !== 'github');
  }

  const setDrive = (status) => {
    if (disposed || !status) return;
    driveState.textContent = status.connected ? status.email || 'Connected' : 'Not connected';
    driveState.classList.toggle('on', Boolean(status.connected));
  };
  const setGitHub = (status) => {
    if (disposed || !status) return;
    githubState.textContent = status.connected ? (status.repo || `@${status.login}`) : 'Not connected';
    githubState.classList.toggle('on', Boolean(status.connected && status.repo));
  };
  const stopDrive = api.cloud.onStatus(setDrive);
  const stopGitHub = api.github.onStatus(setGitHub);
  api.cloud.status().then(setDrive).catch(() => { driveState.textContent = ''; });
  api.github.status().then(setGitHub).catch(() => { githubState.textContent = ''; });
  show(view === 'drive' || view === 'github' ? view : null);

  return {
    node: el('div.accounts', {}, list, detail),
    show,
    dispose() {
      disposed = true;
      stopDrive();
      stopGitHub();
      drive.dispose();
      github.dispose();
    },
  };
}

/**
 * Publish one guide to the user's GitHub Pages site. Resolves when the dialog
 * closes. `onOpenAccounts` opens Settings → Accounts → GitHub.
 */
async function showPublishToWebDialog({ api, guideId, guideTitle, onOpenAccounts }) {
  const status = await api.github.status();
  if (!status.connected || !status.repo) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: 'Publish to the web',
        body: el('div.gh-publish', {},
          el('p', {}, 'Publishing puts a guide on a GitHub Pages site in a GitHub repository you own, for a limited time.'),
          el('p.muted', {}, status.connected
            ? 'Finish setting up in Settings → Accounts → GitHub by choosing the repository for shared guides.'
            : 'To start, connect GitHub in Settings → Accounts → GitHub. It takes a few minutes and walks you through each step.')),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, 'Cancel'),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } }, 'Set up GitHub'),
        ],
        onClose: () => resolve(false),
      });
    });
  }

  return new Promise((resolve) => {
    const body = el('div.gh-publish', {}, el('p.muted', {}, 'Checking what’s already shared…'));
    const cancelBtn = el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, 'Cancel');
    const removeBtn = el('button.danger.hidden', { type: 'button' }, 'Remove from the web');
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, 'Publish');
    const { close } = openModal({
      title: 'Publish to the web',
      body,
      footer: [cancelBtn, removeBtn, publishBtn],
      onClose: () => resolve(false),
    });

    const days = el('select', { 'aria-label': 'How long to keep the guide online' },
      ...status.expiryDays.map((value) => el('option', { value: String(value), selected: value === status.defaultExpiryDays }, githubExpiryLabel(value))));
    const understood = el('input', { type: 'checkbox' });
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    understood.addEventListener('change', () => { publishBtn.disabled = !understood.checked; });

    const showDone = (entry) => {
      const copy = el('button.primary', { type: 'button', onClick: async () => {
        try { const result = await api.github.copy({ kind: 'link', slug: entry.slug }); if (result.ok) toast('Link copied.'); }
        catch (err) { toast(err.message, { error: true }); }
      } }, 'Copy link');
      body.replaceChildren(
        el('p', {}, el('strong', {}, `“${guideTitle}” is shared until ${githubWhen(entry.expiresAt)}.`)),
        el('code.settings-path.gh-url', { title: entry.url }, entry.url),
        el('div.row', {}, copy, el('button', { type: 'button', onClick: () => { void api.shell.openExternal({ url: entry.url }).catch(() => {}); } }, 'Open in browser')),
        el('p.muted', {}, entry.pagesReady
          ? 'GitHub can take a minute or two to put the page online. If the link shows “404”, wait a moment and reload.'
          : 'GitHub Pages isn’t turned on for this repository yet, so the link won’t work until it is. See Settings → Accounts → GitHub.'));
      cancelBtn.textContent = 'Done';
      publishBtn.classList.add('hidden');
      removeBtn.classList.add('hidden');
    };

    publishBtn.addEventListener('click', async () => {
      if (!understood.checked) return;
      error.classList.add('hidden');
      setButtonLoading(publishBtn, true, 'Publishing…');
      removeBtn.disabled = true;
      try {
        const entry = await api.github.publish({ guideId, days: Number(days.value) });
        setButtonLoading(publishBtn, false);
        showDone(entry);
        resolve(true);
      } catch (err) {
        setButtonLoading(publishBtn, false);
        publishBtn.disabled = !understood.checked;
        removeBtn.disabled = false;
        showError(err.message);
      }
    });

    api.github.published().then((guides) => {
      const existing = guides.find((entry) => entry.guideId === guideId) || null;
      // replaceChildren() would print a skipped (null) item as "null".
      body.replaceChildren(...[
        el('p', {}, `Publish “${guideTitle}” as a web page on your GitHub Pages site. Screenshots, text, and annotations are included, the same as an interactive HTML export.`),
        existing ? el('div.cloud-banner', {},
          'This guide is already shared until ', githubWhen(existing.expiresAt), '. Publishing again updates the page with your latest changes and keeps the same link.') : null,
        el('label.gh-field', {}, el('span', {}, 'Keep it online for'), days),
        githubPublicWarning('Before you publish, check every screenshot for passwords, email addresses, customer details, and anything else private. Use the Blur tool to hide it.'),
        status.repoPrivate ? el('p.gh-note', {}, 'Your repository is private, but the published page is still public.') : null,
        status.pagesReady ? null : el('p.gh-note', {}, 'GitHub Pages isn’t turned on for your repository yet. StepForge will try again when you publish; if it still can’t, Settings → Accounts → GitHub explains how to turn it on.'),
        el('label.gh-consent', {}, understood, el('span', {}, 'I understand this guide will be public on the internet.')),
        error,
      ].filter(Boolean));
      if (existing) {
        removeBtn.classList.remove('hidden');
        removeBtn.onclick = async () => {
          const ok = await confirmDialog(`Stop sharing “${guideTitle}”? Its link stops working within a few minutes.`, { danger: true, okLabel: 'Remove from the web' });
          if (!ok) return;
          setButtonLoading(removeBtn, true, 'Removing…');
          try {
            await api.github.unpublish({ slug: existing.slug });
            toast(`“${guideTitle}” is no longer shared.`);
            close();
            resolve(true);
          } catch (err) {
            setButtonLoading(removeBtn, false);
            showError(err.message);
          }
        };
      }
    }).catch((err) => {
      body.replaceChildren(el('p.gh-note.error', { role: 'alert' }, err.message));
    });
  });
}
