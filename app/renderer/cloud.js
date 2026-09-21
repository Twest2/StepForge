'use strict';

/* Cloud controls take effect immediately, independently of the main Settings form. */
function makeCloudSettings(api) {
  const status = el('p.muted', { role: 'status', 'aria-live': 'polite' }, 'Loading Google Drive status…');
  const results = el('pre.cloud-test-results.muted', { role: 'status', 'aria-live': 'polite' });
  const enabled = el('input', { type: 'checkbox' });
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
    if (busy) return;
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
  }) }, 'Sync now');
  enabled.addEventListener('change', () => run(sync, 'Applying…', async () => {
    // Capture the requested value before run() restores the saved control state.
    await api.cloud.enable({ enabled: !current.enabled });
  }));
  const connectedControls = el('div.hidden', {},
    el('label.cloud-enable', {}, enabled, ' Automatically sync guides'),
    el('p.muted', {}, 'Incoming updates wait until the editor is closed and capture is stopped. Conflicts keep both versions in your library. Deletions stay local. Archives are stored in private app storage, not the My Drive file list.'),
    el('h4', {}, 'Google Drive testing'),
    el('p.muted', {}, 'Checks sign-in, token refresh, storage access, and upload/download integrity using a small temporary file, then deletes it. No guides are uploaded by this test.'),
    el('div.row', {}, test, sync),
  );
  const node = el('fieldset', {},
    el('legend', {}, 'Google Drive sharing (optional)'),
    el('p.muted', {}, 'Store and synchronize your guides privately using your Google Drive account. Signing in enables automatic sharing of all your guides, including screenshots and text. You can turn sharing off at any time.'),
    status,
    el('div.row', {}, connect, cancel, disconnect),
    connectedControls, results,
  );
  const unsubscribe = api.cloud.onStatus((next) => { if (!disposed) update(next); });
  api.cloud.status().then((next) => { if (!disposed) update(next); }).catch((err) => { status.textContent = err.message; });
  return { node, dispose() { disposed = true; unsubscribe(); if (signingIn) void api.cloud.cancel().catch(() => {}); } };
}
