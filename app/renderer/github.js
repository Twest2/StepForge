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
  let repos = null;
  let listRequest = 0;
  let signInCancelled = false;
  let setupButton = null;

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
        // update() compares against `current`, so don't overwrite it first.
        let next = current;
        try { next = await api.github.status(); } catch { /* keep the last status */ }
        if (button) setButtonLoading(button, false);
        update(next);
      }
    }
  };

  /* Sign-in. It keeps going in the background if Settings is closed, and
     starting again replaces a sign-in that is still waiting. */
  const signIn = (button) => run(button, 'Waiting for GitHub…', async () => {
    signInCancelled = false;
    say('');
    const reconnecting = Boolean(current.needsSignIn);
    let status;
    try {
      status = await api.github.connect();
    } catch (err) {
      if (signInCancelled) { say('Sign-in cancelled.'); return; }
      throw err;
    }
    if (reconnecting && status.repo) say('Signed in again. You can keep sharing guides.', 'success');
    else say('Signed in.', 'success');
    if (!status.repo) await loadRepositories();
  });
  const cancelSignIn = () => {
    signInCancelled = true;
    void api.github.cancel().catch((err) => say(err.message, 'error'));
  };

  // The one-time code, shown until GitHub approves the sign-in.
  const makeCodeBox = () => {
    const code = el('code.gh-code', {}, '');
    const hint = el('p', {}, '');
    const copy = el('button', { type: 'button', onClick: async () => {
      try {
        const result = await api.github.copy({ kind: 'code' });
        if (result.ok) say('Code copied. Paste it on the GitHub page.', 'success');
      } catch (err) { say(err.message, 'error'); }
    } }, 'Copy code');
    const reopen = el('button', { type: 'button', onClick: () => open(current.pending?.verificationUri)() }, 'Open GitHub again');
    const cancel = el('button', { type: 'button', onClick: cancelSignIn }, 'Cancel');
    const node = el('div.gh-code-box.hidden', { role: 'status', 'aria-live': 'polite' },
      el('span.muted', {}, 'Your one-time code'), code, hint,
      el('div.row', {}, copy, reopen, cancel),
      el('p.gh-waiting.muted', {}, el('span.spinner', { 'aria-hidden': 'true' }), 'Waiting for you to approve StepForge on GitHub…'));
    return {
      node,
      set(pending) {
        node.classList.toggle('hidden', !pending);
        code.textContent = pending?.userCode || '';
        hint.textContent = pending?.copied
          ? 'It’s copied. Paste it on the GitHub page that just opened, then approve StepForge.'
          : 'Enter it on the GitHub page that just opened, then approve StepForge.';
      },
    };
  };

  /* Setup: three steps that tick off as they are done. */
  // `later` is shown in place of the step's content until it can be done.
  const setupStep = (number, title, { later = '' } = {}, ...content) => {
    const badge = el('span.gh-step-number', { 'aria-hidden': 'true' }, String(number));
    const heading = el('strong', {}, title);
    const summary = el('span.gh-step-summary.muted', {}, '');
    const details = el('div.gh-step-content', {}, ...content);
    const node = el('li.gh-step', {}, badge, el('div.gh-step-body', {}, heading, summary, details));
    return {
      node,
      set(state, text = '') {
        const waiting = state === 'upcoming' && later;
        node.className = `gh-step ${state}`;
        badge.textContent = state === 'done' ? '✓' : String(number);
        summary.textContent = waiting ? later : text;
        summary.classList.toggle('hidden', !(waiting || text));
        details.classList.toggle('hidden', state === 'done' || Boolean(waiting));
      },
    };
  };

  const signInButton = el('button.primary', { type: 'button', onClick: () => signIn(signInButton) }, 'Sign in with GitHub');
  const setupCode = makeCodeBox();
  const stepSignIn = setupStep(1, 'Sign in to GitHub', {},
    el('p.muted', {}, 'StepForge opens GitHub and copies a one-time code for you to paste there. You never type your GitHub password into StepForge.'),
    el('div.row', {}, signInButton),
    setupCode.node);

  const createRepo = el('button', { type: 'button', onClick: () => open(current.links?.newRepository)() }, 'Create a repository');
  const install = el('button', { type: 'button', onClick: () => open(current.links?.install)() }, 'Install StepForge on GitHub');
  const checkInstall = el('button', { type: 'button', onClick: () => run(checkInstall, 'Checking…', loadRepositories) }, 'Check again');
  const installWaiting = el('p.gh-waiting.muted.hidden', {}, el('span.spinner', { 'aria-hidden': 'true' }),
    'Waiting for StepForge to be installed. This updates by itself when you come back from GitHub.');
  const stepInstall = setupStep(2, 'Give StepForge one repository', {},
    el('p.muted', {}, 'Create a public repository just for shared guides, such as “stepforge-guides”. Then install StepForge on only that repository: on GitHub, choose “Only select repositories”, pick it, and select Install.'),
    el('p.muted', {}, 'StepForge asks for access to that repository’s contents, Pages, and workflows, and nothing else. You can also use a repository you already have, as long as it doesn’t already publish a GitHub Pages site.'),
    el('div.row', {}, createRepo, install, checkInstall),
    installWaiting);

  const repoSelect = el('select', { 'aria-label': 'Repository for shared guides' });
  const useRepo = el('button.primary', { type: 'button', onClick: () => run(useRepo, 'Setting up…', async () => {
    const fullName = repoSelect.value;
    if (!fullName) throw new Error('Choose a repository first.');
    setupButton = useRepo;
    let status;
    try {
      status = await api.github.selectRepository({ fullName });
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
    } finally { setupButton = null; }
    say(status.setupNote ? 'The repository is almost ready. See Your site below.' : `All set. Guides you share are published from ${fullName}.`,
      status.setupNote ? 'info' : 'success');
  }) }, 'Use this repository');
  const repoHint = el('p.muted', {}, '');
  const stepRepo = setupStep(3, 'Choose the repository', { later: 'Pick the repository from step 2 once StepForge is installed on it.' },
    repoHint,
    el('div.row.gh-repo-row', {}, repoSelect, useRepo));

  // Builds without a registered StepForge GitHub App have nothing to install
  // or sign in to, so say so where the disabled buttons are.
  const unavailable = el('p.gh-note.error.hidden', { role: 'note' },
    'This copy of StepForge isn’t connected to a StepForge GitHub App yet, so the Install and Sign in buttons are turned off. '
    + 'Official releases include it. If you run StepForge from source, see “GitHub Pages sharing: maintainer guide” in the docs.');
  const setupCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Set up sharing (one time)')),
    unavailable,
    el('ol.gh-steps', {}, stepSignIn.node, stepInstall.node, stepRepo.node),
    el('p.muted', {}, 'When you choose the repository, StepForge turns on GitHub Pages and adds a small workflow that removes guides when they expire, even when StepForge is closed.'));
  const intro = el('div.cloud-hero', {},
    el('div.cloud-hero-icon.gh-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: '../assets/icons/github.svg', alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, 'Share guides on the web'),
      el('p.muted', {}, 'Publish a guide as a web page for 1, 7, or 30 days using GitHub Pages. The page lives in a GitHub repository you own; StepForge doesn’t host anything. When the time is up, the guide is removed automatically.')));
  const setupView = el('div.cloud-stack', {}, intro, githubPublicWarning(), setupCard);

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

  /* Sign in again, when the saved sign-in stopped working */
  const reconnectButton = el('button.primary', { type: 'button', onClick: () => signIn(reconnectButton) }, 'Sign in again');
  const reconnectCode = makeCodeBox();
  const reconnectCard = el('section.cloud-card.hidden', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Sign in again')),
    el('p.muted', {}, 'Your GitHub sign-in has expired or was revoked. Sign in again to keep sharing; your repository and shared guides stay as they are.'),
    el('div.row', {}, reconnectButton),
    reconnectCode.node);

  /* Site card */
  const siteLink = el('a.gh-link', { href: '#', onClick: (e) => { e.preventDefault(); open(current.siteUrl)(); } }, '');
  const pagesChip = el('span.cloud-chip', {}, '');
  const expireChip = el('span.cloud-chip', {}, '');
  const privateNote = el('p.gh-note.hidden', {}, 'This repository is private. GitHub Pages sites are public even when the repository is private, and a free GitHub plan can’t publish Pages from a private repository.');
  const setupNote = el('p.gh-note.hidden', {}, '');
  const openPagesSettings = el('button', { type: 'button', onClick: () => open(current.links?.pagesSettings)() }, 'Open Pages settings');
  const checkAgain = el('button', { type: 'button', onClick: () => run(checkAgain, 'Checking…', async () => {
    setupButton = checkAgain;
    let status;
    try { status = await api.github.setup(); } finally { setupButton = null; }
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

  const ready = el('div.cloud-stack.hidden', {}, reconnectCard, githubPublicWarning(), siteCard, sharedCard, advancedCard);

  const renderRepos = () => {
    const chosen = repoSelect.value;
    repoSelect.replaceChildren();
    const list = repos || [];
    for (const repo of list) repoSelect.append(el('option', { value: repo.fullName, selected: repo.fullName === chosen }, `${repo.fullName}${repo.private ? ' (private)' : ''}`));
    repoSelect.disabled = busy || !list.length;
    useRepo.disabled = busy || !list.length;
    repoHint.textContent = list.length
      ? 'These are the repositories StepForge is installed on. Pick the one for shared guides.'
      : 'Once StepForge is installed on a repository, choose it here.';
  };

  let loadingRepos = null;
  // `quiet` keeps the current list on screen while checking again. The work
  // starts on the next tick so `loadingRepos` is set before update() runs.
  function loadRepositories({ quiet = false } = {}) {
    loadingRepos ||= Promise.resolve().then(async () => {
      if (!quiet) { repos = null; update(current); }
      try { repos = await api.github.repositories(); } catch (err) {
        if (!quiet) { repos = []; if (!disposed) say(err.message, 'error'); }
      }
      if (!disposed) update(current);
    }).finally(() => { loadingRepos = null; });
    return loadingRepos;
  }

  // Coming back from GitHub after installing the App updates the list.
  const onFocus = () => {
    if (disposed || busy || loadingRepos || !current.connected || current.repo) return;
    void loadRepositories({ quiet: true });
  };
  window.addEventListener?.('focus', onFocus);

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
    const wasBlocked = Boolean(current.needsSignIn);
    current = next || {};
    const connected = Boolean(current.connected);
    const needsSignIn = Boolean(current.needsSignIn);
    const hasRepo = connected && Boolean(current.repo);
    setupView.classList.toggle('hidden', hasRepo);
    account.classList.toggle('hidden', !connected);
    ready.classList.toggle('hidden', !hasRepo);
    reconnectCard.classList.toggle('hidden', !needsSignIn);
    unavailable.classList.toggle('hidden', current.available !== false);

    // Step 1: sign in. Step 2: install on a repository. Step 3: choose it.
    const signedIn = connected && !needsSignIn;
    const installed = signedIn && Boolean(repos?.length);
    stepSignIn.set(signedIn ? 'done' : 'current', signedIn ? `Signed in as @${current.login}.` : '');
    stepInstall.set(installed ? 'done' : signedIn ? 'current' : 'upcoming',
      installed ? `StepForge is installed on ${repos.length === 1 ? repos[0].fullName : `${repos.length} repositories`}.` : '');
    stepRepo.set(installed ? 'current' : 'upcoming');
    installWaiting.classList.toggle('hidden', !(signedIn && repos && !repos.length));

    // A loading button shows its spinner label until the sign-in finishes.
    if (!signInButton.classList.contains('loading')) {
      signInButton.textContent = current.pending ? 'Get a new code' : needsSignIn ? 'Sign in again' : 'Sign in with GitHub';
      signInButton.disabled = busy || current.available === false;
    }
    if (!reconnectButton.classList.contains('loading')) reconnectButton.disabled = busy;
    install.disabled = !current.links?.install;
    checkInstall.disabled = busy || !signedIn;
    disconnect.disabled = busy;
    changeRepo.disabled = busy;
    checkAgain.disabled = busy;
    refresh.disabled = busy;
    renderRepos();

    setupCode.set(hasRepo ? null : current.pending);
    reconnectCode.set(hasRepo ? current.pending : null);

    login.textContent = current.login ? `@${current.login}` : 'GitHub account';
    avatar.textContent = (current.login || '?').slice(0, 1).toUpperCase();
    const problem = current.error || current.setupNote;
    dot.className = `cloud-dot ${current.error ? 'error' : !hasRepo || problem ? 'warn' : 'ok'}`;
    repoLine.textContent = needsSignIn ? 'Sign in again to keep sharing'
      : hasRepo ? `Sharing from ${current.repo}` : 'Finish setting up below';
    if (current.error && !needsSignIn) say(current.error, 'error');

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

    if (hasRepo && needsSignIn) {
      listRequest += 1;
      sharedCount.textContent = '';
      sharedList.replaceChildren(el('p.cloud-empty.muted', {}, 'Sign in again to see and manage your shared guides.'));
    }
    if (hasRepo && !needsSignIn && (wasRepo !== current.repo || wasBlocked)) void refreshPublished();
    if (signedIn && !hasRepo && repos === null && !busy && !loadingRepos) void loadRepositories();
  }

  const node = el('fieldset.cloud-panel.gh-panel', {},
    el('legend', {}, 'GitHub Pages sharing'),
    account, banner, setupView, ready);
  const unsubscribe = api.github.onStatus((next) => { if (!disposed) update(next); });
  // Setting up a repository takes a few seconds; show which step is running.
  const stopProgress = api.github.onProgress((progress) => {
    if (!disposed && progress?.task === 'setup' && setupButton) setButtonLoading(setupButton, true, progress.message);
  });
  api.github.status().then((next) => { if (!disposed) update(next); }).catch((err) => say(err.message, 'error'));
  return {
    node,
    dispose() {
      disposed = true;
      unsubscribe();
      stopProgress();
      window.removeEventListener?.('focus', onFocus);
    },
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
    githubState.textContent = status.needsSignIn ? 'Sign in again'
      : status.connected ? (status.repo || `@${status.login}`) : 'Not connected';
    githubState.classList.toggle('on', Boolean(status.connected && status.repo && !status.needsSignIn));
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

const GITHUB_PUBLISH_STAGES = [
  ['export', 'Prepare the page'],
  ['upload', 'Upload to GitHub'],
  ['commit', 'Update your site'],
];

/** What publishing is doing: each stage, and a progress bar while the page uploads. */
function githubPublishProgress(guideTitle) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': 'Publishing progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const detail = el('span.gh-progress-detail.muted', {}, '');
  const stages = GITHUB_PUBLISH_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    const note = el('span.gh-stage-note.muted', {}, '');
    return { id, icon, note, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label), note) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, `Publishing “${guideTitle}”`)),
    el('ol.gh-stages', {}, ...stages.map((stage) => stage.node)),
    el('div.gh-upload', {}, bar, detail),
    el('p.muted', {}, 'You can close this window. StepForge keeps publishing and lets you know when it’s done.'));

  const set = (progress) => {
    const at = Math.max(0, GITHUB_PUBLISH_STAGES.findIndex(([id]) => id === progress?.stage));
    stages.forEach((stage, index) => {
      const state = index < at ? 'done' : index === at ? 'active' : 'upcoming';
      stage.node.className = `gh-stage ${state}`;
      stage.icon.replaceChildren(state === 'done' ? '✓' : state === 'active' ? el('span.spinner') : '');
      stage.note.textContent = '';
    });
    if (progress?.stage === 'upload' && progress.total) {
      const percent = Math.min(100, Math.floor((progress.loaded / progress.total) * 100));
      const rate = progress.bytesPerSecond ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : '';
      bar.classList.remove('indeterminate');
      fill.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
      stages[1].note.textContent = `${percent}%`;
      detail.textContent = `${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}${rate}`;
    } else if (progress?.stage === 'commit') {
      bar.classList.remove('indeterminate');
      fill.style.width = '100%';
      bar.setAttribute('aria-valuenow', '100');
      detail.textContent = 'Uploaded. Saving it to your GitHub Pages site…';
    } else {
      bar.classList.add('indeterminate');
      bar.removeAttribute('aria-valuenow');
      detail.textContent = 'Building the web page from your guide…';
    }
  };
  set({ stage: 'export' });
  return { node, set };
}

