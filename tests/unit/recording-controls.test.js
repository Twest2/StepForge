'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Settings, DEFAULT_SETTINGS } = require('../../core/settings');
const { RecordingControls, recordingControlsMode, barBounds } = require('../../app/recording-controls');
const { supportsCaptureExclusion, verifyCaptureExclusion } = require('../../app/windows-capture-exclusion');
const { APP_PAGES, navigationAllowed, permissionAllowed } = require('../../app/security');
const CaptureService = require('../../app/capture');
const { makeTmpDir, rmrf } = require('./helpers');

test('recording controls default and normalize missing, invalid and legacy capture settings', (t) => {
  const dir = makeTmpDir('recording-settings');
  t.after(() => rmrf(dir));
  assert.equal(DEFAULT_SETTINGS.capture.recordingControls, 'floating');
  for (const value of [undefined, null, '', 'unknown', false, 123, {}, 'floating', 'tray']) {
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ capture: { recordingControls: value } }));
    assert.equal(new Settings(dir).get('capture.recordingControls'), value === 'tray' ? 'tray' : 'floating');
  }
  for (const capture of [null, false, [], 'bad']) {
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ capture }));
    assert.equal(new Settings(dir).get('capture.recordingControls'), 'floating');
  }
  const settings = new Settings(dir);
  settings.set('capture.recordingControls', 'tray');
  settings.set('capture.recordingBarPosition', { x: -100, y: 35 });
  assert.equal(new Settings(dir).get('capture.recordingControls'), 'tray');
  assert.deepEqual(new Settings(dir).get('capture.recordingBarPosition'), { x: -100, y: 35 });
  settings.set('capture.recordingBarPosition', { x: 'no', y: 35 });
  assert.equal(new Settings(dir).get('capture.recordingBarPosition'), null);
});

test('only Windows selects the floating bar; Linux always uses the existing tray', () => {
  for (const value of [undefined, 'floating', 'invalid']) assert.equal(recordingControlsMode('win32', value), 'floating');
  assert.equal(recordingControlsMode('win32', 'tray'), 'tray');
  for (const value of [undefined, 'floating', 'tray']) assert.equal(recordingControlsMode('linux', value), 'tray');
});

test('old Windows black-box protection is rejected', () => {
  for (const release of ['6.3.9600', '10.0.18363', 'bad', '']) assert.equal(supportsCaptureExclusion('win32', release), false);
  for (const release of ['10.0.19041', '10.0.26100']) assert.equal(supportsCaptureExclusion('win32', release), true);
  assert.equal(supportsCaptureExclusion('linux', '10.0.26100'), false);
});

test('native verification fails closed on a black box, denied API or timeout', async () => {
  const win = { getNativeWindowHandle: () => Buffer.from('3412000000000000', 'hex') };
  for (const [error, stdout, expected] of [[null, 'excluded\r\n', true], [null, 'unavailable', false], [new Error('timeout'), '', false]]) {
    assert.equal(await verifyCaptureExclusion(win, (exe, args, options, done) => {
      assert.equal(exe, 'powershell.exe');
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5000);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /affinity -eq 17/);
      assert.match(script, /\[long\]4660/);
      done(error, stdout);
    }), expected);
  }
});

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const secondary = { workArea: { x: -1707, y: 0, width: 1707, height: 920 }, scaleFactor: 1.5 };

test('bar positions use DIP, recover disconnected monitors and keep the entire bar reachable', () => {
  assert.deepEqual(barBounds({ x: -1500, y: 30 }, [primary, secondary], primary), { x: -1500, y: 30, width: 460, height: 48 });
  for (const pos of [null, { x: -1500, y: 30 }, { x: 1900, y: 10 }, { x: NaN, y: 0 }]) {
    assert.deepEqual(barBounds(pos, [primary], primary), { x: 730, y: 12, width: 460, height: 48 });
  }
});

function fixture(overrides = {}) {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.opacity = options.opacity; this.bounds = options; this.visible = false; this.dead = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, state) => { this.lastState = state; };
      windows.push(this);
    }
    isDestroyed() { return this.dead; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setContentProtection(on) { this.protected = on; }
    setIgnoreMouseEvents(on) { this.clickThrough = on; }
    setOpacity(opacity) { this.opacity = opacity; }
    setAlwaysOnTop(on, level) { this.level = level; }
    async loadFile() {}
    showInactive() { this.visible = true; this.shows = (this.shows || 0) + 1; }
    hide() { this.visible = false; }
    destroy() { this.dead = true; this.visible = false; this.emit('closed'); }
  }
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [primary, secondary], getPrimaryDisplay: () => primary });
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const ipcMain = new EventEmitter();
  const saved = {};
  const events = [];
  const controls = new RecordingControls({
    settings: { get: (key) => saved[key], set: (key, value) => { saved[key] = value; } },
    getState: () => ({ active: true, paused: false, count: 5 }),
    onPause: () => events.push('pause'), onFinish: () => events.push('finish'), onGesture: () => events.push('gesture'),
    onUnavailable: () => events.push('tray'), log: (message) => events.push(message),
    electron: { BrowserWindow: Window, screen, nativeTheme, ipcMain, app: { getPreferredSystemLanguages: () => ['en-US'] } },
    platform: 'win32', release: '10.0.26100', verify: async () => true,
    ...overrides,
  });
  return { controls, windows, screen, nativeTheme, ipcMain, saved, events };
}

