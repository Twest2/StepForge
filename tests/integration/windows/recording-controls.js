'use strict';
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, screen, desktopCapturer } = electron;
const repo = path.resolve(__dirname, '../../..');
const out = path.join(repo, 'tests/.tmp/recording-controls');
fs.mkdirSync(out, { recursive: true });
const log = (message) => { console.log(message); fs.appendFileSync(path.join(out, 'results.log'), message + '\n'); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Run with Electron on Windows: npx electron tests/integration/windows/recording-controls.js
app.whenReady().then(async () => {
  if (process.platform !== 'win32') { log('SKIP Windows-only integration check'); app.quit(); return; }
  const deadline = setTimeout(() => { log('FAIL integration check timed out'); app.exit(1); }, 30000);
  const { RecordingControls } = require(path.join(repo, 'app/recording-controls'));
  let state = { active: true, paused: false, count: 5 };
  const controls = new RecordingControls({
    electron, settings: { get: () => null, set: () => {} }, getState: () => state,
    onPause: () => {}, onFinish: () => {}, onGesture: () => {},
    onUnavailable: () => log('FALLBACK'), log,
  });
  try {
    log('Windows ' + require('node:os').release() + '; Electron ' + process.versions.electron);
    await controls.start();
    if (!controls.ready) throw new Error('bar failed exclusion verification');
    log('PASS native WDA_EXCLUDEFROMCAPTURE verified before reveal');
    await wait(600);
    fs.writeFileSync(path.join(out, 'recording.png'), (await controls.win.webContents.capturePage()).toPNG());
    state = { ...state, paused: true };
    controls.update();
    await wait(150);
    fs.writeFileSync(path.join(out, 'paused.png'), (await controls.win.webContents.capturePage()).toPNG());
    const b = controls.win.getBounds();
    log('BOUNDS ' + JSON.stringify(b));
    const backdrop = new BrowserWindow({ x: b.x - 10, y: b.y - 5, width: b.width + 20, height: 150,
      frame: false, show: false, focusable: false, skipTaskbar: true, backgroundColor: '#444444' });
    await backdrop.loadURL('data:text/html,<html><body style="margin:0;background:%23444444"></body></html>');
    backdrop.showInactive();
    controls.win.setAlwaysOnTop(true, 'screen-saver');
    await wait(500);
    const d = screen.getDisplayMatching(b);
    const take = async (name) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) } });
      const img = sources.find((s) => String(s.display_id) === String(d.id)).thumbnail;
      const size = img.getSize();
      const sx = size.width / d.bounds.width, sy = size.height / d.bounds.height;
      const crop = img.crop({ x: Math.round((b.x - d.bounds.x) * sx), y: Math.round((b.y - d.bounds.y) * sy), width: Math.round(b.width * sx), height: Math.round(b.height * sy) });
      fs.writeFileSync(path.join(out, name + '.png'), crop.toPNG());
      return crop.toBitmap();
    };
    const visible = await take('protected-desktop');
    controls.win.hide();
    await wait(300);
    const hidden = await take('hidden-desktop');
    let changed = 0;
    for (let i = 0; i < hidden.length; i += 4) {
      if (Math.abs(visible[i] - hidden[i]) + Math.abs(visible[i+1] - hidden[i+1]) + Math.abs(visible[i+2] - hidden[i+2]) > 20) changed++;
    }
    log('Desktop capture changed pixels visible vs hidden: ' + changed + '/' + hidden.length / 4);
    if (changed > 5) throw new Error('protected window changed desktop capture pixels');
    log('PASS desktopCapturer exclusion (visible and hidden captures match)');
    controls.update();
    await wait(400);
    const CaptureService = require(path.join(repo, 'app/capture'));
    const point = { x: b.x + 20, y: b.y + 20 };
    const values = { 'capture.streamCapture': true, 'capture.mode': 'fullscreen', 'capture.clickDebounceMs': 0 };
    let lastFrame;
    const svc = new CaptureService({
      settings: { get: (key) => values[key] }, getWindow: () => null, notify: () => {},
      store: { addStep: (_id, _meta, png) => { lastFrame = { png }; return { stepId: 'test' }; } },
      screenApi: { getCursorScreenPoint: () => point, getDisplayNearestPoint: () => d, getAllDisplays: () => [d] },
    });
    const validate = (frame, label) => {
      if (!frame) throw new Error(label + ': no frame');
      const image = frame.image || electron.nativeImage.createFromBuffer(frame.png);
      const size = image.getSize();
      const sx = size.width / d.bounds.width, sy = size.height / d.bounds.height;
      const crop = image.crop({ x: Math.round((b.x - d.bounds.x) * sx), y: Math.round((b.y - d.bounds.y) * sy), width: Math.round(b.width * sx), height: Math.round(b.height * sy) });
      const bytes = crop.toBitmap();
      if (bytes.length !== hidden.length) throw new Error(label + ': reference dimensions differ');
      let changed = 0;
      for (let i = 0; i < bytes.length; i += 4) if (Math.abs(bytes[i] - hidden[i]) + Math.abs(bytes[i+1] - hidden[i+1]) + Math.abs(bytes[i+2] - hidden[i+2]) > 30) changed++;
      if (changed > 5) throw new Error(label + ': ' + changed + ' pixels differ from hidden-bar reference');
      log('PASS ' + label + ' excludes the bar (' + changed + ' changed pixels)');
    };
    svc.session = { guideId: 'test', paused: false, count: 0 };
    electron.session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture'].includes(permission));
    electron.session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
    await svc.startClickFrameBackend();
    if (!svc.streamBackend?.isActive()) throw new Error('stream backend unavailable');
    await wait(600);
    validate(await svc.frameForClick(point, Date.now()), 'stream backend');
    svc.stopClickFrameBackend();
    svc.startFrameLoop();
    await wait(800);
    validate(svc.latestFrame, 'in-process frame loop');
    svc.stopFrameLoop();
    const manual = await svc.sessionCapture('manual');
    if (!manual.ok) throw new Error('manual failed: ' + manual.reason);
    validate(lastFrame, 'manual Capture now');
    const hotkey = await svc.hotkeyCapture();
    if (!hotkey.ok) throw new Error('hotkey failed: ' + hotkey.reason);
    validate(lastFrame, 'hotkey Capture');
    svc.recordingControls = controls;
    const originalOverlay = svc.pickRegionOverlay.bind(svc);
    let suspended = false;
    svc.pickRegionOverlay = async (display, image) => {
      suspended = !controls.win.isVisible();
      const pending = originalOverlay(display, image);
      const overlay = BrowserWindow.getAllWindows().find((w) => w !== controls.win && w !== backdrop);
      await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
      await overlay.webContents.executeJavaScript('window.regionPicker.done({ x: 0, y: 0, w: 100, h: 100 })');
      return pending;
    };
    const region = await svc.pickRegionFrame();
    if (!region.ok || !suspended || !controls.win.isVisible()) throw new Error('region picker failed to hide/restore bar');
    log('PASS region picker hides and restores bar with real overlay');
    const refused = await svc.retakeFrame({ delayMs: 0 });
    if (refused.ok) throw new Error('Retake allowed during session');
    svc.session = null;
    svc.recordingControls = null;
    controls.destroy();
    const retake = await svc.retakeFrame({ delayMs: 0 });
    if (!retake.ok) throw new Error('Retake failed: ' + retake.reason);
    validate(retake, 'Retake after session');
    backdrop.destroy();
  } catch (error) {
    log('FAIL ' + error.stack);
    controls.destroy();
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    app.exit(process.exitCode || 0);
  }
});
