'use strict';

/*
 * Settings → Accounts, the GitHub Pages sharing panel, and the "Publish to
 * the web" dialog. Like the Drive panel, GitHub actions apply immediately and
 * all network access happens in the main process.
 */

const PUBLIC_WARNING_TITLE = t('Shared guides are public.');
const PUBLIC_WARNING_TEXT = 'Anyone with the link can open a shared guide, and anyone who looks at your repository on GitHub can find it. '
  + t('Removing a guide takes it off the site, but someone may already have saved a copy.');

function githubPublicWarning(extra = null) {
  return el('div.gh-warning', { role: 'note' },
    el('span.gh-warning-icon', { 'aria-hidden': 'true' }, '!'),
    el('div', {},
      el('strong', {}, PUBLIC_WARNING_TITLE), ' ', PUBLIC_WARNING_TEXT,
      extra ? el('p', {}, extra) : null));
}

function githubExpiryLabel(days) {
  return tn(days, '{count} day', '{count} days');
}

function githubWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? t('an unknown date')
    : date.toLocaleString(dateLocale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function githubTimeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return t('Expired');
  const hours = Math.round(ms / 3600000);
  if (hours < 1) return t('Removed in under an hour');
  if (hours < 48) return tn(hours, 'Removed in {count} hour', 'Removed in {count} hours');
  return tn(Math.round(hours / 24), 'Removed in {count} day', 'Removed in {count} days');
}

/** When each guide in the library was last changed, by id. Empty if the library can't be read. */
async function guideUpdatedTimes(api) {
  try {
    const { guides } = await api.library.list();
    return new Map(guides.map((guide) => [guide.guideId, guide.updatedAt]));
  } catch { return new Map(); }
}

/** True when a guide was changed after it was shared, so the public copy is behind. */
function editedSinceShared(updatedAt, publishedAt) {
  const edited = Date.parse(updatedAt);
  const shared = Date.parse(publishedAt);
  return Number.isFinite(edited) && Number.isFinite(shared) && edited > shared;
}

/**
 * `onPublishToWeb(guideId, title)` opens the Publish dialog the way the app
 * does (saving the open editor first); without it the dialog opens directly.
 */