test('bar stays hidden until native exclusion succeeds, uses no focus, and cleans up listeners', async () => {
  let confirm;
  const f = fixture({ verify: () => new Promise((resolve) => { confirm = resolve; }) });
  const started = f.controls.start();
  await Promise.resolve();
  const win = f.windows[0];
  assert.equal(win.opacity, 0);
  assert.equal(win.clickThrough, true);
  assert.equal(win.protected, true);
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.level, 'screen-saver');
  confirm(true);
  await started;
  assert.equal(win.visible, true);
  assert.equal(win.opacity, 1);
  assert.equal(win.clickThrough, false);
  assert.equal(win.lastState.count, 5);
  f.nativeTheme.shouldUseDarkColors = true;
  f.nativeTheme.emit('updated');
  assert.equal(win.lastState.dark, true);
  win.bounds = { x: -1500, y: 30, width: 460, height: 48 };
  f.controls.savePosition();
  assert.deepEqual(f.saved['capture.recordingBarPosition'], { x: -1500, y: 30 });
  f.screen.getAllDisplays = () => [primary];
  f.screen.emit('display-removed');
  assert.equal(win.bounds.x, 730);
  f.controls.destroy();
  for (const emitter of [f.screen, f.nativeTheme, f.ipcMain]) assert.deepEqual(emitter.eventNames(), []);
  assert.equal(win.dead, true);
  assert.deepEqual(f.events, []);
});

test('unavailable capture exclusion and renderer failure fall back to tray without exposing the bar', async () => {
  for (const overrides of [{ release: '10.0.18363' }, { verify: async () => false }, { verify: async () => { throw new Error('denied'); } }]) {
    const f = fixture(overrides);
    await f.controls.start();
    assert.equal(f.events.at(-1), 'tray');
    assert.match(f.events[0], /using tray icon:/);
    assert.ok(f.windows.every((win) => win.opacity === 0 && win.dead));
  }
  const f = fixture();
  await f.controls.start();
  f.windows[0].webContents.emit('render-process-gone');
  assert.equal(f.events.at(-1), 'tray');
  assert.equal(f.windows[0].dead, true);
});

test('finishing while exclusion is being checked never resurrects the window or tray', async () => {
  let confirm;
  const f = fixture({ verify: () => new Promise((resolve) => { confirm = resolve; }) });
  const started = f.controls.start();
  await Promise.resolve();
  f.controls.destroy();
  confirm(false);
  await started;
  assert.equal(f.windows[0].opacity, 0);
  assert.deepEqual(f.events, []);
});

test('region picker suspension stays hidden through updates and nested suspensions', async () => {
  const f = fixture();
  await f.controls.start();
  const resume = f.controls.suspend();
  const nested = f.controls.suspend();
  f.controls.update();
  assert.equal(f.windows[0].visible, false);
  resume(); resume();
  assert.equal(f.windows[0].visible, false);
  nested();
  assert.equal(f.windows[0].visible, true);
  f.controls.destroy();
});

test('bar IPC accepts only its own top frame and only the session actions', async () => {
  const f = fixture();
  await f.controls.start();
  const sender = f.windows[0].webContents;
  const senderFrame = { url: APP_PAGES.recordingControls, parent: null };
  for (const event of [{ sender: {}, senderFrame }, { sender, senderFrame: { ...senderFrame, parent: {} } }, { sender, senderFrame: { url: APP_PAGES.main } }]) {
    f.ipcMain.emit('recording-controls:action', event, 'finish');
  }
  f.ipcMain.emit('recording-controls:action', { sender, senderFrame }, 'evil');
  assert.deepEqual(f.events, []);
  f.ipcMain.emit('recording-controls:action', { sender, senderFrame }, 'pause');
  f.ipcMain.emit('recording-controls:action', { sender, senderFrame }, 'finish');
  assert.deepEqual(f.events, ['gesture', 'pause', 'gesture', 'finish']);
  assert.equal(navigationAllowed(APP_PAGES.main, 'recordingControls'), false);
  assert.equal(permissionAllowed('media', APP_PAGES.recordingControls), false);
  f.controls.destroy();
});