/** Publish one guide while `progress` shows how it's going. Resolves with the entry. */
async function githubRunPublish(api, { guideId, request, progress }) {
  const stop = api.github.onProgress((update) => {
    if (update?.task === 'publish' && update.guideId === guideId) progress.set(update);
  });
  try {
    return await api.github.publish({ guideId, ...request });
  } finally {
    stop();
  }
}

/** The link to a just-published guide, with Copy and Open, and whether it's live yet. */
function githubPublishedView(api, entry, guideTitle) {
  const copy = el('button.primary', { type: 'button', onClick: async () => {
    try { const result = await api.github.copy({ kind: 'link', slug: entry.slug }); if (result.ok) toast('Link copied.'); }
    catch (err) { toast(err.message, { error: true }); }
  } }, 'Copy link');
  const live = el('p.gh-live', { role: 'status', 'aria-live': 'polite' });
  const setLive = (state, text) => {
    live.className = `gh-live ${state}`;
    live.replaceChildren(state === 'waiting' ? el('span.spinner', { 'aria-hidden': 'true' }) : el('span.gh-live-dot', { 'aria-hidden': 'true' }), text);
  };
  if (entry.pagesReady) {
    setLive('waiting', 'Going live on GitHub Pages. This usually takes under a minute, and you can copy the link now.');
    api.github.waitUntilLive({ slug: entry.slug })
      .then((result) => {
        if (result?.live) setLive('ok', 'Live. Anyone with the link can open it now.');
        else setLive('slow', 'GitHub is taking longer than usual. The link will work as soon as GitHub finishes publishing it.');
      })
      .catch(() => setLive('slow', 'StepForge couldn’t check the link. It will work as soon as GitHub finishes publishing it.'));
  } else {
    setLive('slow', 'GitHub Pages isn’t turned on for this repository yet, so the link won’t work until it is. See Settings → Accounts → GitHub.');
  }
  return [
    el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
      el('strong', {}, `“${guideTitle}” is shared until ${githubWhen(entry.expiresAt)}.`)),
    el('code.settings-path.gh-url', { title: entry.url }, entry.url),
    el('div.row', {}, copy, el('button', { type: 'button', onClick: () => { void api.shell.openExternal({ url: entry.url }).catch(() => {}); } }, 'Open in browser')),
    live,
  ];
}