function makeGitHubSettings(api, { onPublishToWeb = null } = {}) {
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
  const signIn = (button) => run(button, t('Waiting for GitHub…'), async () => {
    signInCancelled = false;
    say('');
    const reconnecting = Boolean(current.needsSignIn);
    let status;
    try {
      status = await api.github.connect();
    } catch (err) {
      if (signInCancelled) { say(t('Sign-in cancelled.')); return; }
      throw err;
    }
    if (reconnecting && status.repo) say(t('Signed in again. You can keep sharing guides.'), 'success');
    else say(t('Signed in.'), 'success');
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
        if (result.ok) say(t('Code copied. Paste it on the GitHub page.'), 'success');
      } catch (err) { say(err.message, 'error'); }
    } }, t('Copy code'));
    const reopen = el('button', { type: 'button', onClick: () => open(current.pending?.verificationUri)() }, t('Open GitHub again'));
    const cancel = el('button', { type: 'button', onClick: cancelSignIn }, t('Cancel'));
    const node = el('div.gh-code-box.hidden', { role: 'status', 'aria-live': 'polite' },
      el('span.muted', {}, t('Your one-time code')), code, hint,
      el('div.row', {}, copy, reopen, cancel),
      el('p.gh-waiting.muted', {}, el('span.spinner', { 'aria-hidden': 'true' }), t('Waiting for you to approve StepForge on GitHub…')));
    return {
      node,
      set(pending) {
        node.classList.toggle('hidden', !pending);
        code.textContent = pending?.userCode || '';
        hint.textContent = pending?.copied
          ? t('It’s copied. Paste it on the GitHub page that just opened, then approve StepForge.')
          : t('Enter it on the GitHub page that just opened, then approve StepForge.');
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

  const signInButton = el('button.primary', { type: 'button', onClick: () => signIn(signInButton) }, t('Sign in with GitHub'));
  const setupCode = makeCodeBox();
  const stepSignIn = setupStep(1, t('Sign in to GitHub'), {},
    el('p.muted', {}, t('StepForge opens GitHub and copies a one-time code for you to paste there. You never type your GitHub password into StepForge.')),
    el('div.row', {}, signInButton),
    setupCode.node);

  const createRepo = el('button', { type: 'button', onClick: () => open(current.links?.newRepository)() }, t('Create a repository'));
  const install = el('button', { type: 'button', onClick: () => open(current.links?.install)() }, t('Install StepForge on GitHub'));
  const checkInstall = el('button', { type: 'button', onClick: () => run(checkInstall, t('Checking…'), loadRepositories) }, t('Check again'));
  const installWaiting = el('p.gh-waiting.muted.hidden', {}, el('span.spinner', { 'aria-hidden': 'true' }),
    t('Waiting for StepForge to be installed. This updates by itself when you come back from GitHub.'));
  const stepInstall = setupStep(2, t('Give StepForge one repository'), {},
    el('p.muted', {}, t('Create a public repository just for shared guides, such as “stepforge-guides”. Then install StepForge on only that repository: on GitHub, choose “Only select repositories”, pick it, and select Install.')),
    el('p.muted', {}, t('StepForge asks for access to that repository’s contents, Pages, and workflows, and nothing else. You can also use a repository you already have, as long as it doesn’t already publish a GitHub Pages site.')),
    el('div.row', {}, createRepo, install, checkInstall),
    installWaiting);

  const repoSelect = el('select', { 'aria-label': t('Repository for shared guides') });
  const useRepo = el('button.primary', { type: 'button', onClick: () => run(useRepo, t('Setting up…'), async () => {
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
          el('strong', {}, t('Use {repo} for shared guides?', { repo: status.repo })),
          el('p', {}, t('This repository already has other files in it. StepForge will:')),
          el('ul.gh-changes', {}, ...status.changes.map((change) => el('li', {}, change))),
          el('p', {}, t('Nothing else in the repository changes.')),
          el('p.muted', {}, t('StepForge’s GitHub App can change any file in a repository it’s installed on, so a separate repository just for shared guides is still the safer choice.'))),
        { okLabel: t('Use this repository') });
        if (!ok) return;
        status = await api.github.selectRepository({ fullName, useExisting: true });
      }
    } finally { setupButton = null; }
    say(status.setupNote ? t('The repository is almost ready. See Your site below.') : t('All set. Guides you share are published from {repo}.', { repo: fullName }),
      status.setupNote ? 'info' : 'success');
  }) }, t('Use this repository'));
  const repoHint = el('p.muted', {}, '');
  const stepRepo = setupStep(3, t('Choose the repository'), { later: t('Pick the repository from step 2 once StepForge is installed on it.') },
    repoHint,
    el('div.row.gh-repo-row', {}, repoSelect, useRepo));

  // Builds without a registered StepForge GitHub App have nothing to install
  // or sign in to, so say so where the disabled buttons are.
  const unavailable = el('p.gh-note.error.hidden', { role: 'note' },
    'This copy of StepForge isn’t connected to a StepForge GitHub App yet, so the Install and Sign in buttons are turned off. '
    + t('Official releases include it. If you run StepForge from source, see “GitHub Pages sharing: maintainer guide” in the docs.'));
  const setupCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Set up sharing (one time)'))),
    unavailable,
    el('ol.gh-steps', {}, stepSignIn.node, stepInstall.node, stepRepo.node),
    el('p.muted', {}, t('When you choose the repository, StepForge turns on GitHub Pages and adds a small workflow that removes guides when they expire, even when StepForge is closed.')));
  const intro = el('div.cloud-hero', {},
    el('div.cloud-hero-icon.gh-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: '../assets/icons/github.svg', alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, t('Share guides on the web')),
      el('p.muted', {}, t('Publish a guide as a web page for 1, 7, or 30 days using GitHub Pages. The page lives in a GitHub repository you own; StepForge doesn’t host anything. When the time is up, the guide is removed automatically.'))));
  const setupView = el('div.cloud-stack', {}, intro, githubPublicWarning(), setupCard);

  /* Account header */
  const avatar = el('div.cloud-avatar.gh-avatar', { 'aria-hidden': 'true' }, '?');
  const login = el('strong.cloud-email', {}, t('GitHub account'));
  const dot = el('span.cloud-dot', { 'aria-hidden': 'true' });
  const repoLine = el('span', {}, '');
  const disconnect = el('button', { type: 'button', onClick: async () => {
    if (busy || disposed) return;
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, t('Disconnect GitHub?')),
      el('p', {}, t('Shared guides stay online until they expire. To take them down now, remove them before you disconnect.')),
      el('p.muted', {}, t('To fully revoke StepForge’s access, also remove it under Applications in your GitHub settings.'))),
    { okLabel: t('Disconnect') });
    if (!ok) return;
    await run(disconnect, t('Disconnecting…'), async () => {
      await api.github.disconnect();
      repos = null;
      say(t('Disconnected on this computer.'));
    });
  } }, t('Disconnect'));
  const account = el('div.cloud-account', {},
    avatar,
    el('div.cloud-account-info', {}, login, el('div.cloud-status-line', {}, dot, repoLine)),
    el('div.cloud-account-actions', {}, disconnect));

  /* Sign in again, when the saved sign-in stopped working */
  const reconnectButton = el('button.primary', { type: 'button', onClick: () => signIn(reconnectButton) }, t('Sign in again'));
  const reconnectCode = makeCodeBox();
  const reconnectCard = el('section.cloud-card.hidden', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Sign in again'))),
    el('p.muted', {}, t('Your GitHub sign-in has expired or was revoked. Sign in again to keep sharing; your repository and shared guides stay as they are.')),
    el('div.row', {}, reconnectButton),
    reconnectCode.node);

  /* Site card */
  const siteLink = el('a.gh-link', { href: '#', onClick: (e) => { e.preventDefault(); open(current.siteUrl)(); } }, '');
  const pagesChip = el('span.cloud-chip', {}, '');
  const expireChip = el('span.cloud-chip', {}, '');
  const privateNote = el('p.gh-note.hidden', {}, t('This repository is private. GitHub Pages sites are public even when the repository is private, and a free GitHub plan can’t publish Pages from a private repository.'));
  const setupNote = el('p.gh-note.hidden', {}, '');
  const openPagesSettings = el('button', { type: 'button', onClick: () => open(current.links?.pagesSettings)() }, t('Open Pages settings'));
  const checkAgain = el('button', { type: 'button', onClick: () => run(checkAgain, t('Checking…'), async () => {
    setupButton = checkAgain;
    let status;
    try { status = await api.github.setup(); } finally { setupButton = null; }
    say(status.setupNote ? t('Still not ready. See the note above.') : t('Everything is set up.'), status.setupNote ? 'error' : 'success');
  }) }, t('Check again'));
  const setupActions = el('div.row.hidden', {}, openPagesSettings, checkAgain);
  const openRepo = el('button', { type: 'button', onClick: () => open(current.links?.repository)() }, t('Open repository'));
  const siteCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Your site')), openRepo),
    el('div.gh-site', {}, siteLink, el('div.cloud-chips', {}, pagesChip, expireChip)),
    privateNote, setupNote, setupActions);

  /* Shared guides */
  const sharedCount = el('span.cloud-card-meta', {}, '');
  const sharedList = el('div.cloud-guide-list', {}, el('p.muted', {}, t('Loading shared guides…')));
  const refresh = el('button', { type: 'button', onClick: () => run(refresh, t('Refreshing…'), refreshPublished) }, t('Refresh'));
  const sharedCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Shared guides')), sharedCount, refresh),
    el('p.muted', {}, t('To share a guide, open it and choose Share → Publish to the web. Guides are removed automatically when their time is up.')),
    sharedList);

  /* Advanced */
  const changeRepo = el('button', { type: 'button', onClick: async () => {
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, t('Use a different repository?')),
      el('p', {}, t('Guides already shared from the current repository stay there until they expire. Remove them first if you want them gone now.'))),
    { okLabel: t('Choose another') });
    if (!ok) return;
    await run(changeRepo, t('Switching…'), async () => {
      await api.github.changeRepository();
      await loadRepositories();
    });
  } }, t('Change repository'));
  const advancedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, t('Advanced'))),
    el('div.cloud-setting', {},
      el('div', {}, el('strong', {}, t('Use a different repository')),
        el('p.muted', {}, t('Publish future guides from another repository that StepForge is installed on.'))),
      changeRepo));

  const ready = el('div.cloud-stack.hidden', {}, reconnectCard, githubPublicWarning(), siteCard, sharedCard, advancedCard);

  const renderRepos = () => {
    const chosen = repoSelect.value;
    repoSelect.replaceChildren();
    const list = repos || [];
    for (const repo of list) repoSelect.append(el('option', { value: repo.fullName, selected: repo.fullName === chosen }, repo.private ? t('{repo} (private)', { repo: repo.fullName }) : repo.fullName));
    repoSelect.disabled = busy || !list.length;
    useRepo.disabled = busy || !list.length;
    repoHint.textContent = list.length
      ? t('These are the repositories StepForge is installed on. Pick the one for shared guides.')
      : t('Once StepForge is installed on a repository, choose it here.');
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
    let updated;
    try { [guides, updated] = await Promise.all([api.github.published(), guideUpdatedTimes(api)]); } catch (err) {
      if (!disposed && request === listRequest) sharedList.replaceChildren(el('p.cloud-empty.muted', {}, err.message));
      return;
    }
    if (disposed || request !== listRequest) return;
    sharedCount.textContent = guides.length ? t('{count} shared', { count: guides.length }) : '';
    sharedList.replaceChildren();
    if (!guides.length) { sharedList.append(el('p.cloud-empty.muted', {}, t('No guides are shared right now.'))); return; }
    for (const guide of guides) {
      const copy = el('button', { type: 'button', onClick: async () => {
        try { const result = await api.github.copy({ kind: 'link', slug: guide.slug }); if (result.ok) say(t('Link copied for “{title}”.', { title: guide.title }), 'success'); }
        catch (err) { say(err.message, 'error'); }
      } }, t('Copy link'));
      const view = el('button', { type: 'button', onClick: open(guide.url) }, t('Open'));
      const extend = el('button', { type: 'button', onClick: (event) => {
        if (busy || disposed) return;
        const rect = event.currentTarget.getBoundingClientRect();
        contextMenu(rect.left, rect.bottom + 4, [1, 7, 30].map((days) => ({
          label: t('Keep online for {time} from now', { time: githubExpiryLabel(days) }),
          action: () => run(extend, t('Extending…'), async () => {
            await api.github.extend({ slug: guide.slug, days });
            say(t('“{title}” stays online for {time} from now.', { title: guide.title, time: githubExpiryLabel(days) }), 'success');
            await refreshPublished();
          }),
        })));
      } }, t('Extend'));
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(el('div.cloud-confirm', {},
          el('strong', {}, t('Stop sharing “{title}”?', { title: guide.title })),
          el('p', {}, t('The page is removed from your GitHub Pages site and its link stops working within a few minutes. The guide stays in your library.'))),
        { danger: true, okLabel: t('Remove from the web') });
        if (!ok) return;
        await run(remove, t('Removing…'), async () => {
          await api.github.unpublish({ slug: guide.slug });
          say(t('“{title}” is no longer shared.', { title: guide.title }), 'success');
          await refreshPublished();
        });
      } }, t('Remove'));
      sharedList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title || t('Untitled guide')),
            el('div.cloud-chips', {},
              el('span.cloud-chip.local', {}, githubTimeLeft(guide.expiresAt)),
              el('span.muted', { title: guide.url }, t('Until {when}', { when: githubWhen(guide.expiresAt) })),
              editedSinceShared(updated.get(guide.guideId), guide.publishedAt)
                ? el('button.cloud-chip.stale', {
                  type: 'button',
                  title: t('This guide changed after you shared it. Publish it again to update the public copy.'),
                  onClick: () => {
                    if (busy || disposed) return;
                    // The normal Publish dialog, with its public-content checkbox. The
                    // app saves edits still waiting in the editor first, so the update
                    // includes them.
                    const title = guide.title || t('Untitled guide');
                    const publish = onPublishToWeb
                      ? Promise.resolve(onPublishToWeb(guide.guideId, title))
                      : showPublishToWebDialog({ api, guideId: guide.guideId, guideTitle: title, onOpenAccounts: () => {} });
                    void publish.catch((err) => say(err.message, 'error'))
                      .then(() => { if (!disposed) void refreshPublished(); });
                  },
                }, t('Edited since you shared it')) : null)),
          el('div.cloud-guide-actions', {}, copy, view, extend, remove))));
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
    stepSignIn.set(signedIn ? 'done' : 'current', signedIn ? t('Signed in as {user}.', { user: `@${current.login}` }) : '');
    stepInstall.set(installed ? 'done' : signedIn ? 'current' : 'upcoming',
      installed ? (repos.length === 1 ? t('StepForge is installed on {repo}.', { repo: repos[0].fullName })
        : tn(repos.length, 'StepForge is installed on {count} repository.', 'StepForge is installed on {count} repositories.')) : '');
    stepRepo.set(installed ? 'current' : 'upcoming');
    installWaiting.classList.toggle('hidden', !(signedIn && repos && !repos.length));

    // A loading button shows its spinner label until the sign-in finishes.
    if (!signInButton.classList.contains('loading')) {
      signInButton.textContent = current.pending ? t('Get a new code') : needsSignIn ? t('Sign in again') : t('Sign in with GitHub');
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

    login.textContent = current.login ? `@${current.login}` : t('GitHub account');
    avatar.textContent = (current.login || '?').slice(0, 1).toUpperCase();
    const problem = current.error || current.setupNote;
    dot.className = `cloud-dot ${current.error ? 'error' : !hasRepo || problem ? 'warn' : 'ok'}`;
    repoLine.textContent = needsSignIn ? t('Sign in again to keep sharing')
      : hasRepo ? t('Sharing from {repo}', { repo: current.repo }) : t('Finish setting up below');
    if (current.error && !needsSignIn) say(current.error, 'error');

    siteLink.textContent = current.siteUrl || '';
    siteLink.title = current.siteUrl || '';
    pagesChip.textContent = current.pagesReady ? t('GitHub Pages on') : t('GitHub Pages off');
    pagesChip.className = `cloud-chip${current.pagesReady ? ' local' : ''}`;
    expireChip.textContent = current.autoExpire ? t('Automatic removal on') : t('Removed only while StepForge is open');
    expireChip.className = `cloud-chip${current.autoExpire ? ' local' : ''}`;
    privateNote.classList.toggle('hidden', !current.repoPrivate);
    setupNote.textContent = current.setupNote || '';
    setupNote.classList.toggle('hidden', !current.setupNote);
    setupActions.classList.toggle('hidden', !current.setupNote);

    if (hasRepo && needsSignIn) {
      listRequest += 1;
      sharedCount.textContent = '';
      sharedList.replaceChildren(el('p.cloud-empty.muted', {}, t('Sign in again to see and manage your shared guides.')));
    }
    if (hasRepo && !needsSignIn && (wasRepo !== current.repo || wasBlocked)) void refreshPublished();
    if (signedIn && !hasRepo && repos === null && !busy && !loadingRepos) void loadRepositories();
  }

  const node = el('fieldset.cloud-panel.gh-panel', {},
    el('legend', {}, t('GitHub Pages sharing')),
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
function makeAccountsSettings(api, { view = null, onPublishToWeb = null } = {}) {
  // Sync services first (see CLOUD_SERVICES in cloud.js), then GitHub, then
  // the wikis guides can be published to. Each row's id is also its Settings
  // view; Google Drive's is "drive".
  const rowId = (provider) => (provider === 'google' ? 'drive' : provider);
  const services = Object.keys(CLOUD_SERVICES);
  const clouds = services.map((provider) => ({ provider, id: rowId(provider), panel: makeCloudSettings(api, { provider }),
    state: el('span.account-state', {}, t('Checking…')) }));
  const github = makeGitHubSettings(api, { onPublishToWeb });
  const confluence = makeConfluenceSettings(api);
  const wikijs = makeWikiJsSettings(api);
  let disposed = false;

  const githubState = el('span.account-state', {}, t('Checking…'));
  const confluenceState = el('span.account-state', {}, t('Checking…'));
  const wikijsState = el('span.account-state', {}, t('Checking…'));
  // Service logos ship with the app (app/assets/icons); nothing is fetched.
  const row = (id, icon, name, description, state, badge = '') => el('button.account-row', { type: 'button', onClick: () => show(id) },
    el(`span.account-icon.${id}`, { 'aria-hidden': 'true' }, el('img', { src: `../assets/icons/${icon}`, alt: '' })),
    el('span.account-text', {}, el('strong', {}, name, badge ? betaBadge(badge) : null), el('span.muted', {}, description)),
    state,
    el('span.account-chevron', { 'aria-hidden': 'true' }, '›'));
  const list = el('div.account-list', {},
    ...clouds.map(({ provider, id, state }) => {
      const service = CLOUD_SERVICES[provider];
      return row(id, service.icon, provider === 'webdav' ? t('Nextcloud or WebDAV') : service.name, service.description, state);
    }),
    row('github', 'github.svg', 'GitHub', t('Share guides on the web for a limited time with GitHub Pages.'), githubState),
    row('confluence', 'confluence.svg', 'Confluence', t('Publish guides as pages on your Confluence site.'), confluenceState, 'Beta'),
    row('wikijs', 'wikijs.svg', 'Wiki.js', t('Publish guides as pages on your Wiki.js 2 site.'), wikijsState, 'Beta'));

  const back = el('button.account-back', { type: 'button', onClick: () => show(null) }, t('‹ All accounts'));
  const detail = el('div.account-detail.hidden', {}, back, ...clouds.map(({ panel }) => panel.node), github.node, confluence.node, wikijs.node);

  function show(id) {
    list.classList.toggle('hidden', Boolean(id));
    detail.classList.toggle('hidden', !id);
    for (const cloud of clouds) cloud.panel.node.classList.toggle('hidden', id !== cloud.id);
    github.node.classList.toggle('hidden', id !== 'github');
    confluence.node.classList.toggle('hidden', id !== 'confluence');
    wikijs.node.classList.toggle('hidden', id !== 'wikijs');
  }

  // One service syncs at a time; its row shows who is signed in.
  const setCloud = (status) => {
    if (disposed || !status) return;
    const active = status.provider || 'google';
    for (const { provider, state } of clouds) {
      const connected = provider === active && Boolean(status.connected);
      const available = status.providers?.[provider]?.available ?? (provider === active ? status.available !== false : true);
      state.textContent = connected ? status.email || t('Connected') : available ? t('Not connected') : t('Unavailable');
      state.classList.toggle('on', connected);
    }
  };
  const setGitHub = (status) => {
    if (disposed || !status) return;
    githubState.textContent = status.needsSignIn ? t('Sign in again')
      : status.connected ? (status.repo || `@${status.login}`) : t('Not connected');
    githubState.classList.toggle('on', Boolean(status.connected && status.repo && !status.needsSignIn));
  };
  const stopCloud = api.cloud.onStatus(setCloud);
  const stopGitHub = api.github.onStatus(setGitHub);
  const setConfluence = (status) => {
    if (disposed || !status) return;
    confluenceState.textContent = status.connected ? status.host : t('Not connected');
    confluenceState.classList.toggle('on', Boolean(status.connected));
  };
  const stopConfluence = api.confluence.onStatus(setConfluence);
  api.confluence.status().then(setConfluence).catch(() => { confluenceState.textContent = ''; });
  // Who is signed in (with a password), or the site (with an API key).
  const setWikiJs = (status) => {
    if (disposed || !status) return;
    wikijsState.textContent = status.connected ? status.user || status.host : status.error ? t('Sign in again') : t('Not connected');
    wikijsState.classList.toggle('on', Boolean(status.connected));
  };
  const stopWikiJs = api.wikijs.onStatus(setWikiJs);
  api.wikijs.status().then(setWikiJs).catch(() => { wikijsState.textContent = ''; });
  api.cloud.status().then(setCloud).catch(() => { for (const { state } of clouds) state.textContent = ''; });
  api.github.status().then(setGitHub).catch(() => { githubState.textContent = ''; });
  show([...clouds.map(({ id }) => id), 'github', 'confluence', 'wikijs'].includes(view) ? view : null);

  return {
    node: el('div.accounts', {}, list, detail),
    show,
    dispose() {
      disposed = true;
      stopCloud();
      stopGitHub();
      stopConfluence();
      stopWikiJs();
      confluence.dispose();
      wikijs.dispose();
      for (const { panel } of clouds) panel.dispose();
      github.dispose();
    },
  };
}

const GITHUB_PUBLISH_STAGES = [
  ['export', t('Prepare the page')],
  ['upload', t('Upload to GitHub')],
  ['commit', t('Update your site')],
];

/** What publishing is doing: each stage, and a progress bar while the page uploads. */
function githubPublishProgress(guideTitle) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': t('Publishing progress'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const detail = el('span.gh-progress-detail.muted', {}, '');
  const stages = GITHUB_PUBLISH_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    const note = el('span.gh-stage-note.muted', {}, '');
    return { id, icon, note, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label), note) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, t('Publishing “{title}”', { title: guideTitle }))),
    el('ol.gh-stages', {}, ...stages.map((stage) => stage.node)),
    el('div.gh-upload', {}, bar, detail),
    el('p.muted', {}, t('You can close this window. StepForge keeps publishing and lets you know when it’s done.')));

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
      detail.textContent = `${t('{loaded} of {total}', { loaded: formatBytes(progress.loaded), total: formatBytes(progress.total) })}${rate}`;
    } else if (progress?.stage === 'commit') {
      bar.classList.remove('indeterminate');
      fill.style.width = '100%';
      bar.setAttribute('aria-valuenow', '100');
      detail.textContent = t('Uploaded. Saving it to your GitHub Pages site…');
    } else {
      bar.classList.add('indeterminate');
      bar.removeAttribute('aria-valuenow');
      detail.textContent = progress?.detail || t('Building the web page from your guide…');
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
    try { const result = await api.github.copy({ kind: 'link', slug: entry.slug }); if (result.ok) toast(t('Link copied.')); }
    catch (err) { toast(err.message, { error: true }); }
  } }, t('Copy link'));
  const live = el('p.gh-live', { role: 'status', 'aria-live': 'polite' });
  const setLive = (state, text) => {
    live.className = `gh-live ${state}`;
    live.replaceChildren(state === 'waiting' ? el('span.spinner', { 'aria-hidden': 'true' }) : el('span.gh-live-dot', { 'aria-hidden': 'true' }), text);
  };
  if (entry.pagesReady) {
    setLive('waiting', t('Going live on GitHub Pages. This usually takes under a minute, and you can copy the link now.'));
    api.github.waitUntilLive({ slug: entry.slug })
      .then((result) => {
        if (result?.live) setLive('ok', t('Live. Anyone with the link can open it now.'));
        else setLive('slow', t('GitHub is taking longer than usual. The link will work as soon as GitHub finishes publishing it.'));
      })
      .catch(() => setLive('slow', t('StepForge couldn’t check the link. It will work as soon as GitHub finishes publishing it.')));
  } else {
    setLive('slow', t('GitHub Pages isn’t turned on for this repository yet, so the link won’t work until it is. See Settings → Accounts → GitHub.'));
  }
  return [
    el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
      el('strong', {}, t('“{title}” is shared until {when}.', { title: guideTitle, when: githubWhen(entry.expiresAt) }))),
    el('code.settings-path.gh-url', { title: entry.url }, entry.url),
    el('div.row', {}, copy, el('button', { type: 'button', onClick: () => { void api.shell.openExternal({ url: entry.url }).catch(() => {}); } }, t('Open in browser'))),
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
    const closeBtn = el('button', { type: 'button', onClick: () => { open = false; close(); resolve(); } }, t('Close'));
    const { close } = openModal({
      title: t('Publish on the web'),
      body,
      footer: [closeBtn],
      onClose: () => { open = false; resolve(); },
    });
    githubRunPublish(api, { guideId, request, progress })
      .then((entry) => {
        if (!open) { toast(t('“{title}” is on the web. Copy its link in Settings → Accounts → GitHub.', { title: guideTitle })); return; }
        body.replaceChildren(...githubPublishedView(api, entry, guideTitle));
        closeBtn.textContent = t('Done');
      })
      .catch((err) => {
        const message = t('The guide was exported, but publishing it on the web failed: {error}', { error: err.message });
        if (!open) { toast(message, { error: true }); return; }
        body.replaceChildren(el('p.gh-note.error', { role: 'alert' }, message));
      });
  });
}

