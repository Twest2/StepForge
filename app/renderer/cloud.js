'use strict';

/* Cloud controls take effect immediately, independently of the main Settings form. */
function makeCloudSettings(api) {
  const status = el('p.muted', { role: 'status', 'aria-live': 'polite' }, 'Loading Google Drive status…');
  const results = el('pre.cloud-test-results.muted', { role: 'status', 'aria-live': 'polite' });
  const enabled = el('input', { type: 'checkbox' });
  const storage = el('p.muted', { role: 'status' }, 'Drive archive usage will appear after connecting.');
  const guideList = el('div.cloud-guide-list', {}, 'Loading Drive guides…');
  let guideRequest = 0;
  const deletedList = el('div.muted', {}, 'No deleted cloud guides.');
  let current = {};
  let busy = false;
  let signingIn = false;
  let disposed = false;

  const update = (next) => {
    current = next;
    enabled.checked = Boolean(next.enabled);
    enabled.disabled = busy || !next.connected;
    connect.disabled = busy || next.connected || next.available === false;
    connect.classList.toggle('hidden', Boolean(next.connected));
    disconnect.classList.toggle('hidden', !next.connected && !next.error);
    connectedControls.classList.toggle('hidden', !next.connected);
    disconnect.disabled = busy || (!next.connected && !next.error);
    test.disabled = busy || !next.connected;
    sync.disabled = busy || !next.enabled;
    status.textContent = next.available === false
      ? 'Google sign-in is unavailable in this build of StepForge.'
      : [next.email ? `Connected as ${next.email}.` : next.connected ? 'Google account connected.' : 'Not connected.', next.error || next.message].filter(Boolean).join(' ');
  };
  const run = async (button, label, action) => {
    if (busy || disposed) return;
    busy = true;
    update(current);
    setButtonLoading(button, true, label);
    try {
      await action();
    } catch (err) {
      if (!disposed) results.textContent = err.message;
    } finally {
      busy = false;
      if (!disposed) {
        try { current = await api.cloud.status(); } catch { /* retain the last status if IPC is unavailable */ }
        setButtonLoading(button, false);
        update(current);
      }
    }
  };
  const connect = el('button', { type: 'button', onClick: () => run(connect, 'Waiting for Google…', async () => {
    results.textContent = 'Choose your Google account in the browser and allow StepForge to store its guides. Return here when finished.';
    signingIn = true;
    cancel.classList.remove('hidden');
    try {
      await api.cloud.connect();
      results.textContent = 'Connected. Your guides will sync automatically.';
      await refreshLists();
    } finally { signingIn = false; cancel.classList.add('hidden'); }
  }) }, 'Sign in with Google');
  const cancel = el('button.hidden', { type: 'button', onClick: () => api.cloud.cancel().catch((err) => { results.textContent = err.message; }) }, 'Cancel sign-in');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, 'Disconnecting…', async () => {
    await api.cloud.disconnect();
    results.textContent = 'Disconnected on this device. Local guides and Google Drive copies are kept. You can also revoke access in your Google account.';
  }) }, 'Disconnect');
  const test = el('button', { type: 'button', onClick: () => run(test, 'Testing…', async () => {
    results.textContent = 'Testing authentication, Drive access, and a temporary upload/download…';
    const result = await api.cloud.test();
    results.textContent = `${result.ok ? 'Connection test passed.' : 'Connection test needs attention.'}\n${result.checks.join('\n')}`;
  }) }, 'Test Google Drive connection');
  const sync = el('button', { type: 'button', onClick: () => run(sync, 'Syncing…', async () => {
    const result = await api.cloud.sync();
    results.textContent = result.message;
    await refreshLists();
  }) }, 'Sync now');
  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  const refreshStorage = async () => {
    const summary = await api.cloud.storage();
    storage.textContent = `${formatBytes(summary.bytes)} used by ${summary.snapshotCount} private snapshot${summary.snapshotCount === 1 ? '' : 's'} across ${summary.guideCount} guide${summary.guideCount === 1 ? '' : 's'}.`
      + (summary.pruneCount ? ` ${formatBytes(summary.reclaimableBytes)} can be reclaimed.` : '');
    prune.disabled = busy || !summary.pruneCount;
  };
  const refreshDeleted = async () => {
    const guides = await api.cloud.deletedGuides();
    deletedList.replaceChildren();
    if (!guides.length) { deletedList.textContent = 'No deleted cloud guides.'; return; }
    deletedList.classList.remove('muted');
    for (const guide of guides) {
      const restore = el('button', { type: 'button', disabled: guide.purged, onClick: async () => {
        const ok = await confirmDialog(`Restore “${guide.title}” to your shared library?`, { okLabel: 'Restore' });
        if (!ok) return;
        await run(restore, 'Restoring…', async () => { await api.cloud.restoreDeletedGuide({ guideId: guide.guideId }); await refreshLists(); });
      } }, 'Restore');
      const remove = el('button', { type: 'button', disabled: guide.purged, onClick: async () => {
        const ok = await confirmDialog(`Permanently delete the Google Drive recovery snapshot for “${guide.title}”? It cannot be restored afterwards.`, { danger: true, okLabel: 'Delete permanently' });
        if (!ok) return;
        await run(remove, 'Deleting…', async () => { await api.cloud.permanentlyDeleteRecovery({ guideId: guide.guideId }); await refreshLists(); });
      } }, guide.purged ? 'Recovery deleted' : 'Delete permanently');
      deletedList.append(el('div.form-row', {},
        el('div', {}, guide.title, el('div.muted', {}, `${guide.purged ? 'Recovery permanently deleted' : `${formatBytes(guide.size)} recovery snapshot`} · ${guide.deletedAt ? new Date(guide.deletedAt).toLocaleString() : 'date unavailable'}`)),
        el('div.row', {}, restore, remove),
      ));
    }
  };
  const refreshGuides = async () => {
    const request = ++guideRequest;
    const guides = await api.cloud.guides();
    if (disposed || request !== guideRequest) return;
    guideList.replaceChildren();
    if (!guides.length) { guideList.textContent = 'No active guides in Google Drive.'; return; }
    for (const guide of guides) {
      const snapshots = el('div.cloud-snapshot-list');
      const history = el('button', { type: 'button', onClick: () => run(history, 'Loading…', async () => {
        const versions = await api.cloud.history({ guideId: guide.guideId });
        if (disposed) return;
        snapshots.replaceChildren();
        if (!versions.length) { snapshots.textContent = 'No snapshots remain. Refresh the list.'; return; }
        const choice = el('select', { 'aria-label': `Snapshot for ${guide.title}` }, ...versions.map((version, index) =>
          el('option', { value: version.id }, `${index === 0 ? 'Newest' : 'Previous'} · ${version.createdTime ? new Date(version.createdTime).toLocaleString() : 'Date unavailable'} · ${formatBytes(version.size)}`)));
        const restore = el('button', { type: 'button', onClick: async () => {
          if (busy || disposed) return;
          const selected = versions.find((version) => version.id === choice.value);
          if (!selected) return;
          const when = selected.createdTime ? new Date(selected.createdTime).toLocaleString() : 'the selected date';
          const ok = await confirmDialog(`Restore “${guide.title}” from ${when}? This replaces its local content; the current local copy is backed up. With sharing enabled, the restored version will sync to Google Drive.`, { okLabel: 'Restore snapshot' });
          if (!ok) return;
          await run(restore, 'Restoring…', async () => {
            await api.cloud.restore({ guideId: guide.guideId, versionId: selected.id });
            results.textContent = `Restored “${guide.title}”.`;
            await refreshLists();
          });
        } }, 'Restore snapshot');
        snapshots.append(el('div.row', {}, choice, restore));
      }) }, 'Snapshots');
      const remove = el('button.danger', { type: 'button', onClick: async () => {
        if (busy || disposed) return;
        const ok = await confirmDialog(`Delete all ${guide.snapshotCount} Drive snapshots for “${guide.title}”? This cannot be undone. Local guides are kept and sharing is disabled for this guide on this device. Other devices with sharing enabled may upload it again.`, { danger: true, okLabel: 'Delete Drive copies' });
        if (!ok) return;
        await run(remove, 'Deleting…', async () => {
          await api.cloud.deleteGuideSnapshots({ guideId: guide.guideId });
          results.textContent = `Deleted Drive copies of “${guide.title}”. Local guides were kept.`;
          await refreshLists();
        });
      } }, 'Delete Drive copies');
      guideList.append(el('div.cloud-guide', {},
        el('div.form-row', {},
          el('div', {}, guide.title, el('div.muted', {}, `${guide.snapshotCount} snapshot${guide.snapshotCount === 1 ? '' : 's'} · ${formatBytes(guide.bytes)} · ${guide.local ? 'In this library' : 'Cloud only'}`)),
          el('div.row', {}, history, remove)), snapshots));
    }
  };
  const refreshLists = async () => {
    await Promise.all([
      refreshGuides().catch((err) => { if (!disposed) guideList.textContent = err.message; }),
      refreshStorage().catch((err) => { if (!disposed) storage.textContent = err.message; }),
      refreshDeleted().catch((err) => { if (!disposed) deletedList.textContent = err.message; }),
    ]);
  };
  const refresh = el('button', { type: 'button', onClick: () => run(refresh, 'Refreshing…', refreshLists) }, 'Refresh Drive files');
  const prune = el('button', { type: 'button', onClick: async () => {
    const ok = await confirmDialog('Remove older Google Drive snapshots? The newest snapshot and two previous snapshots on every version branch will be kept.', { danger: true, okLabel: 'Prune old snapshots' });
    if (!ok) return;
    await run(prune, 'Pruning…', async () => { await api.cloud.prune(); await refreshLists(); });
  } }, 'Prune old snapshots');
  enabled.addEventListener('change', () => run(sync, 'Applying…', async () => {
    // Capture the requested value before run() restores the saved control state.
    await api.cloud.enable({ enabled: !current.enabled });
  }));
  const connectedControls = el('div.hidden', {},
    el('label.cloud-enable', {}, enabled, ' Automatically sync guides'),
    el('p.muted', {}, 'Incoming updates wait until the editor is closed and capture is stopped. Conflicts keep both versions in your library. Archives are stored in private app storage, not the My Drive file list.'),
    el('h4', {}, 'Private archive storage'),
    storage,
    el('p.muted', {}, 'Each guide keeps its newest snapshot and two earlier snapshots. Pruning never removes a retained snapshot.'),
    el('div.row', {}, prune),
    el('h4', {}, 'Guides in Google Drive'),
    el('p.muted', {}, 'Browse every active cloud guide, restore a saved snapshot, or delete its Drive copies. Close the guide editor and stop capture before restoring.'),
    el('div.row', {}, refresh), guideList,
    el('h4', {}, 'Deleted guide recovery'),
    el('p.muted', {}, 'A guide deleted from a shared library is removed from connected devices. One private recovery snapshot remains until you restore it or delete it permanently.'),
    deletedList,
    el('h4', {}, 'Google Drive testing'),
    el('p.muted', {}, 'Checks sign-in, token refresh, storage access, and upload/download integrity using a small temporary file, then deletes it. No guides are uploaded by this test.'),
    el('div.row', {}, test, sync),
  );
  const node = el('fieldset', {},
    el('legend', {}, 'Google Drive sharing'),
    el('p.muted', {}, 'Store and synchronize your guides privately using your Google Drive account. Signing in enables automatic sharing of your guides, including screenshots and text. You can exclude an individual guide from its Guide information.'),
    status,
    el('div.row', {}, connect, cancel, disconnect),
    connectedControls, results,
  );
  const unsubscribe = api.cloud.onStatus((next) => { if (!disposed) update(next); });
  api.cloud.status().then(async (next) => {
    if (!disposed) {
      update(next);
      if (next.connected) {
        await refreshLists();
      }
    }
  }).catch((err) => { status.textContent = err.message; });
  return { node, dispose() { disposed = true; unsubscribe(); if (signingIn) void api.cloud.cancel().catch(() => {}); } };
}