/**
 * Publish straight away with progress, for Export → "Export and publish".
 * `request` is { days, format, options }. Resolves when the dialog closes.
 */
function showPublishProgressDialog({ api, guideId, guideTitle, request }) {
  return new Promise((resolve) => {
    const progress = githubPublishProgress(guideTitle);
    const body = el('div.gh-publish', {}, progress.node);
    let open = true;
    const closeBtn = el('button', { type: 'button', onClick: () => { open = false; close(); resolve(); } }, 'Close');
    const { close } = openModal({
      title: 'Publish on the web',
      body,
      footer: [closeBtn],
      onClose: () => { open = false; resolve(); },
    });
    githubRunPublish(api, { guideId, request, progress })
      .then((entry) => {
        if (!open) { toast(`“${guideTitle}” is on the web. Copy its link in Settings → Accounts → GitHub.`); return; }
        body.replaceChildren(...githubPublishedView(api, entry, guideTitle));
        closeBtn.textContent = 'Done';
      })
      .catch((err) => {
        const message = `The guide was exported, but publishing it on the web failed: ${err.message}`;
        if (!open) { toast(message, { error: true }); return; }
        body.replaceChildren(el('p.gh-note.error', { role: 'alert' }, message));
      });
  });
}

/**
 * Publish one guide to the user's GitHub Pages site. Resolves when the dialog
 * closes. `onOpenAccounts` opens Settings → Accounts → GitHub.
 */
