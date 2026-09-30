'use strict';

/*
 * The services guides can sync with, for Settings → Accounts. StepForge syncs
 * with one of them at a time. `where` is where guides are stored ("in
 * Google Drive"), `short` names it on buttons ("Delete from Drive").
 * `replace` starts the button that makes this computer the source of truth.
 */
const CLOUD_SERVICES = {
  google: {
    name: 'Google Drive', short: 'Drive', replace: 'Replace Drive', where: 'in Google Drive', whereShort: 'in Drive', icon: 'google-drive.svg',
    account: 'Google account', signIn: 'Sign in with Google', waiting: 'Waiting for Google…',
    description: 'Back up and sync guides between your computers.',
    hint: 'Choose your Google account in the browser and allow StepForge to store its guides, then return here.',
    privacy: 'They are stored in a private app folder only StepForge can see — not your My Drive files.',
    storage: 'Stored in a hidden app folder, so it won’t appear in your Drive file list.',
    quota: 'Google storage',
    revoke: 'You can also revoke access in your Google account.',
  },
  onedrive: {
    name: 'OneDrive', short: 'OneDrive', replace: 'Replace OneDrive', where: 'in OneDrive', whereShort: 'in OneDrive', icon: 'onedrive.svg',
    account: 'Microsoft account', signIn: 'Sign in with Microsoft', waiting: 'Waiting for Microsoft…',
    description: 'Back up and sync guides with your Microsoft account.',
    hint: 'Choose your Microsoft account in the browser and allow StepForge to use its app folder, then return here.',
    privacy: 'StepForge only gets its own folder, Apps/StepForge, and can’t see anything else in your OneDrive. Personal, work and school accounts all work.',
    storage: 'Stored in Apps/StepForge in your OneDrive. Leave the files there as they are; StepForge manages them.',
    quota: 'OneDrive storage',
    revoke: 'You can also remove StepForge’s access in your Microsoft account under Privacy → Apps and services.',
  },
  dropbox: {
    name: 'Dropbox', short: 'Dropbox', replace: 'Replace Dropbox', where: 'in Dropbox', whereShort: 'in Dropbox', icon: 'dropbox.svg',
    account: 'Dropbox account', signIn: 'Sign in with Dropbox', waiting: 'Waiting for Dropbox…',
    description: 'Back up and sync guides with your Dropbox.',
    hint: 'Sign in to Dropbox in the browser and allow StepForge to use its app folder, then return here.',
    privacy: 'StepForge only gets its own folder, Apps/StepForge, and can’t see anything else in your Dropbox.',
    storage: 'Stored in Apps/StepForge in your Dropbox. Leave the files there as they are; StepForge manages them.',
    quota: 'Dropbox storage',
    revoke: 'You can also remove StepForge in Dropbox under Settings → Connected apps.',
  },
  webdav: {
    name: 'Nextcloud', short: 'the server', replace: 'Replace the server’s copies', where: 'on your server', whereShort: 'on the server', icon: 'nextcloud.svg',
    account: 'Nextcloud account', signIn: 'Sign in', waiting: 'Waiting for sign-in…',
    description: 'Sync with your own Nextcloud or any WebDAV server.',
    hint: 'Log in to Nextcloud in the browser and grant access, then return here.',
    privacy: 'Works with Nextcloud, ownCloud and any WebDAV server. StepForge keeps its files in a StepForge folder in your account.',
    storage: 'Stored in the StepForge folder of your account. Leave the files there as they are; StepForge manages them.',
    quota: 'storage',
    revoke: 'On Nextcloud you can also revoke StepForge’s app password under Settings → Security.',
  },
};

/*
 * One service's sync settings. Cloud controls take effect immediately,
 * independently of the main Settings form.
 */
