'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Settings, DEFAULT_SETTINGS } = require('../../core/settings');
const { PLASMA_HOTKEYS } = require('../../app/platform/linux/desktop');
const { makeTmpDir, rmrf } = require('./helpers');

test('Plasma letter-key defaults avoid shifted-digit portal triggers and preserve saved choices', (t) => {
  const root = makeTmpDir('plasma-settings');
  t.after(() => rmrf(root));
  const fresh = new Settings(path.join(root, 'plasma'), { defaultOverrides: { capture: PLASMA_HOTKEYS } });
  assert.equal(fresh.get('capture.hotkeyCapture'), 'CommandOrControl+Alt+C');
  assert.equal(fresh.get('capture.hotkeyPauseResume'), 'CommandOrControl+Alt+P');
  assert.equal(fresh.get('capture.clickMarker'), true);
  assert.equal(new Settings(path.join(root, 'other')).get('capture.hotkeyCapture'), DEFAULT_SETTINGS.capture.hotkeyCapture);
  fresh.set('capture.hotkeyCapture', 'Control+Alt+9');
  fresh.set('capture.hotkeyPauseResume', '');
  const reloaded = new Settings(path.join(root, 'plasma'), { defaultOverrides: { capture: PLASMA_HOTKEYS } });
  assert.equal(reloaded.get('capture.hotkeyCapture'), 'Control+Alt+9');
  assert.equal(reloaded.get('capture.hotkeyPauseResume'), '');
  assert.equal(DEFAULT_SETTINGS.capture.hotkeyCapture, 'CommandOrControl+Shift+1');
});

test('on Plasma, the general shortcuts an older StepForge saved count as the default', (t) => {
  const root = makeTmpDir('plasma-upgrade');
  t.after(() => rmrf(root));
  const dir = path.join(root, 'settings');
  // Every save writes all values, so an existing install has the general defaults on disk.
  const old = new Settings(dir);
  old.set('capture.clickMarker', false);
  assert.equal(JSON.parse(fs.readFileSync(old.file, 'utf8')).capture.hotkeyCapture, 'CommandOrControl+Shift+1');
  const plasma = new Settings(dir, { defaultOverrides: { capture: PLASMA_HOTKEYS } });
  assert.equal(plasma.get('capture.hotkeyCapture'), 'CommandOrControl+Alt+C');
  assert.equal(plasma.get('capture.hotkeyPauseResume'), 'CommandOrControl+Alt+P');
  assert.equal(plasma.get('capture.clickMarker'), false, 'other saved choices are kept');
  // Other desktops still read them as saved.
  assert.equal(new Settings(dir).get('capture.hotkeyCapture'), 'CommandOrControl+Shift+1');
});
