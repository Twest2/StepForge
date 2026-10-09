'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { linuxPasswordStore } = require('../../app/platform/linux/password-store');

// Chromium falls back to an unencrypted "basic_text" store on desktops it
// doesn't recognise, and StepForge then can't save any sign-in.
test('desktops Chromium does not recognise use the Secret Service keyring', () => {
  for (const desktop of ['', 'MATE', 'sway', 'Hyprland', 'i3', 'LXDE', 'niri', 'X-Cinnamon', 'GNOME', 'ubuntu:GNOME', 'XFCE', 'COSMIC']) {
    assert.equal(linuxPasswordStore({ env: { XDG_CURRENT_DESKTOP: desktop } }), 'gnome-libsecret', desktop || '(unset)');
  }
});

test('KDE keeps KWallet', () => {
  for (const env of [{ XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'kde' }, { DESKTOP_SESSION: 'plasma' }, { DESKTOP_SESSION: 'plasmawayland' }]) {
    assert.equal(linuxPasswordStore({ env }), null, JSON.stringify(env));
  }
});

test('an explicit --password-store from the user wins', () => {
  assert.equal(linuxPasswordStore({ env: { XDG_CURRENT_DESKTOP: 'sway' }, hasSwitch: true }), null);
});

test('main.js applies it on Linux before the app is ready', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'app', 'main.js'), 'utf8');
  const applied = main.indexOf("app.commandLine.appendSwitch('password-store', passwordStore)");
  assert.ok(applied > 0, 'main.js must set --password-store');
  assert.ok(applied < main.indexOf('app.whenReady()'), 'the switch only works before the app is ready');
});
