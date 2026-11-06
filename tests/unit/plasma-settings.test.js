'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
