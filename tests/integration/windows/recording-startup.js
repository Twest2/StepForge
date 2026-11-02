'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, screen, session } = require('electron');
const CaptureService = require('../../../app/capture');

// Only the hidden capture worker opens; this check never shows test windows.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (process.platform !== 'win32') { console.log('SKIP Windows-only startup check'); app.exit(); return; }
  const results = [];
  const output = path.resolve(__dirname, '../../.tmp/recording-startup');
  fs.mkdirSync(output, { recursive: true });
  const deadline = setTimeout(() => { console.error('FAIL recorder startup check timed out'); app.exit(1); }, 30000);
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  const settings = {
    'capture.mode': 'fullscreen', 'capture.streamCapture': true,
    'capture.frameSampleMs': 50, 'capture.clickLeadMs': 0,
  };
  const capture = new CaptureService({ store: {}, settings: { get: (key) => settings[key] }, getWindow: () => null, notify: () => {} });
  try {
    for (let run = 1; run <= 4; run += 1) {
      capture.session = { guideId: 'startup-check', paused: false, count: 0 };
      const start = performance.now();
      await capture.startClickFrameBackend();
      const readyMs = Math.round(performance.now() - start);
      assert.ok(capture.streamBackend?.isActive(), 'the real capture stream must be ready');
      // armRecording keeps input disarmed for the normal post-hide settle.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const display = screen.getPrimaryDisplay();
      const point = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
      const clickAt = Date.now();
      const frame = await capture.frameForClick(point, clickAt);
      assert.ok(frame?.png?.length > 0, 'the first click must have a real buffered frame');
      assert.ok(frame.startedAt <= clickAt, 'the first frame must precede the click');
      assert.ok(frame.size.width > 1 && frame.size.height > 1, 'stream frames must retain full screenshot dimensions');
      results.push({ run, readyMs, firstFrameAgeMs: clickAt - frame.startedAt, size: frame.size });
      console.log(`PASS run ${run}: ready in ${readyMs} ms; first strict pre-click frame available`);
      capture.stopClickFrameBackend();
      capture.session = null;
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    capture.stopClickFrameBackend();
    app.exit(process.exitCode || 0);
  }
});
