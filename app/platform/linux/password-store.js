'use strict';

/*
 * Which keyring Electron's safeStorage should use on Linux. Chromium only
 * picks the Secret Service (GNOME Keyring, KeePassXC, ...) on desktops it
 * recognises; on MATE, Sway, Hyprland, i3 or with no XDG_CURRENT_DESKTOP it
 * falls back to "basic_text", and every StepForge sign-in then refuses to
 * save credentials. KDE keeps Chromium's own choice (KWallet). Returns the
 * --password-store value to set, or null to leave Chromium's default.
 */
function linuxPasswordStore({ env = process.env, hasSwitch = false } = {}) {
  if (hasSwitch) return null;
  const desktops = `${env.XDG_CURRENT_DESKTOP || ''}:${env.DESKTOP_SESSION || ''}`
    .split(':').map((name) => name.trim().toLowerCase());
  if (desktops.some((name) => name === 'kde' || name === 'plasma' || name.startsWith('plasma'))) return null;
  return 'gnome-libsecret';
}

module.exports = { linuxPasswordStore };
