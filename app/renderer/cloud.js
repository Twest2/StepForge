'use strict';

/*
 * The services guides can sync with, for Settings → Accounts. StepForge syncs
 * with one of them at a time. `where` is where guides are stored ("in
 * Google Drive"), `short` names it on buttons ("Delete from Drive").
 * `replace` starts the button that makes this computer the source of truth.
 */
const CLOUD_SERVICES = {
  google: {
    name: 'Google Drive', short: 'Drive', replace: t('Replace Drive'), replaceWith: t('Replace Drive with this computer'), deleteFrom: t('Delete from Drive'), where: t('in Google Drive'), whereShort: t('in Drive'), icon: 'google-drive.svg',
    account: t('Google account'), signIn: t('Sign in with Google'), waiting: t('Waiting for Google…'),
    description: t('Back up and sync guides between your computers.'),
    hint: t('Choose your Google account in the browser and allow StepForge to store its guides, then return here.'),
    privacy: t('They are stored in a private app folder only StepForge can see — not your My Drive files.'),
    storage: t('Stored in a hidden app folder, so it won’t appear in your Drive file list.'),
    quota: t('Google storage'),
    revoke: t('You can also revoke access in your Google account.'),
  },
  onedrive: {
    name: 'OneDrive', short: 'OneDrive', replace: t('Replace OneDrive'), replaceWith: t('Replace OneDrive with this computer'), deleteFrom: t('Delete from OneDrive'), where: t('in OneDrive'), whereShort: t('in OneDrive'), icon: 'onedrive.svg',
    account: t('Microsoft account'), signIn: t('Sign in with Microsoft'), waiting: t('Waiting for Microsoft…'),
    description: t('Back up and sync guides with your Microsoft account.'),
    hint: t('Choose your Microsoft account in the browser and allow StepForge to use its app folder, then return here.'),
    privacy: t('StepForge only gets its own folder, Apps/StepForge, and can’t see anything else in your OneDrive. Personal, work and school accounts all work.'),
    storage: t('Stored in Apps/StepForge in your OneDrive. Leave the files there as they are; StepForge manages them.'),
    quota: t('OneDrive storage'),
    revoke: t('You can also remove StepForge’s access in your Microsoft account under Privacy → Apps and services.'),
  },
  dropbox: {
    name: 'Dropbox', short: 'Dropbox', replace: t('Replace Dropbox'), replaceWith: t('Replace Dropbox with this computer'), deleteFrom: t('Delete from Dropbox'), where: t('in Dropbox'), whereShort: t('in Dropbox'), icon: 'dropbox.svg',
    account: t('Dropbox account'), signIn: t('Sign in with Dropbox'), waiting: t('Waiting for Dropbox…'),
    description: t('Back up and sync guides with your Dropbox.'),
    hint: t('Sign in to Dropbox in the browser and allow StepForge to use its app folder, then return here.'),
    privacy: t('StepForge only gets its own folder, Apps/StepForge, and can’t see anything else in your Dropbox.'),
    storage: t('Stored in Apps/StepForge in your Dropbox. Leave the files there as they are; StepForge manages them.'),
    quota: t('Dropbox storage'),
    revoke: t('You can also remove StepForge in Dropbox under Settings → Connected apps.'),
  },
  webdav: {
    name: 'Nextcloud', short: t('the server'), replace: t('Replace the server’s copies'), replaceWith: t('Replace the server’s copies with this computer’s'), deleteFrom: t('Delete from the server'), where: t('on your server'), whereShort: t('on the server'), icon: 'nextcloud.svg',
    account: t('Nextcloud account'), signIn: t('Sign in'), waiting: t('Waiting for sign-in…'),
    description: t('Sync with your own Nextcloud or any WebDAV server.'),
    hint: t('Log in to Nextcloud in the browser and grant access, then return here.'),
    privacy: t('Works with Nextcloud, ownCloud and any WebDAV server. StepForge keeps its files in a StepForge folder in your account.'),
    storage: t('Stored in the StepForge folder of your account. Leave the files there as they are; StepForge manages them.'),
    quota: t('storage'),
    revoke: t('On Nextcloud you can also revoke StepForge’s app password under Settings → Security.'),
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
    off: ['idle', t('Auto-sync is paused')],
    synced: ['ok', t('Up to date')],
    syncing: ['busy', t('Syncing…')],
    pending: ['warn', t('Changes waiting to sync')],
    error: ['error', t('Needs attention')],
    disconnected: ['error', t('Sign in again')],
  };
  const formatWhen = (iso) => {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      : t('Date unavailable');
  };
  const timeAgo = (iso) => {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!(seconds >= 0)) return '';
    if (seconds < 60) return t('just now');
    if (seconds < 3600) return t('{count} min ago', { count: Math.round(seconds / 60) });
    if (seconds < 86400) return t('{count} hr ago', { count: Math.round(seconds / 3600) });
    return formatWhen(iso);
  };
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
  const server = isWebDAV ? el('input', { type: 'url', placeholder: 'cloud.example.com', autocomplete: 'url', spellcheck: false, 'aria-label': t('Server address') }) : null;
  const username = isWebDAV ? el('input', { type: 'text', autocomplete: 'username', spellcheck: false, 'aria-label': t('User name') }) : null;
  const password = isWebDAV ? el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': t('Password or app password') }) : null;
  const loginFields = isWebDAV ? el('div.cloud-login.hidden', {},
    el('label.cloud-field', {}, el('span', {}, t('User name')), username),
    el('label.cloud-field', {}, el('span', {}, t('Password or app password')), password),
    el('p.muted', {}, t('If your server offers app passwords, create one for StepForge and use it here instead of your main password.'))) : null;
  const usePassword = isWebDAV ? el('button.link', { type: 'button', onClick: () => {
    loginFields.classList.remove('hidden');
    usePassword.classList.add('hidden');
  } }, t('Use a user name and password instead')) : null;
  const signIn = async () => {
    const other = otherService(current);
    if (other) {
      const ok = await confirmDialog(el('div.cloud-confirm', {},
        el('strong', {}, t('Sync with {service} instead of {other}?', { service: S.name, other: other.name })),
        el('p', {}, t('StepForge syncs with one account at a time, so signing in here disconnects {other} on this computer.', { other: other.name })),
        el('p.muted', {}, t('Your guides stay on this computer, and everything already {where} stays there. Other computers keep syncing with {other} until you switch them too.', { where: other.where, other: other.name }))),
      { okLabel: t('Switch to {service}', { service: S.name }) });
      if (!ok) return;
    }
    await run(connect, S.waiting, async () => {
      const request = { provider };
      if (isWebDAV) {
        request.server = server.value.trim();
        if (!loginFields.classList.contains('hidden')) Object.assign(request, { username: username.value.trim(), password: password.value });
      }
      say(isWebDAV && request.username ? t('Signing in…') : S.hint);
      signingIn = true;
      cancel.classList.remove('hidden');
      linkHelp.classList.toggle('hidden', Boolean(isWebDAV && request.username));
      try {
        const result = await api.cloud.connect(request);
        if (result?.needsPassword) {
          // Not a Nextcloud server: ask for its WebDAV login.
          if (result.server) server.value = result.server;
          loginFields.classList.remove('hidden');
          usePassword.classList.add('hidden');
          say(t('This server isn’t Nextcloud, so enter its WebDAV user name and password. The address should be your WebDAV folder.'), 'info');
          return;
        }
        if (password) password.value = '';
        say(t('Connected. Your guides will sync automatically.'), 'success');
        await refreshLists();
      } finally { signingIn = false; cancel.classList.add('hidden'); linkHelp.classList.add('hidden'); }
    });
  };
  const connect = el('button.primary', { type: 'button', onClick: signIn }, S.signIn);
  const cancel = el('button.hidden', { type: 'button', onClick: () => api.cloud.cancel().catch((err) => say(err.message, 'error')) }, t('Cancel sign-in'));
  // For when the browser didn't open, or opened the wrong one.
  const linkHelp = el('p.cloud-signin-help.muted.hidden', {}, ...fillNodes(t('Browser didn’t open? {open} or {copy}.'), {
    open: el('button.link', { type: 'button', onClick: () => api.cloud.openSignInLink().catch((err) => say(err.message, 'error')) }, t('Open it again')),
    copy: el('button.link', { type: 'button', onClick: async () => {
      try {
        if ((await api.cloud.copySignInLink())?.ok) say(t('Sign-in link copied. Paste it into your browser’s address bar, then come back here.'));
      } catch (err) { say(err.message, 'error'); }
    } }, t('copy the sign-in link')),
  }));
  const unavailable = el('p.muted.hidden', {}, t('{service} sign-in is unavailable in this build of StepForge.', { service: S.name }));
  const switching = el('p.cloud-note.hidden', {}, '');
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: `../assets/icons/${S.icon}`, alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, t('Keep your guides in sync')),
      el('p.muted', {}, `${t('Back up your guides and pick them up on your other computers.')}${sentenceGap}${S.privacy}`),
      ...(isWebDAV ? [el('label.cloud-field', {}, el('span', {}, t('Server address')), server), loginFields] : []),
      switching,
      el('div.row', {}, connect, cancel, ...(isWebDAV ? [usePassword] : [])),
      linkHelp,
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
  const transferBar = el('div.cloud-meter', { role: 'progressbar', 'aria-label': t('{service} transfer', { service: S.name }), 'aria-valuemin': '0', 'aria-valuemax': '100' }, transferFill);
  const transferRow = el('div.cloud-transfer.hidden', {}, transferBar, transferText);
  const enabled = el('input', { type: 'checkbox', 'aria-label': t('Automatically sync guides') });
  const sync = el('button', { type: 'button', onClick: () => run(sync, t('Syncing…'), async () => {
    const result = await api.cloud.sync();
    say(result.message, result.phase === 'error' ? 'error' : result.phase === 'synced' ? 'success' : 'info');
    await refreshLists();
  }) }, t('Sync now'));
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, t('Disconnecting…'), async () => {
    await api.cloud.disconnect();
    say(`${t('Disconnected on this computer. Local guides and the copies {where} are kept.', { where: S.where })}${sentenceGap}${S.revoke}`);
  }) }, t('Disconnect'));
  const account = el('div.cloud-account.hidden', {},
    avatar,
    el('div.cloud-account-info', {}, email, el('div.cloud-status-line', {}, dot, phaseText, lastSync), transferRow),
    el('div.cloud-account-actions', {},
      el('label.switch', { title: t('Automatically sync guides') }, enabled, el('span.switch-track', { 'aria-hidden': 'true' }), t('Auto-sync')),
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
  const legendLatest = legendItem('latest', t('Latest versions'));
  const legendPrevious = legendItem('previous', t('Previous versions'));
  const legendRecovery = legendItem('recovery', t('Deleted-guide recovery'));
  const quotaNote = el('p.muted', {}, S.storage);
  const prune = el('button', { type: 'button', disabled: true, onClick: async () => {
    if (busy || disposed || !lastStorage) return;
    const { pruneCount = 0, fullCount = 0, reclaimableBytes = 0 } = lastStorage;
    // replaceChildren() would print a skipped (null) item as "null".
    const ok = await confirmDialog(el('div.cloud-confirm', {}, ...[
      el('strong', {}, reclaimableBytes ? t('Free up {size}?', { size: formatBytes(reclaimableBytes) }) : t('Free up space {where}?', { where: S.where })),
      pruneCount ? el('p', {}, tn(pruneCount, 'This removes {count} previous version {where}. The latest version of every guide is always kept.',
        'This removes {count} previous versions {where}. The latest version of every guide is always kept.', { where: S.where })) : null,
      fullCount ? el('p', {}, tn(fullCount, 'It also switches {count} guide version saved as a full copy to a space-saving version, so later versions only store what changed. It is downloaded and uploaded once.',
        'It also switches {count} guide versions saved as full copies to space-saving versions, so later versions only store what changed. Each one is downloaded and uploaded once.')) : null,
      pruneCount ? el('p.muted', {}, t('Removed versions can no longer be restored. This cannot be undone.')) : null,
    ].filter(Boolean)),
    { danger: pruneCount > 0, okLabel: t('Free up space') });
    if (!ok) return;
    await run(prune, t('Freeing up space…'), async () => {
      const result = await api.cloud.prune();
      const converted = result.converted ? ` ${tn(result.converted, '{count} guide version now stores only what changes.', '{count} guide versions now store only what changes.')}` : '';
      say(`${tn(result.pruned, 'Removed {count} previous version and freed {size}.', 'Removed {count} previous versions and freed {size}.', { size: formatBytes(result.reclaimedBytes) })}${converted}`, 'success');
      await refreshLists();
    });
  } }, t('Free up space'));
  const storageCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Storage')), storageTotal),
    el('div.cloud-meter', { role: 'img', 'aria-label': t('{service} storage used by StepForge', { service: S.name }) }, segLatest, segPrevious, segRecovery),
    el('div.cloud-legend', {}, legendLatest.node, legendPrevious.node, legendRecovery.node),
    el('div.cloud-card-foot', {}, quotaNote, prune),
  );

  /* Guides card */
  const guideCount = el('span.cloud-card-meta', {}, '');
  const guideList = el('div.cloud-guide-list', {}, el('p.muted', {}, t('Loading guides…')));
  const refresh = el('button', { type: 'button', title: t('Reload from {service}', { service: S.name }), onClick: () => run(refresh, t('Refreshing…'), refreshLists) }, t('Refresh'));
  const guidesCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Guides {where}', { where: S.whereShort })), guideCount, refresh),
    el('p.muted', {}, t('Each guide keeps its latest version and up to two previous versions you can restore. To stop syncing one guide, turn off sharing in its Guide information.')),
    guideList,
  );

  /* Deleted guides */
  const deletedCount = el('span.cloud-count', {}, '0');
  const deletedList = el('div.cloud-guide-list', {}, el('p.muted', {}, t('No recently deleted guides.')));
  const deletedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, t('Recently deleted')), deletedCount),
    el('p.muted', {}, t('Guides deleted from a synced library are removed from your other computers. One recovery copy stays {where} until you restore it or delete it permanently.', { where: S.whereShort })),
    deletedList,
  );

  /* Advanced */
  const testResults = el('ul.cloud-checks.hidden');
  const test = el('button', { type: 'button', onClick: () => run(test, t('Testing…'), async () => {
    testResults.replaceChildren();
    testResults.classList.add('hidden');
    const result = await api.cloud.test();
    testResults.replaceChildren(...result.checks.map(({ text, ok }) => el(`li.${ok ? 'pass' : 'fail'}`, {},
      el('span.cloud-check-icon', { 'aria-hidden': 'true' }, ok ? '✓' : '✕'), text.replace(/: passed$/, ''))));
    testResults.classList.remove('hidden');
    say(result.ok ? t('Connection test passed.') : t('Connection test needs attention.'), result.ok ? 'success' : 'error');
  }) }, t('Test connection'));
  const replace = el('button.danger', { type: 'button', onClick: async () => {
    if (busy || disposed) return;
    if (!current.enabled) { say(t('Turn on auto-sync before replacing what’s {where} with this computer’s guides.', { where: S.where }), 'error'); return; }
    const cloudOnly = lastGuides.filter((guide) => !guide.local).length;
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, t('Make this computer the source of truth?')),
      el('p', {}, t('Everything StepForge stored {where} is deleted, including previous versions and deleted-guide recovery copies. Then the guides on this computer are uploaded as the only copies.', { where: S.where })),
      cloudOnly ? el('p', {}, tn(cloudOnly, '{count} guide {where} is not on this computer and will be removed. Your other computers move it to their trash.',
        '{count} guides {where} are not on this computer and will be removed. Your other computers move them to their trash.', { where: S.whereShort })) : null,
      el('p.muted', {}, t('This cannot be undone.'))),
    { danger: true, okLabel: S.replace });
    if (!ok) return;
    await run(replace, t('Replacing…'), async () => {
      const result = await api.cloud.replaceCloudWithLocal();
      say(`${t('{service} now matches this computer.', { service: S.name })} ${tn(result.uploading, '{count} guide uploaded.', '{count} guides uploaded.')}`, 'success');
      await refreshLists();
    });
  } }, S.replaceWith);
  const advancedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, t('Advanced'))),
    el('div.cloud-setting', {},
      el('div', {}, el('strong', {}, t('Test connection')),
        el('p.muted', {}, t('Checks sign-in, storage access, and a temporary upload and download. No guides are uploaded.'))),
      test),
    testResults,
    el('div.cloud-setting.cloud-danger', {},
      el('div', {}, el('strong', {}, t('Use this computer as the source of truth')),
        el('p.muted', {}, t('Deletes everything StepForge stored {where} and replaces it with the guides on this computer.', { where: S.where }))),
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
    switching.textContent = other ? t('You’re syncing with {other} now. StepForge syncs with one account at a time, so signing in here switches this computer to {service}.', { other: other.name, service: S.name }) : '';
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
    lastSync.textContent = next.lastSync && tone !== 'busy' ? ` · ${t('Last synced {when}', { when: timeAgo(next.lastSync) })}` : '';
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
    if (connected && previous === 'syncing' && next.phase === 'synced' && !busy) void refreshLists();
  }

  const renderStorage = (summary) => {
    lastStorage = summary;
    const total = summary.bytes || 0;
    storageTotal.textContent = t('{size} used', { size: formatBytes(total) });
    const pct = (value) => `${total ? Math.max(value ? 2 : 0, (value / total) * 100) : 0}%`;
    segLatest.style.width = pct(summary.latestBytes || 0);
    segPrevious.style.width = pct(summary.previousBytes || 0);
    segRecovery.style.width = pct(summary.recoveryBytes || 0);
    legendLatest.value.textContent = formatBytes(summary.latestBytes || 0);
    legendPrevious.value.textContent = formatBytes(summary.previousBytes || 0);
    legendRecovery.value.textContent = formatBytes(summary.recoveryBytes || 0);
    const quota = summary.quota;
    quotaNote.textContent = quota?.limit
      ? `${t('Uses {percent}% of your {limit} {quota}.', { percent: ((total / quota.limit) * 100).toFixed(total / quota.limit < 0.001 ? 2 : 1), limit: formatBytes(quota.limit), quota: S.quota })}${sentenceGap}${S.storage}`
      : S.storage;
    prune.textContent = summary.reclaimableBytes ? t('Free up {size}', { size: formatBytes(summary.reclaimableBytes) })
      : summary.fullCount ? t('Free up space') : t('Nothing to free up');
    prune.disabled = busy || !canFreeUp(summary);
  };

  const renderVersions = async (guide, host) => {
    let versions;
    try { versions = await api.cloud.history({ guideId: guide.guideId }); }
    catch (err) { if (!disposed) host.replaceChildren(el('p.muted', {}, err.message)); return; }
    if (disposed) return;
    host.replaceChildren();
    if (!versions.length) { host.append(el('p.muted', {}, t('No versions remain. Refresh the list.'))); return; }
    for (const [index, version] of versions.entries()) {
      const restore = el('button', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(el('div.cloud-confirm', {},
          el('strong', {}, t('Restore “{title}”?', { title: guide.title })),
          el('p', {}, t('This replaces the guide on this computer with the version from {when}. Your current copy is backed up first.', { when: formatWhen(version.createdTime) })),
          el('p.muted', {}, t('With sync on, the restored version becomes the latest version {where}.', { where: S.where }))),
        { okLabel: t('Restore version') });
        if (!ok) return;
        await run(restore, t('Restoring…'), async () => {
          await api.cloud.restore({ guideId: guide.guideId, versionId: version.id });
          say(t('Restored “{title}” from {when}.', { title: guide.title, when: formatWhen(version.createdTime) }), 'success');
          await refreshLists();
        });
      } }, t('Restore'));
      host.append(el(`div.cloud-version${index === 0 ? '.latest' : ''}`, {},
        el('span.cloud-version-dot', { 'aria-hidden': 'true' }),
        el('div.cloud-version-info', {},
          el('span', {}, formatWhen(version.createdTime)),
          el('span.muted', {}, `${index === 0 ? t('Latest') : t('Previous version')} · ${formatBytes(version.size)}`)),
        restore));
    }
  };

  const refreshGuides = async () => {
    const request = ++guideRequest;
    const guides = await api.cloud.guides();
    if (disposed || request !== guideRequest) return;
    lastGuides = guides;
    guideCount.textContent = guides.length ? tn(guides.length, '{count} guide', '{count} guides') : '';
    guideList.replaceChildren();
    if (!guides.length) { guideList.append(el('p.cloud-empty.muted', {}, t('No guides {where} yet.', { where: S.where }))); return; }
    for (const guide of guides) {
      const versions = el('div.cloud-versions', { hidden: true });
      const toggle = el('button', { type: 'button', 'aria-expanded': 'false', onClick: async () => {
        const open = versions.hidden;
        versions.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
          versions.replaceChildren(el('p.muted', {}, t('Loading versions…')));
          await renderVersions(guide, versions);
        }
      } }, t('Versions'));
      const download = guide.local ? null : el('button', { type: 'button', onClick: () => run(download, t('Downloading…'), async () => {
        await api.cloud.restore({ guideId: guide.guideId, versionId: guide.latestId });
        say(t('Downloaded “{title}” to this computer.', { title: guide.title }), 'success');
        await refreshLists();
      }) }, t('Download'));
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(el('div.cloud-confirm', {},
          el('strong', {}, t('Delete “{title}” from {service}?', { title: guide.title, service: S.name })),
          el('p', {}, `${tn(guide.snapshotCount, 'Its {count} version {where} will be deleted.', 'All {count} versions {where} will be deleted.', { where: S.whereShort })} ${guide.local ? t('The guide stays on this computer and stops syncing.') : t('This guide is not on this computer.')}`),
          el('p.muted', {}, t('Other computers that still sync this guide may upload it again. This cannot be undone.'))),
        { danger: true, okLabel: S.deleteFrom });
        if (!ok) return;
        await run(remove, t('Deleting…'), async () => {
          await api.cloud.deleteGuideSnapshots({ guideId: guide.guideId });
          say(`${t('Deleted “{title}” from {service}.', { title: guide.title, service: S.name })}${guide.local ? ` ${t('The guide is still on this computer.')}` : ''}`, 'success');
          await refreshLists();
        });
      } }, S.deleteFrom);
      guideList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title),
            el('div.cloud-chips', {},
              el(`span.cloud-chip${guide.local ? '.local' : ''}`, {}, guide.local ? t('On this computer') : t('Only {where}', { where: S.whereShort })),
              el('span.cloud-chip', {}, tn(guide.snapshotCount, '{count} version', '{count} versions')),
              el('span.cloud-chip', {}, formatBytes(guide.bytes)),
              guide.updatedAt ? el('span.muted', {}, t('Updated {when}', { when: timeAgo(guide.updatedAt) })) : null)),
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
    if (!recoverable.length) { deletedList.append(el('p.cloud-empty.muted', {}, t('No recently deleted guides.'))); return; }
    for (const guide of recoverable) {
      const restore = el('button', { type: 'button', onClick: async () => {
        const ok = await confirmDialog(t('Restore “{title}” to your library? It will sync to your other computers again.', { title: guide.title }), { okLabel: t('Restore') });
        if (!ok) return;
        await run(restore, t('Restoring…'), async () => {
          await api.cloud.restoreDeletedGuide({ guideId: guide.guideId });
          say(t('Restored “{title}”.', { title: guide.title }), 'success');
          await refreshLists();
        });
      } }, t('Restore'));
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        const ok = await confirmDialog(t('Permanently delete the recovery copy of “{title}”? It cannot be restored afterwards.', { title: guide.title }), { danger: true, okLabel: t('Delete permanently') });
        if (!ok) return;
        await run(remove, t('Deleting…'), async () => {
          await api.cloud.permanentlyDeleteRecovery({ guideId: guide.guideId });
          await refreshLists();
        });
      } }, t('Delete permanently'));
      deletedList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon.deleted', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title),
            el('div.cloud-chips', {},
              el('span.cloud-chip', {}, formatBytes(guide.size)),
              el('span.muted', {}, t('Deleted {when}', { when: guide.deletedAt ? timeAgo(guide.deletedAt) : t('(date unavailable)') })))),
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

  enabled.addEventListener('change', () => run(sync, t('Applying…'), async () => {
    // Capture the requested value before run() restores the saved control state.
    await api.cloud.enable({ enabled: !current.enabled });
  }));

  const node = el('fieldset.cloud-panel', {},
    el('legend', {}, t('{service} sharing', { service: S.name })),
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