/**
 * Publish one guide to the user's GitHub Pages site. Resolves when the dialog
 * closes. `onOpenAccounts` opens Settings → Accounts → GitHub.
 */
async function showPublishToWebDialog({ api, guideId, guideTitle, onOpenAccounts, onShowFinding }) {
  const status = await api.github.status();
  if (!status.connected || !status.repo || status.needsSignIn) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: t('Publish to the web'),
        body: el('div.gh-publish', {},
          el('p', {}, t('Publishing puts a guide on a GitHub Pages site in a GitHub repository you own, for a limited time.')),
          el('p.muted', {}, status.needsSignIn
            ? t('Your GitHub sign-in has expired. Sign in again in Settings → Accounts → GitHub; your repository and shared guides stay as they are.')
            : status.connected
              ? t('Finish setting up in Settings → Accounts → GitHub by choosing the repository for shared guides.')
              : t('To start, connect GitHub in Settings → Accounts → GitHub. It takes a few minutes and walks you through each step.'))),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel')),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } },
            status.needsSignIn ? t('Sign in again') : t('Set up GitHub')),
        ],
        onClose: () => resolve(false),
      });
    });
  }

  return new Promise((resolve) => {
    const body = el('div.gh-publish', {}, el('p.muted', {}, t('Checking what’s already shared…')));
    let open = true;
    let publishing = false;
    // The private-detail check below writes blurs into the guide. Cancelling
    // closes the dialog at once but resolves only when the check is done, so a
    // caller that reloads the open editor afterwards sees those blurs.
    let privacyCheck = Promise.resolve();
    const resolveAfterCheck = (value) => { privacyCheck.then(() => resolve(value)); };
    const cancelBtn = el('button', { type: 'button', onClick: () => { open = false; close(); resolveAfterCheck(publishing); } }, t('Cancel'));
    const removeBtn = el('button.danger.hidden', { type: 'button' }, t('Remove from the web'));
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, t('Publish'));
    // The body is replaced as the dialog loads, so the quality check sits outside it.
    const quality = el('div');
    const { close } = openModal({
      title: t('Publish to the web'),
      body: el('div', {}, quality, body),
      footer: [cancelBtn, removeBtn, publishBtn],
      onClose: () => { open = false; resolveAfterCheck(publishing); },
    });
    addQualityPanel(api, guideId, quality, (finding) => {
      open = false;
      close();
      resolveAfterCheck(publishing);
      onShowFinding?.(finding);
    });

    const days = el('select', { 'aria-label': t('How long to keep the guide online') },
      ...status.expiryDays.map((value) => el('option', { value: String(value), selected: value === status.defaultExpiryDays }, githubExpiryLabel(value))));
    const understood = el('input', { type: 'checkbox' });
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    // Screenshots are checked for private details before Publish is available.
    let checking = true;
    const canPublish = () => understood.checked && !checking;
    understood.addEventListener('change', () => { publishBtn.disabled = !canPublish(); });
    const privacyText = el('span', {}, t('Checking screenshots for private details…'));
    const privacyReview = el('button.hidden', { type: 'button' }, t('Review'));
    const privacySpinner = el('span.spinner', { 'aria-hidden': 'true' });
    const privacyBox = el('div.gh-privacy', { role: 'status', 'aria-live': 'polite' }, privacySpinner, privacyText, privacyReview);
    let review = null;
    const showReview = (next) => {
      review = next;
      privacyText.textContent = privacySummary(next);
      privacySpinner.classList.add('hidden');
      privacyBox.classList.toggle('found', Boolean(next.blurs.length || next.text.length));
      privacyReview.classList.toggle('hidden', !next.blurs.length && !next.text.length);
    };
    privacyReview.addEventListener('click', () => {
      if (!review) return;
      const { close } = openModal({
        title: t('Private details'),
        body: el('div.privacy-dialog', {},
          el('p.muted', {}, t('These are blurred on the published page. Remove any blur that isn’t needed, or open the guide in the editor to adjust one.')),
          privacyReviewList(api, guideId, review, { onChange: showReview })),
        footer: [el('button.primary', { type: 'button', onClick: () => close() }, t('Done'))],
      });
    });
    privacyCheck = runPrivacyCheck(api, guideId, (text) => { privacyText.textContent = text; })
      .then(showReview)
      .catch((err) => {
        privacySpinner.classList.add('hidden');
        privacyText.textContent = t('StepForge couldn’t check the screenshots for private details ({error}). Check them yourself before publishing.', { error: err.message });
        privacyBox.classList.add('found');
      })
      .finally(() => { checking = false; publishBtn.disabled = !canPublish(); });
    let form = null;

    publishBtn.addEventListener('click', async () => {
      if (!canPublish() || publishing) return;
      publishing = true;
      quality.replaceChildren(); // too late to fix before this publish
      error.classList.add('hidden');
      const progress = githubPublishProgress(guideTitle);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      removeBtn.classList.add('hidden');
      cancelBtn.textContent = t('Close');
      try {
        const entry = await githubRunPublish(api, { guideId, request: { days: Number(days.value) }, progress });
        if (!open) { toast(t('“{title}” is on the web. Copy its link in Settings → Accounts → GitHub.', { title: guideTitle })); return; }
        body.replaceChildren(...githubPublishedView(api, entry, guideTitle));
        cancelBtn.textContent = t('Done');
        resolve(true);
      } catch (err) {
        publishing = false;
        if (!open) { toast(t('Publishing “{title}” failed: {error}', { title: guideTitle, error: err.message }), { error: true }); return; }
        // Back to the form, with what went wrong.
        body.replaceChildren(form);
        publishBtn.classList.remove('hidden');
        publishBtn.disabled = !canPublish();
        removeBtn.classList.toggle('hidden', !removeBtn.onclick);
        cancelBtn.textContent = t('Cancel');
        showError(err.message);
      }
    });

    Promise.all([api.github.published(), guideUpdatedTimes(api)]).then(([guides, updated]) => {
      if (!open || publishing) return;
      const existing = guides.find((entry) => entry.guideId === guideId) || null;
      // replaceChildren() would print a skipped (null) item as "null".
      form = el('div.gh-publish', {}, ...[
        el('p', {}, t('Publish “{title}” as a web page on your GitHub Pages site. Screenshots, text, and annotations are included, the same as an interactive HTML export.', { title: guideTitle })),
        existing ? el('div.cloud-banner', {},
          t('This guide is already shared until {when}. Publishing again updates the page with your latest changes and keeps the same link.', { when: githubWhen(existing.expiresAt) }),
          editedSinceShared(updated.get(guideId), existing.publishedAt) ? ` ${t('The guide has changed since you shared it.')}` : '') : null,
        el('label.gh-field', {}, el('span', {}, t('Keep it online for')), days),
        privacyBox,
        githubPublicWarning(t('StepForge blurs the private details it finds, but it can miss some, such as names or text that’s hard to read. Check every screenshot before you publish, and use the Blur tool for anything else.')),
        status.repoPrivate ? el('p.gh-note', {}, t('Your repository is private, but the published page is still public.')) : null,
        status.pagesReady ? null : el('p.gh-note', {}, t('GitHub Pages isn’t turned on for your repository yet. StepForge will try again when you publish; if it still can’t, Settings → Accounts → GitHub explains how to turn it on.')),
        el('label.gh-consent', {}, understood, el('span', {}, t('I understand this guide will be public on the internet.'))),
        error,
      ].filter(Boolean));
      body.replaceChildren(form);
      if (existing) {
        removeBtn.classList.remove('hidden');
        removeBtn.onclick = async () => {
          const ok = await confirmDialog(t('Stop sharing “{title}”? Its link stops working within a few minutes.', { title: guideTitle }), { danger: true, okLabel: t('Remove from the web') });
          if (!ok) return;
          setButtonLoading(removeBtn, true, t('Removing…'));
          publishBtn.disabled = true;
          try {
            await api.github.unpublish({ slug: existing.slug });
            toast(t('“{title}” is no longer shared.', { title: guideTitle }));
            open = false;
            close();
            resolve(true);
          } catch (err) {
            setButtonLoading(removeBtn, false);
            publishBtn.disabled = !canPublish();
            showError(err.message);
          }
        };
      }
    }).catch((err) => {
      if (open && !publishing) body.replaceChildren(el('p.gh-note.error', { role: 'alert' }, err.message));
    });
  });
}
