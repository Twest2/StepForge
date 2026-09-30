'use strict';

const crypto = require('node:crypto');

/*
 * The Electron side of Confluence (app/confluence.js): a browser session of
 * its own, so Confluence cookies and smart-card choices never mix with the
 * rest of StepForge; hidden and visible windows in it; and choosing which
 * certificate to present when a site asks for one.
 */

// Extended key usages meant for signing in: TLS client auth, smart card logon.
const SIGN_IN_USAGES = ['1.3.6.1.5.5.7.3.2', '1.3.6.1.4.1.311.20.2.2'];

function hostOf(url) {
  try { return new URL(String(url).includes('://') ? url : `https://${url}`).host; } catch { return String(url); }
}

/** Certificates meant for signing in; a smart card also holds email and encryption ones. */
function signInCertificates(list) {
  const suitable = list.filter((cert) => {
    try {
      const usage = new crypto.X509Certificate(cert.data).keyUsage;
      return !usage || usage.some((oid) => SIGN_IN_USAGES.includes(oid));
    } catch { return true; }
  });
  return suitable.length ? suitable : list;
}

/**
 * `remembered`/`remember` keep the chosen certificate per site;
 * `ask(host, certificates)` resolves with the index the user picked, or -1.
 */
function createConfluenceSession({ session, BrowserWindow, getParent = () => null, remembered = () => null, remember = () => {}, ask }) {
  const ses = session.fromPartition('persist:confluence');
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  // It never gets StepForge's preload or IPC.
  const makeWindow = (show) => {
    const win = new BrowserWindow({
      show, width: 1000, height: 760, title: 'Sign in to Confluence', autoHideMenuBar: true,
      parent: show ? getParent() || undefined : undefined,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Sign-in pages sometimes open a pop-up; keep it in this window instead.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    return win;
  };

  // Chromium only presents a client certificate for a page, so a hidden page
  // makes the handshake. Allow time for the smart card's PIN prompt.
  const openHiddenPage = (url, { timeout = 180000 } = {}) => new Promise((resolve) => {
    const win = makeWindow(false);
    const done = () => { clearTimeout(timer); if (!win.isDestroyed()) win.destroy(); resolve(); };
    const timer = setTimeout(done, timeout);
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', done);
    void win.loadURL(url).catch(() => {});
  });

  // The site's own sign-in page. Closes once `signedIn()` says so; resolves
  // false if the user closes it first.
  const openLoginWindow = (url, { signedIn }) => new Promise((resolve) => {
    const win = makeWindow(true);
    let finished = false;
    let checking = false;
    const poll = setInterval(async () => {
      if (checking || finished) return;
      checking = true;
      try { if (await signedIn()) { finished = true; if (!win.isDestroyed()) win.close(); } } finally { checking = false; }
    }, 2000);
    win.on('closed', () => { clearInterval(poll); resolve(finished); });
    void win.loadURL(url).catch(() => {});
  });

  const chooseCertificate = async (url, list) => {
    const host = hostOf(url);
    const saved = list.find((cert) => cert.fingerprint === remembered(host));
    if (saved) return saved;
    const candidates = signInCertificates(list);
    let chosen = candidates[0] || null;
    if (candidates.length > 1) {
      const index = await ask(host, candidates);
      if (index < 0) return null;
      chosen = candidates[index];
    }
    if (chosen) remember(host, chosen.fingerprint);
    return chosen;
  };

  /** For app.on('select-client-certificate'): handles only this session's requests. */
  const onSelectCertificate = (event, webContents, url, list, callback) => {
    if (webContents?.session !== ses) return;
    event.preventDefault();
    chooseCertificate(url, list).then((cert) => (cert ? callback(cert) : callback()), () => callback());
  };

  return { session: ses, fetch: (url, init) => ses.fetch(url, init), openHiddenPage, openLoginWindow, chooseCertificate, onSelectCertificate };
}

module.exports = { createConfluenceSession, signInCertificates, hostOf };