function makeCloudSettings(api, { provider = 'google' } = {}) {
  const S = CLOUD_SERVICES[provider] || CLOUD_SERVICES.google;
  const isWebDAV = provider === 'webdav';
  // Whether a status is about this service; older callers don't say.
  const mine = (status) => (status?.provider || 'google') === provider;
  const otherService = (status) => {
    const [id] = Object.entries(status?.providers || {}).find(([key, value]) => key !== provider && value.connected) || [];
    return id ? CLOUD_SERVICES[id] || null : null;
  };
  const PHASES = {
    off: ['idle', 'Auto-sync is paused'],
    synced: ['ok', 'Up to date'],
    syncing: ['busy', 'Syncing…'],
    pending: ['warn', 'Changes waiting to sync'],
    conflict: ['warn', 'Conflict copies saved to your library'],
    error: ['error', 'Needs attention'],
    disconnected: ['error', 'Sign in again'],
  };
  const formatWhen = (iso) => {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'Date unavailable';
  };
  const timeAgo = (iso) => {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!(seconds >= 0)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
    return formatWhen(iso);
  };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // Previous versions or unused files to remove, or full copies to convert.
  const canFreeUp = (summary) => Boolean(summary && (summary.pruneCount || summary.fullCount || summary.reclaimableBytes));

  let current = {};
  let busy = false;
  let signingIn = false;
  let disposed = false;
  let guideRequest = 0;
  let lastGuides = [];
  let lastStorage = null;

  // Feedback banner for the result of the last action.
  const banner = el('div.cloud-banner.hidden', { role: 'status', 'aria-live': 'polite' });
  const say = (message, tone = 'info') => {
    banner.textContent = message || '';
    banner.className = `cloud-banner ${tone}${message ? '' : ' hidden'}`;
  };

  const run = async (button, label, action) => {
    if (busy || disposed) return;
    busy = true;
    update(current);
    setButtonLoading(button, true, label);
    try {
      await action();
    } catch (err) {
      if (!disposed) say(err.message, 'error');
    } finally {
      busy = false;
      if (!disposed) {
        try { current = await api.cloud.status(); } catch { /* retain the last status if IPC is unavailable */ }
        setButtonLoading(button, false);
        update(current);
      }
    }
  };

  /* Signed-out view */
  // Nextcloud and WebDAV need the server's address, and WebDAV a login.
  const server = isWebDAV ? el('input', { type: 'url', placeholder: 'cloud.example.com', autocomplete: 'url', spellcheck: false, 'aria-label': 'Server address' }) : null;
  const username = isWebDAV ? el('input', { type: 'text', autocomplete: 'username', spellcheck: false, 'aria-label': 'User name' }) : null;
  const password = isWebDAV ? el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password or app password' }) : null;
  const loginFields = isWebDAV ? el('div.cloud-login.hidden', {},
    el('label.cloud-field', {}, el('span', {}, 'User name'), username),
    el('label.cloud-field', {}, el('span', {}, 'Password or app password'), password),
    el('p.muted', {}, 'If your server offers app passwords, create one for StepForge and use it here instead of your main password.')) : null;
  const usePassword = isWebDAV ? el('button.link', { type: 'button', onClick: () => {
    loginFields.classList.remove('hidden');
    usePassword.classList.add('hidden');
  } }, 'Use a user name and password instead') : null;
  const signIn = async () => {
    const other = otherService(current);
    if (other) {
      const ok = await confirmDialog(el('div.cloud-confirm', {},
        el('strong', {}, `Sync with ${S.name} instead of ${other.name}?`),
        el('p', {}, `StepForge syncs with one account at a time, so signing in here disconnects ${other.name} on this computer.`),
        el('p.muted', {}, `Your guides stay on this computer, and everything already ${other.where} stays there. Other computers keep syncing with ${other.name} until you switch them too.`)),
      { okLabel: `Switch to ${S.name}` });
      if (!ok) return;
    }
    await run(connect, S.waiting, async () => {
      const request = { provider };
      if (isWebDAV) {
        request.server = server.value.trim();
        if (!loginFields.classList.contains('hidden')) Object.assign(request, { username: username.value.trim(), password: password.value });
      }
      say(isWebDAV && request.username ? 'Signing in…' : S.hint);
      signingIn = true;
      cancel.classList.remove('hidden');
      try {
        const result = await api.cloud.connect(request);
        if (result?.needsPassword) {
          // Not a Nextcloud server: ask for its WebDAV login.
          if (result.server) server.value = result.server;
          loginFields.classList.remove('hidden');
          usePassword.classList.add('hidden');
          say('This server isn’t Nextcloud, so enter its WebDAV user name and password. The address should be your WebDAV folder.', 'info');
          return;
        }
        if (password) password.value = '';
        say('Connected. Your guides will sync automatically.', 'success');
        await refreshLists();
      } finally { signingIn = false; cancel.classList.add('hidden'); }
    });
  };
  const connect = el('button.primary', { type: 'button', onClick: signIn }, S.signIn);
  const cancel = el('button.hidden', { type: 'button', onClick: () => api.cloud.cancel().catch((err) => say(err.message, 'error')) }, 'Cancel sign-in');
  const unavailable = el('p.muted.hidden', {}, `${S.name} sign-in is unavailable in this build of StepForge.`);
  const switching = el('p.cloud-note.hidden', {}, '');
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: `../assets/icons/${S.icon}`, alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, 'Keep your guides in sync'),
      el('p.muted', {}, `Back up your guides and pick them up on your other computers. ${S.privacy}`),
      ...(isWebDAV ? [el('label.cloud-field', {}, el('span', {}, 'Server address'), server), loginFields] : []),
      switching,
      el('div.row', {}, connect, cancel, ...(isWebDAV ? [usePassword] : [])),
      unavailable,
    ),
  );
  if (isWebDAV) {
    for (const input of [server, username, password]) {
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void signIn(); } });
    }
  }

  /* Account header */
  const avatarInitial = el('span', {}, '?');
  const avatarPhoto = el('img.hidden', { alt: '', referrerPolicy: 'no-referrer' });
  let avatarUrl = '';
  avatarPhoto.addEventListener('error', () => {
    avatarPhoto.classList.add('hidden');
    avatarInitial.classList.remove('hidden');
  });
  const avatar = el('div.cloud-avatar', { 'aria-hidden': 'true' }, avatarInitial, avatarPhoto);
  const email = el('strong.cloud-email', {}, S.account);
  const dot = el('span.cloud-dot', { 'aria-hidden': 'true' });
  const phaseText = el('span', {}, '');
  const lastSync = el('span.muted', {}, '');
  const transferFill = el('span.cloud-meter-seg.latest', { style: {} });
  const transferText = el('span.muted', {}, '');
  const transferBar = el('div.cloud-meter', { role: 'progressbar', 'aria-label': `${S.name} transfer`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, transferFill);
  const transferRow = el('div.cloud-transfer.hidden', {}, transferBar, transferText);
  const enabled = el('input', { type: 'checkbox', 'aria-label': 'Automatically sync guides' });
  const sync = el('button', { type: 'button', onClick: () => run(sync, 'Syncing…', async () => {
    const result = await api.cloud.sync();
    say(result.message, result.phase === 'error' ? 'error' : result.phase === 'synced' ? 'success' : 'info');
    await refreshLists();
  }) }, 'Sync now');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, 'Disconnecting…', async () => {
    await api.cloud.disconnect();
    say(`Disconnected on this computer. Local guides and the copies ${S.where} are kept. ${S.revoke}`);
  }) }, 'Disconnect');
  const account = el('div.cloud-account.hidden', {},
    avatar,
    el('div.cloud-account-info', {}, email, el('div.cloud-status-line', {}, dot, phaseText, lastSync), transferRow),
    el('div.cloud-account-actions', {},
      el('label.switch', { title: 'Automatically sync guides' }, enabled, el('span.switch-track', { 'aria-hidden': 'true' }), 'Auto-sync'),
      sync, disconnect),
  );

  /* Storage card */
  const storageTotal = el('span.cloud-card-meta', {}, '');
  const segLatest = el('span.cloud-meter-seg.latest', { style: {} });
  const segPrevious = el('span.cloud-meter-seg.previous', { style: {} });
  const segRecovery = el('span.cloud-meter-seg.recovery', { style: {} });
  const legendItem = (kind, label) => {
    const value = el('span.cloud-legend-value', {}, '—');
    return { value, node: el('div.cloud-legend-item', {}, el(`span.cloud-swatch.${kind}`), el('span', {}, label), value) };
  };
  const legendLatest = legendItem('latest', 'Latest versions');
  const legendPrevious = legendItem('previous', 'Previous versions');
  const legendRecovery = legendItem('recovery', 'Deleted-guide recovery');
  const quotaNote = el('p.muted', {}, S.storage);
  const prune = el('button', { type: 'button', disabled: true, onClick: async () => {
    if (busy || disposed || !lastStorage) return;
    const { pruneCount = 0, fullCount = 0, reclaimableBytes = 0 } = lastStorage;
    // replaceChildren() would print a skipped (null) item as "null".
    const ok = await confirmDialog(el('div.cloud-confirm', {}, ...[
      el('strong', {}, reclaimableBytes ? `Free up ${formatBytes(reclaimableBytes)}?` : `Free up space ${S.where}?`),
      pruneCount ? el('p', {}, `This removes ${plural(pruneCount, 'previous version')} ${S.where.replace(/^(in|on) /, 'from ')}. The latest version of every guide is always kept.`) : null,
      fullCount ? el('p', {}, `It also switches ${plural(fullCount, 'guide version')} saved as full copies to space-saving versions, so later versions only store what changed. Each one is downloaded and uploaded once.`) : null,
      pruneCount ? el('p.muted', {}, 'Removed versions can no longer be restored. This cannot be undone.') : null,
    ].filter(Boolean)),
    { danger: pruneCount > 0, okLabel: 'Free up space' });
    if (!ok) return;
    await run(prune, 'Freeing up space…', async () => {
      const result = await api.cloud.prune();
      const converted = result.converted ? ` ${plural(result.converted, 'guide version')} now ${result.converted === 1 ? 'stores' : 'store'} only what changes.` : '';
      say(`Removed ${plural(result.pruned, 'previous version')} and freed ${formatBytes(result.reclaimedBytes)}.${converted}`, 'success');
      await refreshLists();
    });
  } }, 'Free up space');
  const storageCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Storage'), storageTotal),
    el('div.cloud-meter', { role: 'img', 'aria-label': `${S.name} storage used by StepForge` }, segLatest, segPrevious, segRecovery),
    el('div.cloud-legend', {}, legendLatest.node, legendPrevious.node, legendRecovery.node),
    el('div.cloud-card-foot', {}, quotaNote, prune),
  );

  /* Guides card */
  const guideCount = el('span.cloud-card-meta', {}, '');
  const guideList = el('div.cloud-guide-list', {}, el('p.muted', {}, 'Loading guides…'));
  const refresh = el('button', { type: 'button', title: `Reload from ${S.name}`, onClick: () => run(refresh, 'Refreshing…', refreshLists) }, 'Refresh');
  const guidesCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, `Guides ${S.whereShort}`), guideCount, refresh),
    el('p.muted', {}, 'Each guide keeps its latest version and up to two previous versions you can restore. To stop syncing one guide, turn off sharing in its Guide information.'),
    guideList,
  );

  /* Deleted guides */
  const deletedCount = el('span.cloud-count', {}, '0');
  const deletedList = el('div.cloud-guide-list', {}, el('p.muted', {}, 'No recently deleted guides.'));
  const deletedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, 'Recently deleted'), deletedCount),
    el('p.muted', {}, `Guides deleted from a synced library are removed from your other computers. One recovery copy stays ${S.whereShort} until you restore it or delete it permanently.`),
    deletedList,
  );

  /* Advanced */
  const testResults = el('ul.cloud-checks.hidden');
  const test = el('button', { type: 'button', onClick: () => run(test, 'Testing…', async () => {
    testResults.replaceChildren();
    testResults.classList.add('hidden');
    const result = await api.cloud.test();
    testResults.replaceChildren(...result.checks.map((line) => {
      const failed = /fail/i.test(line);
      return el(`li.${failed ? 'fail' : 'pass'}`, {}, el('span.cloud-check-icon', { 'aria-hidden': 'true' }, failed ? '✕' : '✓'), line.replace(/: passed$/, ''));
    }));
    testResults.classList.remove('hidden');
    say(result.ok ? 'Connection test passed.' : 'Connection test needs attention.', result.ok ? 'success' : 'error');
  }) }, 'Test connection');
  const replace = el('button.danger', { type: 'button', onClick: async () => {
    if (busy || disposed) return;
    if (!current.enabled) { say(`Turn on auto-sync before replacing what’s ${S.where} with this computer’s guides.`, 'error'); return; }
    const cloudOnly = lastGuides.filter((guide) => !guide.local).length;
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, 'Make this computer the source of truth?'),
      el('p', {}, `Everything StepForge stored ${S.where} is deleted, including previous versions and deleted-guide recovery copies. Then the guides on this computer are uploaded as the only copies.`),
      cloudOnly ? el('p', {}, `${plural(cloudOnly, 'guide')} ${S.whereShort} ${cloudOnly === 1 ? 'is' : 'are'} not on this computer and will be removed. Your other computers move ${cloudOnly === 1 ? 'it' : 'them'} to their trash.`) : null,
      el('p.muted', {}, 'This cannot be undone.')),
    { danger: true, okLabel: S.replace });
    if (!ok) return;
    await run(replace, 'Replacing…', async () => {
      const result = await api.cloud.replaceCloudWithLocal();
      say(`${S.name} now matches this computer. ${plural(result.uploading, 'guide')} uploaded.`, 'success');
      await refreshLists();
    });
  } }, `${S.replace} with this computer`);
  const advancedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, 'Advanced')),
    el('div.cloud-setting', {},
      el('div', {}, el('strong', {}, 'Test connection'),
        el('p.muted', {}, 'Checks sign-in, storage access, and a temporary upload and download. No guides are uploaded.')),
      test),
    testResults,
    el('div.cloud-setting.cloud-danger', {},
      el('div', {}, el('strong', {}, 'Use this computer as the source of truth'),
        el('p.muted', {}, `Deletes everything StepForge stored ${S.where} and replaces it with the guides on this computer.`)),
      replace),
  );

  const signedIn = el('div.cloud-stack.hidden', {}, storageCard, guidesCard, deletedCard, advancedCard);

  function update(next) {
    const previous = mine(current) ? current.phase : null;
    const wasConnected = mine(current) && Boolean(current.connected);
    current = next;
    const connected = mine(next) && Boolean(next.connected);
    const available = next.providers?.[provider]?.available ?? (mine(next) ? next.available !== false : true);
    signedOut.classList.toggle('hidden', connected);
    account.classList.toggle('hidden', !connected);
    signedIn.classList.toggle('hidden', !connected);
    unavailable.classList.toggle('hidden', available);
    connect.disabled = busy || connected || !available;
    const other = connected ? null : otherService(next);
    switching.textContent = other ? `You’re syncing with ${other.name} now. StepForge syncs with one account at a time, so signing in here switches this computer to ${S.name}.` : '';
    switching.classList.toggle('hidden', !other);
    enabled.checked = Boolean(next.enabled);
    enabled.disabled = busy || !connected;
    sync.disabled = busy || !next.enabled;
    disconnect.disabled = busy;
    test.disabled = busy || !connected;
    replace.disabled = busy || !connected;
    prune.disabled = busy || !canFreeUp(lastStorage);

    email.textContent = (connected && next.email) || S.account;
    avatarInitial.textContent = (next.email || '?').slice(0, 1).toUpperCase();
    const photoLink = connected ? next.photoLink || '' : '';
    if (photoLink !== avatarUrl) {
      avatarUrl = photoLink;
      avatarPhoto.classList.toggle('hidden', !photoLink);
      avatarInitial.classList.toggle('hidden', Boolean(photoLink));
      if (photoLink) avatarPhoto.src = photoLink;
      else avatarPhoto.removeAttribute('src');
    }
    if (!connected) {
      // Another service's progress and errors belong to its own panel.
      transferRow.classList.add('hidden');
      if (mine(next) && next.error) say(next.error, 'error');
      return;
    }
    if (!wasConnected && !busy) void refreshLists();
    const phase = next.error ? 'error' : next.enabled ? next.phase || 'pending' : 'off';
    const [tone, label] = PHASES[phase] || PHASES.pending;
    dot.className = `cloud-dot ${tone}`;
    phaseText.textContent = label;
    phaseText.title = next.error || next.message || '';
    lastSync.textContent = next.lastSync && tone !== 'busy' ? ` · Last synced ${timeAgo(next.lastSync)}` : '';
    transferRow.classList.toggle('hidden', !next.transfer);
    if (next.transfer) {
      const { percent, detail } = describeTransfer(next.transfer);
      transferFill.style.width = `${percent}%`;
      transferBar.setAttribute('aria-valuenow', String(percent));
      transferText.textContent = detail;
    }
    // Transfer progress arrives several times a second; don't keep rewriting the banner.
    if ((phase === 'error' || phase === 'disconnected') && (next.error || next.message) && !next.transfer) say(next.error || next.message, 'error');
    // Refresh the lists when a background sync finishes.
    if (connected && previous === 'syncing' && ['synced', 'conflict'].includes(next.phase) && !busy) void refreshLists();
  }

  const renderStorage = (summary) => {
    lastStorage = summary;
    const total = summary.bytes || 0;
    storageTotal.textContent = `${formatBytes(total)} used`;
    const pct = (value) => `${total ? Math.max(value ? 2 : 0, (value / total) * 100) : 0}%`;
    segLatest.style.width = pct(summary.latestBytes || 0);
    segPrevious.style.width = pct(summary.previousBytes || 0);
    segRecovery.style.width = pct(summary.recoveryBytes || 0);
    legendLatest.value.textContent = formatBytes(summary.latestBytes || 0);
    legendPrevious.value.textContent = formatBytes(summary.previousBytes || 0);
    legendRecovery.value.textContent = formatBytes(summary.recoveryBytes || 0);
    const quota = summary.quota;
    quotaNote.textContent = quota?.limit
      ? `Uses ${((total / quota.limit) * 100).toFixed(total / quota.limit < 0.001 ? 2 : 1)}% of your ${formatBytes(quota.limit)} ${S.quota}. ${S.storage}`
      : S.storage;
    prune.textContent = summary.reclaimableBytes ? `Free up ${formatBytes(summary.reclaimableBytes)}`
      : summary.fullCount ? 'Free up space' : 'Nothing to free up';
    prune.disabled = busy || !canFreeUp(summary);
  };

  const renderVersions = async (guide, host) => {
    let versions;
    try { versions = await api.cloud.history({ guideId: guide.guideId }); }
    catch (err) { if (!disposed) host.replaceChildren(el('p.muted', {}, err.message)); return; }
    if (disposed) return;
    host.replaceChildren();
    if (!versions.length) { host.append(el('p.muted', {}, 'No versions remain. Refresh the list.')); return; }
    for (const [index, version] of versions.entries()) {
      const restore = el('button', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(el('div.cloud-confirm', {},
          el('strong', {}, `Restore “${guide.title}”?`),
          el('p', {}, `This replaces the guide on this computer with the version from ${formatWhen(version.createdTime)}. Your current copy is backed up first.`),
          el('p.muted', {}, `With sync on, the restored version becomes the latest version ${S.where}.`)),
        { okLabel: 'Restore version' });
        if (!ok) return;
        await run(restore, 'Restoring…', async () => {
          await api.cloud.restore({ guideId: guide.guideId, versionId: version.id });
          say(`Restored “${guide.title}” from ${formatWhen(version.createdTime)}.`, 'success');
          await refreshLists();
        });
      } }, 'Restore');
      host.append(el(`div.cloud-version${index === 0 ? '.latest' : ''}`, {},
        el('span.cloud-version-dot', { 'aria-hidden': 'true' }),
        el('div.cloud-version-info', {},
          el('span', {}, formatWhen(version.createdTime)),
          el('span.muted', {}, `${index === 0 ? 'Latest' : 'Previous version'} · ${formatBytes(version.size)}`)),
        restore));
    }
  };

  const refreshGuides = async () => {
    const request = ++guideRequest;
    const guides = await api.cloud.guides();
    if (disposed || request !== guideRequest) return;
    lastGuides = guides;
    guideCount.textContent = guides.length ? plural(guides.length, 'guide') : '';
    guideList.replaceChildren();
    if (!guides.length) { guideList.append(el('p.cloud-empty.muted', {}, `No guides ${S.where} yet.`)); return; }
    for (const guide of guides) {
      const versions = el('div.cloud-versions', { hidden: true });
      const toggle = el('button', { type: 'button', 'aria-expanded': 'false', onClick: async () => {
        const open = versions.hidden;
        versions.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
          versions.replaceChildren(el('p.muted', {}, 'Loading versions…'));
          await renderVersions(guide, versions);
        }
      } }, 'Versions');
      const download = guide.local ? null : el('button', { type: 'button', onClick: () => run(download, 'Downloading…', async () => {
        await api.cloud.restore({ guideId: guide.guideId, versionId: guide.latestId });
        say(`Downloaded “${guide.title}” to this computer.`, 'success');
        await refreshLists();
      }) }, 'Download');
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(el('div.cloud-confirm', {},
          el('strong', {}, `Delete “${guide.title}” from ${S.name}?`),
          el('p', {}, `All ${plural(guide.snapshotCount, 'version')} ${S.whereShort} will be deleted. ${guide.local ? 'The guide stays on this computer and stops syncing.' : 'This guide is not on this computer.'}`),
          el('p.muted', {}, 'Other computers that still sync this guide may upload it again. This cannot be undone.')),
        { danger: true, okLabel: `Delete from ${S.short}` });
        if (!ok) return;
        await run(remove, 'Deleting…', async () => {
          await api.cloud.deleteGuideSnapshots({ guideId: guide.guideId });
          say(`Deleted “${guide.title}” from ${S.name}.${guide.local ? ' The guide is still on this computer.' : ''}`, 'success');
          await refreshLists();
        });
      } }, `Delete from ${S.short}`);
      guideList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title),
            el('div.cloud-chips', {},
              el(`span.cloud-chip${guide.local ? '.local' : ''}`, {}, guide.local ? 'On this computer' : `Only ${S.whereShort}`),
              el('span.cloud-chip', {}, plural(guide.snapshotCount, 'version')),
              el('span.cloud-chip', {}, formatBytes(guide.bytes)),
              guide.updatedAt ? el('span.muted', {}, `Updated ${timeAgo(guide.updatedAt)}`) : null)),
          el('div.cloud-guide-actions', {}, download, toggle, remove)),
        versions));
    }
  };

  const refreshDeleted = async () => {
    const guides = await api.cloud.deletedGuides();
    if (disposed) return;
    const recoverable = guides.filter((guide) => !guide.purged);
    deletedCount.textContent = String(recoverable.length);
    deletedCount.className = `cloud-count${recoverable.length ? ' active' : ''}`;
    deletedList.replaceChildren();
    if (!recoverable.length) { deletedList.append(el('p.cloud-empty.muted', {}, 'No recently deleted guides.')); return; }
    for (const guide of recoverable) {
      const restore = el('button', { type: 'button', onClick: async () => {
        const ok = await confirmDialog(`Restore “${guide.title}” to your library? It will sync to your other computers again.`, { okLabel: 'Restore' });
        if (!ok) return;
        await run(restore, 'Restoring…', async () => {
          await api.cloud.restoreDeletedGuide({ guideId: guide.guideId });
          say(`Restored “${guide.title}”.`, 'success');
          await refreshLists();
        });
      } }, 'Restore');
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        const ok = await confirmDialog(`Permanently delete the recovery copy of “${guide.title}”? It cannot be restored afterwards.`, { danger: true, okLabel: 'Delete permanently' });
        if (!ok) return;
        await run(remove, 'Deleting…', async () => {
          await api.cloud.permanentlyDeleteRecovery({ guideId: guide.guideId });
          await refreshLists();
        });
      } }, 'Delete permanently');
      deletedList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon.deleted', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title),
            el('div.cloud-chips', {},
              el('span.cloud-chip', {}, formatBytes(guide.size)),
              el('span.muted', {}, `Deleted ${guide.deletedAt ? timeAgo(guide.deletedAt) : '(date unavailable)'}`))),
          el('div.cloud-guide-actions', {}, restore, remove))));
    }
  };

  const refreshStorage = async () => {
    const summary = await api.cloud.storage();
    if (!disposed) renderStorage(summary);
  };

  const refreshLists = async () => {
    await Promise.all([
      refreshGuides().catch((err) => { if (!disposed) guideList.replaceChildren(el('p.cloud-empty.muted', {}, err.message)); }),
      refreshStorage().catch((err) => { if (!disposed) storageTotal.textContent = err.message; }),
      refreshDeleted().catch((err) => { if (!disposed) deletedList.replaceChildren(el('p.cloud-empty.muted', {}, err.message)); }),
    ]);
  };

  enabled.addEventListener('change', () => run(sync, 'Applying…', async () => {
    // Capture the requested value before run() restores the saved control state.
    await api.cloud.enable({ enabled: !current.enabled });
  }));

  const node = el('fieldset.cloud-panel', {},
    el('legend', {}, `${S.name} sharing`),
    signedOut, account, banner, signedIn,
  );
  const unsubscribe = api.cloud.onStatus((next) => { if (!disposed) update(next); });
  api.cloud.status().then(async (next) => {
    if (!disposed) {
      update(next);
    }
  }).catch((err) => say(err.message, 'error'));
  return { node, dispose() { disposed = true; unsubscribe(); if (signingIn) void api.cloud.cancel().catch(() => {}); } };
}