test('a bar click never queues a step even when the live cursor already moved away', async () => {
  const f = fixture();
  await f.controls.start();
  const svc = new CaptureService({ store: {}, settings: { get: () => null }, getWindow: () => null,
    notify: () => {}, screenApi: { getCursorScreenPoint: () => ({ x: 50, y: 700 }), getAllDisplays: () => [primary] } });
  svc.session = { guideId: 'guide-1', paused: false, count: 0 };
  svc.recordingControls = f.controls;
  svc.osPointToDip = (point) => ({ x: point.x / 1.5, y: point.y / 1.5 });
  let queued = 0;
  svc.enqueueClickCapture = () => { queued += 1; };
  svc.onOsClick(Date.now(), { x: 1200, y: 45 }, 'left');
  assert.equal(queued, 0);
  svc.onOsClick(Date.now() + 300, { x: 75, y: 1050 }, 'left');
  assert.equal(queued, 1);
  svc.screen.getCursorScreenPoint = () => ({ x: 800, y: 30 });
  assert.equal(svc.userIsInApp(), true);
  f.controls.destroy();
});

test('pause hotkey and added steps refresh the bar; explicit Finish brings the editor forward', () => {
  let updates = 0;
  let shown = 0;
  let focused = 0;
  const svc = new CaptureService({ store: {}, settings: { get: () => null }, notify: () => {},
    getWindow: () => ({ isDestroyed: () => false, isMinimized: () => false, show: () => { shown += 1; }, focus: () => { focused += 1; } }) });
  svc.session = { guideId: 'guide-1', paused: false, count: 0 };
  svc.recordingControls = { update: () => { updates += 1; }, destroy: () => {} };
  svc.togglePause(true);
  svc.noteStepAdded({}, 'manual');
  assert.equal(updates, 2);
  assert.equal(svc.session.count, 1);
  svc.hiddenForSession = false;
  svc.finishSession({ bringToFront: true });
  assert.equal(shown, 1);
  assert.equal(focused, 1);
  assert.equal(svc.recordingControls, null);
});

test('region picker restores controls after selection, cancellation and an overlay error', async () => {
  const svc = new CaptureService({ store: {}, settings: { get: () => null }, getWindow: () => null, notify: () => {} });
  for (const result of [{ x: 0, y: 0, width: 100, height: 100 }, null, new Error('overlay failed')]) {
    let suspended = false;
    svc.recordingControls = { suspend: () => { suspended = true; return () => { suspended = false; }; } };
    svc.pickRegionOverlay = async () => {
      assert.equal(suspended, true);
      if (result instanceof Error) throw result;
      return result;
    };
    if (result instanceof Error) await assert.rejects(svc.pickRegion({}, {}), /overlay failed/);
    else assert.equal(await svc.pickRegion({}, {}), result);
    assert.equal(suspended, false);
  }
});

function captureWithControls(platform = 'win32', mode = 'floating') {
  const f = fixture();
  const electron = f.controls.electron;
  const captureFile = path.join(__dirname, '../../app/capture.js');
  const localRequire = require('node:module').createRequire(captureFile);
  const module = { exports: {} };
  class Controls extends RecordingControls {
    constructor(options) { super({ ...options, electron, platform, release: '10.0.26100', verify: async () => true }); }
  }
  require('node:vm').runInNewContext(fs.readFileSync(captureFile, 'utf8'), {
    module, __dirname: path.dirname(captureFile), Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, platform, env: { ...process.env, STEPFORGE_SCREENSHOT: '' } },
    require: (name) => name === './recording-controls'
      ? { RecordingControls: Controls, recordingControlsMode }
      : name === 'electron' ? electron : localRequire(name),
  });
  const win = {
    visible: true, minimized: false, focused: false, focusCalls: 0,
    isDestroyed: () => false, isMinimized() { return this.minimized; },
    isVisible() { return this.visible; }, hide() { this.visible = false; },
    minimize() { this.visible = false; this.minimized = true; },
    restore() { this.minimized = false; this.visible = true; },
    show() { this.visible = true; }, showInactive() { this.visible = true; },
    focus() { this.focused = true; this.focusCalls += 1; },
  };
  const values = { 'capture.recordingControls': mode, 'capture.captureOutsideClicks': false, 'capture.streamCapture': false, 'capture.postHideSettleMs': 0 };
  const svc = new module.exports({ store: {}, settings: { get: (key) => values[key], set() {} },
    getWindow: () => win, notify: () => {}, screenApi: electron.screen });
  return { ...f, svc, win };
}

