'use strict';

const { execFile } = require('node:child_process');

/*
 * A second home for the Google sign-in, bound to the operating-system user
 * rather than to this installation. Electron's safeStorage key lives in the
 * app profile (Windows) or is looked up once at launch (Linux keyring), so a
 * reinstall, update or early launch can leave the primary file unreadable.
 * Secrets travel over stdin, never command-line arguments.
 */

const SERVICE = 'stepforge-google-drive';
const ENTROPY = 'StepForge Google Drive';
// Each cloud service has its own slot. Google keeps the original names so
// existing backups are still found.
const LABELS = { google: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', webdav: 'Nextcloud' };

function run(file, args, input, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
    // A missing tool fails in the callback; ignore the resulting stdin EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// GNOME Keyring / KWallet through the Secret Service CLI (libsecret-tools).
function secretServiceVault(slot) {
  const service = slot === 'google' ? SERVICE : `stepforge-${slot}`;
  const attrs = (clientId) => ['service', service, 'client', clientId];
  return {
    async read(clientId) {
      const out = await run('secret-tool', ['lookup', ...attrs(clientId)], '');
      return out.trim() || null;
    },
    async write(clientId, secret) {
      await run('secret-tool', ['store', `--label=StepForge ${LABELS[slot] || slot} sign-in`, ...attrs(clientId)], secret);
    },
    async clear(clientId) {
      await run('secret-tool', ['clear', ...attrs(clientId)], '').catch(() => {});
    },
  };
}

// DPAPI with the CurrentUser scope, kept in the per-user registry. Only this
// Windows account can decrypt it, and uninstallers leave it in place.
function dpapiVault(slot) {
  const key = slot === 'google' ? "'HKCU:\\Software\\StepForge\\GoogleDrive'" : `'HKCU:\\Software\\StepForge\\Cloud-${slot}'`;
  const entropy = `[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`;
  const powershell = (lines, input = '') => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    ['$ErrorActionPreference = "Stop"', 'Add-Type -AssemblyName System.Security', ...lines].join('; ')], input);
  return {
    async read() {
      const out = await powershell([
        `$v = (Get-ItemProperty -Path ${key} -Name SignIn -ErrorAction SilentlyContinue).SignIn`,
        `if ($v) { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v), ${entropy}, 'CurrentUser')) }`,
      ]);
      return out.trim() ? Buffer.from(out.trim(), 'base64').toString('utf8') : null;
    },
    async write(clientId, secret) {
      await powershell([
        '$d = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
        `$p = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($d, ${entropy}, 'CurrentUser'))`,
        `if (-not (Test-Path ${key})) { New-Item -Path ${key} -Force | Out-Null }`,
        `Set-ItemProperty -Path ${key} -Name SignIn -Value $p`,
      ], Buffer.from(secret, 'utf8').toString('base64'));
    },
    async clear() {
      await powershell([`Remove-ItemProperty -Path ${key} -Name SignIn -ErrorAction SilentlyContinue`]).catch(() => {});
    },
  };
}

function createCredentialVault({ platform = process.platform, slot = 'google' } = {}) {
  if (!/^[a-z]+$/.test(slot)) throw new Error('Invalid credential slot.');
  if (platform === 'linux') return secretServiceVault(slot);
  if (platform === 'win32') return dpapiVault(slot);
  return null;
}

module.exports = { createCredentialVault };