async function showPublishToWebDialog({ api, guideId, guideTitle, onOpenAccounts }) {
  const status = await api.github.status();
  if (!status.connected || !status.repo || status.needsSignIn) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: 'Publish to the web',
        body: el('div.gh-publish', {},
          el('p', {}, 'Publishing puts a guide on a GitHub Pages site in a GitHub repository you own, for a limited time.'),
          el('p.muted', {}, status.needsSignIn
            ? 'Your GitHub sign-in has expired. Sign in again in Settings → Accounts → GitHub; your repository and shared guides stay as they are.'
            : status.connected
              ? 'Finish setting up in Settings → Accounts → GitHub by choosing the repository for shared guides.'
              : 'To start, connect GitHub in Settings → Accounts → GitHub. It takes a few minutes and walks you through each step.')),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, 'Cancel'),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } },
            status.needsSignIn ? 'Sign in again' : 'Set up GitHub'),
        ],
        onClose: () => resolve(false),
      });
    });
  }

  return new Promise((resolve) => {
    const body = el('div.gh-publish', {}, el('p.muted', {}, 'Checking what’s already shared…'));
    let open = true;
    let publishing = false;
    const cancelBtn = el('button', { type: 'button', onClick: () => { open = false; close(); resolve(publishing); } }, 'Cancel');
    const removeBtn = el('button.danger.hidden', { type: 'button' }, 'Remove from the web');
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, 'Publish');
    const { close } = openModal({
      title: 'Publish to the web',
      body,
      footer: [cancelBtn, removeBtn, publishBtn],
      onClose: () => { open = false; resolve(publishing); },
    });

    const days = el('select', { 'aria-label': 'How long to keep the guide online' },
      ...status.expiryDays.map((value) => el('option', { value: String(value), selected: value === status.defaultExpiryDays }, githubExpiryLabel(value))));
    const understood = el('input', { type: 'checkbox' });
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    understood.addEventListener('change', () => { publishBtn.disabled = !understood.checked; });
    let form = null;

    publishBtn.addEventListener('click', async () => {
      if (!understood.checked || publishing) return;
      publishing = true;
      error.classList.add('hidden');
      const progress = githubPublishProgress(guideTitle);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      removeBtn.classList.add('hidden');
      cancelBtn.textContent = 'Close';
      try {
        const entry = await githubRunPublish(api, { guideId, request: { days: Number(days.value) }, progress });
        if (!open) { toast(`“${guideTitle}” is on the web. Copy its link in Settings → Accounts → GitHub.`); return; }
        body.replaceChildren(...githubPublishedView(api, entry, guideTitle));
        cancelBtn.textContent = 'Done';
        resolve(true);
      } catch (err) {
        publishing = false;
        if (!open) { toast(`Publishing “${guideTitle}” failed: ${err.message}`, { error: true }); return; }
        // Back to the form, with what went wrong.
        body.replaceChildren(form);
        publishBtn.classList.remove('hidden');
        publishBtn.disabled = !understood.checked;
        removeBtn.classList.toggle('hidden', !removeBtn.onclick);
        cancelBtn.textContent = 'Cancel';
        showError(err.message);
      }
    });

    api.github.published().then((guides) => {
      if (!open || publishing) return;
      const existing = guides.find((entry) => entry.guideId === guideId) || null;
      // replaceChildren() would print a skipped (null) item as "null".
      form = el('div.gh-publish', {}, ...[
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
      body.replaceChildren(form);
      if (existing) {
        removeBtn.classList.remove('hidden');
        removeBtn.onclick = async () => {
          const ok = await confirmDialog(`Stop sharing “${guideTitle}”? Its link stops working within a few minutes.`, { danger: true, okLabel: 'Remove from the web' });
          if (!ok) return;
          setButtonLoading(removeBtn, true, 'Removing…');
          publishBtn.disabled = true;
          try {
            await api.github.unpublish({ slug: existing.slug });
            toast(`“${guideTitle}” is no longer shared.`);
            open = false;
            close();
            resolve(true);
          } catch (err) {
            setButtonLoading(removeBtn, false);
            publishBtn.disabled = !understood.checked;
            showError(err.message);
          }
        };
      }
    }).catch((err) => {
      if (open && !publishing) body.replaceChildren(el('p.gh-note.error', { role: 'alert' }, err.message));
    });
  });
}