test('opening or switching guides does not open the floating bar; starting shows it and pausing keeps it available', async (t) => {
  const f = captureWithControls();
  t.after(() => f.svc.finishSession());
  for (const guideId of ['from-library', 'from-recent', 'from-linked-guide']) {
    f.svc.startSession(guideId, { intervalSec: 0 });
    assert.equal(f.svc.state().paused, true);
    assert.equal(f.svc.recordingControls.started, false);
    assert.equal(f.windows.length, 0, 'preparing any guide must not create a native bar');
  }
  f.svc.togglePause(true);
  assert.equal(f.windows.length, 0, 'a pause before the first start must not expose controls');
  f.svc.togglePause(false);
  await new Promise(setImmediate);
  assert.equal(f.windows.length, 1);
  const bar = f.windows[0];
  assert.equal(bar.visible, true);
  assert.equal(bar.lastState.paused, false);
  assert.equal(f.win.visible, false, 'starting still hides the editor');
  f.svc.togglePause(true);
  assert.equal(f.svc.state().count, 0);
  assert.equal(bar.visible, true, 'paused controls must remain available even before the first step');
  assert.equal(bar.lastState.paused, true);
  f.svc.togglePause(false);
  await new Promise(setImmediate);
  assert.equal(f.windows.length, 1, 'resume reuses the same bar');
  f.svc.finishSession();
  assert.equal(bar.dead, true);
  assert.equal(f.win.visible, true);
  f.svc.startSession('reopened-after-finish', { intervalSec: 0 });
  assert.equal(f.windows.length, 1, 'reopening must not create another bar until Start recording');
  assert.equal(f.svc.recordingControls.started, false);
  f.svc.togglePause(false);
  await new Promise(setImmediate);
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[1].visible, true);
});

test('the deferred floating controller can be finished without ever opening a window', async () => {
  const f = captureWithControls();
  f.svc.startSession('opened-only', { intervalSec: 0 });
  const pending = f.svc.recordingControls;
  f.svc.finishSession();
  await pending.start();
  assert.equal(f.windows.length, 0, 'a disposed controller cannot resurrect a bar');
});

test('Linux and Windows tray mode keep their existing controls on session preparation', (t) => {
  for (const [platform, mode] of [['linux', 'floating'], ['linux', 'tray'], ['win32', 'tray']]) {
    const f = captureWithControls(platform, mode);
    t.after(() => f.svc.finishSession());
    let trayStarts = 0;
    f.svc.createSessionTray = () => { trayStarts += 1; };
    f.svc.startSession('tray-guide', { intervalSec: 0 });
    assert.equal(trayStarts, 1);
    assert.equal(f.svc.recordingControls, null);
    f.svc.togglePause(false);
    assert.equal(trayStarts, 1);
    assert.equal(f.windows.length, 0);
  }
});


test('the floating Finish action restores focus on every recording cycle, including minimized and already-visible editors', async (t) => {
  const f = captureWithControls();
  t.after(() => f.svc.finishSession());
  const action = (bar, name) => f.ipcMain.emit('recording-controls:action', {
    sender: bar.webContents, senderFrame: { url: APP_PAGES.recordingControls, parent: null },
  }, name);
  for (let cycle = 0; cycle < 4; cycle += 1) {
    f.svc.startSession('edited-guide', { intervalSec: 0 });
    assert.equal(f.svc.recordingControls.started, false, 'opening the guide stays quiet');
    f.svc.togglePause(false);
    await new Promise(setImmediate);
    const bar = f.windows.at(-1);
    f.win.focused = false;
    const beforeFinish = f.win.focusCalls;
    action(bar, 'pause');
    assert.equal(f.svc.session.paused, true);
    assert.equal(f.win.focusCalls, beforeFinish, 'Pause must not focus the editor');
    action(bar, 'pause');
    await new Promise(setImmediate);
    assert.equal(f.svc.session.paused, false);
    assert.equal(f.win.focusCalls, beforeFinish, 'Resume must not focus the editor');
    if (cycle === 1) f.win.minimize();
    if (cycle === 2) f.win.showInactive();
    if (cycle === 3) f.svc.hiddenForSession = false;
    action(bar, 'finish');
    assert.equal(f.win.visible, true, 'Finish must show the editor');
    assert.equal(f.win.minimized, false, 'Finish must restore a minimized editor');
    assert.equal(f.win.focused, true, 'Finish must bring StepForge to the foreground every time');
    assert.equal(f.win.focusCalls, beforeFinish + 1);
    assert.equal(f.svc.session, null);
    assert.equal(f.svc.recordingControls, null);
    assert.equal(bar.dead, true);
  }
});
