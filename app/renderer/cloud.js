'use strict';

/* Cloud controls take effect immediately, independently of the main Settings form. */
function makeCloudSettings(api) {
  const PHASES = {
    off: ['idle', 'Auto-sync is paused'],
    synced: ['ok', 'Up to date'],
    syncing: ['busy', 'Syncing…'],
    pending: ['warn', 'Changes waiting to sync'],
    conflict: ['warn', 'Conflict copies saved to your library'],
    error: ['error', 'Needs attention'],
    disconnected: ['error', 'Sign in again'],
  };
  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${units[unit]}`;
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
  const connect = el('button.primary', { type: 'button', onClick: () => run(connect, 'Waiting for Google…', async () => {
    say('Choose your Google account in the browser and allow StepForge to store its guides, then return here.');
    signingIn = true;
    cancel.classList.remove('hidden');
    try {
      await api.cloud.connect();
      say('Connected. Your guides will sync automatically.', 'success');
      await refreshLists();
    } finally { signingIn = false; cancel.classList.add('hidden'); }
  }) }, 'Sign in with Google');
  const cancel = el('button.hidden', { type: 'button', onClick: () => api.cloud.cancel().catch((err) => say(err.message, 'error')) }, 'Cancel sign-in');
  const unavailable = el('p.muted.hidden', {}, 'Google sign-in is unavailable in this build of StepForge.');
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, '☁'),
    el('div.cloud-hero-text', {},
      el('strong', {}, 'Keep your guides in sync'),
      el('p.muted', {}, 'Back up your guides and pick them up on your other computers. They are stored in a private app folder only StepForge can see — not your My Drive files.'),
      el('div.row', {}, connect, cancel),
      unavailable,
    ),
  );

  /* Account header */
  const avatar = el('div.cloud-avatar', { 'aria-hidden': 'true' }, '?');
  const email = el('strong.cloud-email', {}, 'Google account');
  const dot = el('span.cloud-dot', { 'aria-hidden': 'true' });
  const phaseText = el('span', {}, '');
  const lastSync = el('span.muted', {}, '');
  const enabled = el('input', { type: 'checkbox', 'aria-label': 'Automatically sync guides' });
  const sync = el('button', { type: 'button', onClick: () => run(sync, 'Syncing…', async () => {
    const result = await api.cloud.sync();
    say(result.message, result.phase === 'error' ? 'error' : result.phase === 'synced' ? 'success' : 'info');
    await refreshLists();
  }) }, 'Sync now');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, 'Disconnecting…', async () => {
    await api.cloud.disconnect();
    say('Disconnected on this computer. Local guides and Google Drive copies are kept. You can also revoke access in your Google account.');
  }) }, 'Disconnect');
  const account = el('div.cloud-account.hidden', {},
    avatar,
    el('div.cloud-account-info', {}, email, el('div.cloud-status-line', {}, dot, phaseText, lastSync)),
    el('div.cloud-account-actions', {},
      el('label.cloud-switch', { title: 'Automatically sync guides' }, enabled, el('span.cloud-switch-track', { 'aria-hidden': 'true' }), 'Auto-sync'),
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
  const quotaNote = el('p.muted', {}, 'Stored in a hidden app folder, so it won’t appear in your Drive file list.');
  const prune = el('button', { type: 'button', disabled: true, onClick: async () => {
    if (busy || disposed || !lastStorage) return;
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, `Free up ${formatBytes(lastStorage.reclaimableBytes)}?`),
      el('p', {}, `This removes ${plural(lastStorage.pruneCount, 'previous version')} from Google Drive. The latest version of every guide is always kept.`),
      el('p.muted', {}, 'Removed versions can no longer be restored. This cannot be undone.')),
    { danger: true, okLabel: 'Free up space' });
    if (!ok) return;
    await run(prune, 'Freeing up space…', async () => {
      const result = await api.cloud.prune();
      say(`Removed ${plural(result.pruned, 'previous version')} and freed ${formatBytes(result.reclaimedBytes)}.`, 'success');
      await refreshLists();
    });
  } }, 'Free up space');
  const storageCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Storage'), storageTotal),
    el('div.cloud-meter', { role: 'img', 'aria-label': 'Google Drive storage used by StepForge' }, segLatest, segPrevious, segRecovery),
    el('div.cloud-legend', {}, legendLatest.node, legendPrevious.node, legendRecovery.node),
    el('div.cloud-card-foot', {}, quotaNote, prune),
  );

  /* Guides card */
  const guideCount = el('span.cloud-card-meta', {}, '');
  const guideList = el('div.cloud-guide-list', {}, el('p.muted', {}, 'Loading guides…'));
  const refresh = el('button', { type: 'button', title: 'Reload from Google Drive', onClick: () => run(refresh, 'Refreshing…', refreshLists) }, 'Refresh');
  const guidesCard = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Guides in Drive'), guideCount, refresh),
    el('p.muted', {}, 'Each guide keeps its latest version and up to two previous versions you can restore. To stop syncing one guide, turn off sharing in its Guide information.'),
    guideList,
  );

  /* Deleted guides */
  const deletedCount = el('span.cloud-count', {}, '0');
  const deletedList = el('div.cloud-guide-list', {}, el('p.muted', {}, 'No recently deleted guides.'));
  const deletedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, 'Recently deleted'), deletedCount),
    el('p.muted', {}, 'Guides deleted from a synced library are removed from your other computers. One recovery copy stays in Drive until you restore it or delete it permanently.'),
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
    if (!current.enabled) { say('Turn on auto-sync before replacing Google Drive with this computer’s guides.', 'error'); return; }
    const cloudOnly = lastGuides.filter((guide) => !guide.local).length;
    const ok = await confirmDialog(el('div.cloud-confirm', {},
      el('strong', {}, 'Make this computer the source of truth?'),
      el('p', {}, 'Everything in Google Drive is deleted, including previous versions and deleted-guide recovery copies. Then the guides on this computer are uploaded as the only copies.'),
      cloudOnly ? el('p', {}, `${plural(cloudOnly, 'guide')} in Drive ${cloudOnly === 1 ? 'is' : 'are'} not on this computer and will be removed. Your other computers move ${cloudOnly === 1 ? 'it' : 'them'} to their trash.`) : null,
      el('p.muted', {}, 'This cannot be undone.')),
    { danger: true, okLabel: 'Replace Drive' });
    if (!ok) return;
    await run(replace, 'Replacing…', async () => {
      const result = await api.cloud.replaceCloudWithLocal();
      say(`Google Drive now matches this computer. ${plural(result.uploading, 'guide')} uploaded.`, 'success');
      await refreshLists();
    });
  } }, 'Replace Drive with this computer');
  const advancedCard = el('details.cloud-card.cloud-collapsible', {},
    el('summary', {}, el('h4', {}, 'Advanced')),
    el('div.cloud-setting', {},
      el('div', {}, el('strong', {}, 'Test connection'),
        el('p.muted', {}, 'Checks sign-in, storage access, and a temporary upload and download. No guides are uploaded.')),
      test),
    testResults,
    el('div.cloud-setting.cloud-danger', {},
      el('div', {}, el('strong', {}, 'Use this computer as the source of truth'),
        el('p.muted', {}, 'Deletes everything in Google Drive and replaces it with the guides on this computer.')),
      replace),
  );

  const signedIn = el('div.cloud-stack.hidden', {}, storageCard, guidesCard, deletedCard, advancedCard);

  function update(next) {
    const previous = current.phase;
    current = next;
    const connected = Boolean(next.connected);
    signedOut.classList.toggle('hidden', connected);
    account.classList.toggle('hidden', !connected);
    signedIn.classList.toggle('hidden', !connected);
    unavailable.classList.toggle('hidden', next.available !== false);
    connect.disabled = busy || connected || next.available === false;
    enabled.checked = Boolean(next.enabled);
    enabled.disabled = busy || !connected;
    sync.disabled = busy || !next.enabled;
    disconnect.disabled = busy;
    test.disabled = busy || !connected;
    replace.disabled = busy || !connected;
    prune.disabled = busy || !lastStorage?.pruneCount;

    email.textContent = next.email || 'Google account';
    avatar.textContent = (next.email || '?').slice(0, 1).toUpperCase();
    const phase = next.error ? 'error' : next.enabled ? next.phase || 'pending' : 'off';
    const [tone, label] = PHASES[phase] || PHASES.pending;
    dot.className = `cloud-dot ${tone}`;
    phaseText.textContent = label;
    phaseText.title = next.error || next.message || '';
    lastSync.textContent = next.lastSync && tone !== 'busy' ? ` · Last synced ${timeAgo(next.lastSync)}` : '';
    if ((phase === 'error' || phase === 'disconnected') && (next.error || next.message)) say(next.error || next.message, 'error');
    // Refresh the Drive lists when a background sync finishes.
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
      ? `Uses ${((total / quota.limit) * 100).toFixed(total / quota.limit < 0.001 ? 2 : 1)}% of your ${formatBytes(quota.limit)} Google storage. Stored in a hidden app folder, so it won’t appear in your Drive file list.`
      : 'Stored in a hidden app folder, so it won’t appear in your Drive file list.';
    prune.textContent = summary.pruneCount ? `Free up ${formatBytes(summary.reclaimableBytes)}` : 'Nothing to free up';
    prune.disabled = busy || !summary.pruneCount;
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
          el('p.muted', {}, 'With sync on, the restored version becomes the latest version in Google Drive.')),
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
    if (!guides.length) { guideList.append(el('p.cloud-empty.muted', {}, 'No guides in Google Drive yet.')); return; }
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
          el('strong', {}, `Delete “${guide.title}” from Google Drive?`),
          el('p', {}, `All ${plural(guide.snapshotCount, 'version')} in Drive will be deleted. ${guide.local ? 'The guide stays on this computer and stops syncing.' : 'This guide is not on this computer.'}`),
          el('p.muted', {}, 'Other computers that still sync this guide may upload it again. This cannot be undone.')),
        { danger: true, okLabel: 'Delete from Drive' });
        if (!ok) return;
        await run(remove, 'Deleting…', async () => {
          await api.cloud.deleteGuideSnapshots({ guideId: guide.guideId });
          say(`Deleted “${guide.title}” from Google Drive.${guide.local ? ' The guide is still on this computer.' : ''}`, 'success');
          await refreshLists();
        });
      } }, 'Delete from Drive');
      guideList.append(el('div.cloud-guide', {},
        el('div.cloud-guide-row', {},
          el('div.cloud-guide-icon', { 'aria-hidden': 'true' }, (guide.title || '?').trim().slice(0, 1).toUpperCase() || '?'),
          el('div.cloud-guide-info', {},
            el('div.cloud-guide-title', { title: guide.title }, guide.title),
            el('div.cloud-chips', {},
              el(`span.cloud-chip${guide.local ? '.local' : ''}`, {}, guide.local ? 'On this computer' : 'Only in Drive'),
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
    el('legend', {}, 'Google Drive sharing'),
    signedOut, account, banner, signedIn,
  );
  const unsubscribe = api.cloud.onStatus((next) => { if (!disposed) update(next); });
  api.cloud.status().then(async (next) => {
    if (!disposed) {
      update(next);
      if (next.connected) await refreshLists();
    }
  }).catch((err) => say(err.message, 'error'));
  return { node, dispose() { disposed = true; unsubscribe(); if (signingIn) void api.cloud.cancel().catch(() => {}); } };
}
