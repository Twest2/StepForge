'use strict';

/* Cloud controls take effect immediately, independently of the main Settings form. */
function makeCloudSettings(api) {
  const clientId = el('input', { type: 'text', placeholder: 'Desktop app client ID', autocomplete: 'off', 'aria-label': 'Google OAuth client ID' });
  const clientSecret = el('input', { type: 'password', placeholder: 'Desktop app client secret', autocomplete: 'off', 'aria-label': 'Google OAuth client secret' });
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
    connect.disabled = busy || next.connected;
    disconnect.disabled = busy || (!next.connected && !next.error);
    test.disabled = busy || !next.connected;
    sync.disabled = busy || !next.enabled;
    clientId.disabled = busy || next.connected;
    clientSecret.disabled = busy || next.connected;
    if (next.clientId && !clientId.value) clientId.value = next.clientId;
    status.textContent = [next.email ? `Connected: ${next.email}.` : next.connected ? 'Google account connected.' : 'Not connected.', next.error || next.message].filter(Boolean).join(' ');
  };
  const run = async (button, label, action) => {
    if (busy) return;
    busy = true;
    update(current);
    setButtonLoading(button, true, label);
    try {
      await action();
      if (!disposed) update(await api.cloud.status());
    } catch (err) {
      if (!disposed) results.textContent = err.message;
    } finally {
      busy = false;
      if (!disposed) { setButtonLoading(button, false); update(current); }
    }
  };
  const connect = el('button', { type: 'button', onClick: () => run(connect, 'Waiting for Google…', async () => {
    if (!clientId.value.trim()) {
      node.querySelector('details').open = true;
      throw new Error('Enter a Google OAuth Desktop app client ID in Google OAuth setup.');
    }
    results.textContent = 'Complete sign-in in your browser. This does not enable guide sharing.';
    signingIn = true;
    cancel.classList.remove('hidden');
    try {
      await api.cloud.connect({ clientId: clientId.value.trim(), clientSecret: clientSecret.value.trim() });
      clientSecret.value = '';
      results.textContent = 'Authentication succeeded. Run the connection test before enabling sharing.';
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
  const node = el('fieldset', {},
    el('legend', {}, 'Google Drive sharing (optional)'),
    el('p.muted', {}, 'Off by default. Enabling sharing uploads all local guides, including screenshots and text, to this Google account and downloads guides from your other devices. These controls take effect immediately.'),
    el('details', {},
      el('summary', {}, 'Google OAuth setup'),
      el('p.muted', {}, 'Enable the Google Drive API in your Google Cloud project and create an OAuth Desktop app client. Use the same project on both computers. If the app is in Testing, add your account as a test user.'),
      el('div.form-row', {}, el('label', {}, 'Client ID'), clientId),
      el('div.form-row', {}, el('label', {}, 'Client secret'), clientSecret),
      el('a', { href: 'https://console.cloud.google.com/apis/credentials' }, 'Open Google Cloud credentials'),
    ),
    status,
    el('div.row', {}, connect, cancel, disconnect),
    el('label.cloud-enable', {}, enabled, ' Automatically share guides with Google Drive'),
    el('p.muted', {}, 'Incoming updates wait until the editor is closed and capture is stopped. Conflicts keep both versions in your library. Deletions stay local. Archives are stored in private app storage, not the My Drive file list.'),
    el('h4', {}, 'Google Drive testing'),
    el('p.muted', {}, 'Checks sign-in, token refresh, storage access, and upload/download integrity using a small temporary file, then deletes it. No guides are uploaded by this test.'),
    el('div.row', {}, test, sync), results,
  );
  const unsubscribe = api.cloud.onStatus((next) => { if (!disposed) update(next); });
  api.cloud.status().then((next) => { if (!disposed) update(next); }).catch((err) => { status.textContent = err.message; });
  return { node, dispose() { disposed = true; unsubscribe(); if (signingIn) void api.cloud.cancel().catch(() => {}); } };
}
