'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const CaptureService = require('../../app/capture');
const { physicalRectToDip, cropGeometry } = require('../../app/coords');
const {
  WINDOW_BOUNDS_CS, parseWindowBounds, activeWindowScript, readActiveWindow,
} = require('../../app/platform/windows/window-bounds');

/**
 * Window mode on Windows (#203): the step is the full-screen frame cut down
 * to the clicked window, found from the click point, not desktopCapturer's
 * first window (an input method's always-on-top toolbar).
 */

// The three monitors of a real Windows 11 desktop, as Electron 41 reported
// them: 100% primary, a 150% monitor to its right and a 125% one to its left.
// Chromium keeps a scaled monitor's DIP origin at its physical edge.
const MONITORS = [
  { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, physical: { x: 0, y: 0, width: 3440, height: 1440 } },
  { id: 2, scaleFactor: 1.5, bounds: { x: 3440, y: 127, width: 1281, height: 721 }, physical: { x: 3440, y: 127, width: 1922, height: 1082 } },
  { id: 3, scaleFactor: 1.25, bounds: { x: -1536, y: 120, width: 1536, height: 960 }, physical: { x: -1920, y: 120, width: 1920, height: 1200 } },
];
const inRect = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** The Windows half of Electron's screen API, for MONITORS. */
function windowsScreen(cursor = { x: 0, y: 0 }) {
  return {
    getCursorScreenPoint: () => cursor,
    getAllDisplays: () => MONITORS.map(({ physical, ...display }) => display),
    screenToDipPoint(p) {
      const m = MONITORS.find((d) => inRect(p, d.physical)) || MONITORS[0];
      return { x: m.bounds.x + (p.x - m.physical.x) / m.scaleFactor, y: m.bounds.y + (p.y - m.physical.y) / m.scaleFactor };
    },
    dipToScreenRect(_window, rect) {
      return MONITORS.find((d) => d.bounds.x === rect.x && d.bounds.y === rect.y).physical;
    },
  };
}

/** A decoded frame image whose PNG names the pixels it was cut from. */
function fakeImage(width, height, from = { x: 0, y: 0 }) {
  return {
    getSize: () => ({ width, height }),
    crop: (r) => fakeImage(r.width, r.height, { x: from.x + r.x, y: from.y + r.y }),
    toPNG: () => Buffer.from(JSON.stringify({ x: from.x, y: from.y, width, height })),
  };
}

function windowsService({ settings = {}, cursor } = {}) {
  const data = {
    'capture.mode': 'window',
    'capture.clickMarker': true,
    'capture.smartCropping': false,
    'capture.clickDebounceMs': 0,
    ...settings,
  };
  const added = [];
  const events = [];
  const service = new CaptureService({
    store: {
      addStep(guideId, fields, png, size) {
        added.push({ guideId, fields, png, size });
        return { stepId: `s${added.length}`, ...fields };
      },
    },
    settings: { get: (key) => (key in data ? data[key] : null) },
    getWindow: () => null,
    notify: (name, payload) => events.push([name, payload]),
    screenApi: windowsScreen(cursor),
  });
  service._cropsWindows = true;
  service._wayland = false;
  service.imageFromPng = (png) => {
    const { width, height } = JSON.parse(png.toString());
    return fakeImage(width, height);
  };
  return { service, added, events };
}

/** A pre-click frame of one monitor from the stream backend (PNG only). */
function streamFrame(monitor, clickAt) {
  const { width, height } = monitor.physical;
  return {
    mode: 'fullscreen',
    png: Buffer.from(JSON.stringify({ width, height })),
    size: { width, height },
    display: { id: monitor.id, bounds: monitor.bounds, scaleFactor: monitor.scaleFactor },
    startedAt: clickAt - 50,
    capturedAt: clickAt - 40,
    source: 'stream',
  };
}

function liveStream(service, requests) {
  service.streamBackend = {
    isActive: () => true,
    stop() {},
    async frameForClick(options) {
      requests.push(options);
      const monitor = MONITORS.find((m) => options.clickPos && inRect(options.clickPos, m.bounds)) || MONITORS[0];
      return streamFrame(monitor, options.clickAt);
    },
  };
}

const pngRect = (png) => JSON.parse(png.toString());
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual} != ${expected}`);
const notices = (events) => events.filter(([name, p]) => name === 'capture:diagnostic' && p.kind === 'window-not-found');

// ---- parsing and geometry ------------------------------------------------------

test('window areas from the Windows helpers parse, and "-" or junk means no window', () => {
  assert.deepEqual(parseWindowBounds('17 18 1737 1431 16784'), { left: 17, top: 18, right: 1737, bottom: 1431, pid: 16784 });
  assert.deepEqual(parseWindowBounds('-1920 120 0 1320 13040'), { left: -1920, top: 120, right: 0, bottom: 1320, pid: 13040 });
  assert.equal(parseWindowBounds('-'), null);
  assert.equal(parseWindowBounds('10 10 10 50 1'), null, 'no width');
  assert.equal(parseWindowBounds('1 2 3'), null);
  assert.equal(parseWindowBounds(''), null);
});

test('a window on a 150% monitor converts to DIP around the click', () => {
  // Click at physical (4000, 500) = DIP (3813.33, 375.67); the window fills
  // the monitor's top-left quarter, physical 3440,127 to 4400,667.
  const dip = physicalRectToDip({ left: 3440, top: 127, right: 4400, bottom: 667 },
    { x: 4000, y: 500 }, { x: 3440 + 560 / 1.5, y: 127 + 373 / 1.5 }, 1.5);
  near(dip.x, 3440, 'x'); near(dip.y, 127, 'y'); near(dip.width, 640, 'width'); near(dip.height, 360, 'height');
  assert.equal(physicalRectToDip({ left: 5, top: 5, right: 5, bottom: 9 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 1), null);
});

test('a window that runs off its monitor is cut at the monitor edge', () => {
  const geometry = cropGeometry({ x: 0, y: 0, width: 3440, height: 1440 }, { x: 3000, y: -20, width: 1000, height: 500 }, { width: 3440, height: 1440 });
  assert.deepEqual(geometry.bounds, { x: 3000, y: 0, width: 440, height: 480 });
  assert.deepEqual(geometry.pixels, { x: 3000, y: 0, width: 440, height: 480 });
  assert.throws(() => cropGeometry({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 0, width: 50, height: 50 }, { width: 100, height: 100 }));
});

// ---- the click hook ------------------------------------------------------------

test('each WIN line goes with the CLICK after it, and only that one', () => {
  const { service } = windowsService();
  const calls = [];
  service.onOsClick = (...args) => calls.push(args);
  service.processClickWatcherData([
    'CTX VGl0bGU= YXBw 1700000000000',
    'WIN 100 200 900 800 4242',
    'CLICK 150 250 left 1700000000000',
    'CLICK 160 260 left 1700000000500',
    'WIN -',
    'CLICK 10 10 right 1700000001000',
  ].join('\n'), 'win32');
  assert.deepEqual(calls.map((c) => c[3]), [
    { left: 100, top: 200, right: 900, bottom: 800, pid: 4242 },
    undefined,
    null,
  ]);
});

test('a click on a 150% monitor stores the clicked window, with the marker on the click', async () => {
  const { service, added, events } = windowsService();
  const requests = [];
  liveStream(service, requests);
  service.session = { guideId: 'g', paused: false, count: 0, intervalSec: 0 };
  service.onOsClick(Date.now(), { x: 4000, y: 500 }, 'left', { left: 3440, top: 127, right: 4400, bottom: 667, pid: 4242 });
  await service.clickQueue;

  assert.equal(requests.length, 1);
  near(requests[0].clickPos.x, 3813.33, 'stream asked for the clicked monitor');
  assert.equal(added.length, 1);
  const step = added[0];
  assert.deepEqual(pngRect(step.png), { x: 0, y: 0, width: 960, height: 540 }, 'the window’s pixels on that monitor');
  assert.equal(step.fields.title, 'Window capture');
  const [marker] = step.fields.annotations;
  near(marker.x + marker.w / 2, (3813.33 - 3440) / 640, 'marker x');
  near(marker.y + marker.h / 2, (375.67 - 127) / 360, 'marker y');
  assert.equal(notices(events).length, 0);
});

test('a menu or window that reaches past the monitor is cut to the clicked monitor', async () => {
  const { service, added } = windowsService();
  liveStream(service, []);
  service.session = { guideId: 'g', paused: false, count: 0, intervalSec: 0 };
  // Physical 3000..4500 spans the primary (100%) and the 150% monitor.
  service.onOsClick(Date.now(), { x: 3200, y: 300 }, 'left', { left: 3000, top: 100, right: 4500, bottom: 900, pid: 4242 });
  await service.clickQueue;
  assert.deepEqual(pngRect(added[0].png), { x: 3000, y: 100, width: 440, height: 800 });
});

test('a click with no window to show (desktop, taskbar) keeps the full screen and says so once', async () => {
  const { service, added, events } = windowsService();
  liveStream(service, []);
  service.session = { guideId: 'g', paused: false, count: 0, intervalSec: 0 };
  service.onOsClick(Date.now(), { x: 100, y: 1430 }, 'left', null);
  service.onOsClick(Date.now() + 1000, { x: 200, y: 1430 }, 'left', null);
  await service.clickQueue;
  assert.equal(added.length, 2);
  assert.deepEqual(pngRect(added[0].png), { width: 3440, height: 1440 });
  assert.equal(added[0].fields.title, 'Screen capture', 'labelled with what was captured');
  assert.equal(notices(events).length, 1, 'one notice per recording, not per click');
});

test('StepForge’s own window is never the window to show', async () => {
  const { service, added, events } = windowsService();
  liveStream(service, []);
  service.session = { guideId: 'g', paused: false, count: 0, intervalSec: 0 };
  service.onOsClick(Date.now(), { x: 500, y: 500 }, 'left', { left: 0, top: 0, right: 1000, bottom: 800, pid: process.pid });
  await service.clickQueue;
  assert.deepEqual(pngRect(added[0].png), { width: 3440, height: 1440 });
  assert.equal(notices(events).length, 1);
});

test('Window recordings on Windows pair clicks with full-screen stream frames', () => {
  const { service } = windowsService();
  assert.equal(service.recorderMode(), 'fullscreen');
  service._cropsWindows = false;
  assert.equal(service.recorderMode(), 'window', 'X11 still grabs the window itself');
  const region = windowsService({ settings: { 'capture.mode': 'region' } }).service;
  assert.equal(region.recorderMode(), 'fullscreen');
});

test('a frame-loop frame is cut from its decoded image, which stays available for OCR', () => {
  const { service } = windowsService();
  const frame = {
    mode: 'fullscreen', image: fakeImage(3440, 1440), size: { width: 3440, height: 1440 },
    display: { id: 1, bounds: MONITORS[0].bounds }, capturedAt: Date.now(),
  };
  const cut = service.windowFrame(frame, { x: 100, y: 50, width: 800, height: 600 });
  assert.equal(cut.mode, 'window');
  assert.equal(cut.png, null);
  assert.deepEqual(cut.size, { width: 800, height: 600 });
  assert.deepEqual(cut.captureBounds, { x: 100, y: 50, width: 800, height: 600 });
  assert.deepEqual(cut.display.bounds, cut.captureBounds);
  assert.deepEqual(pngRect(cut.image.toPNG()), { x: 100, y: 50, width: 800, height: 600 });
});

// ---- captures without a click --------------------------------------------------

test('the capture hotkey in a Window recording stores the active window from its monitor', async () => {
  const { service, added } = windowsService();
  const requests = [];
  liveStream(service, requests);
  service.session = { guideId: 'g', paused: false, count: 0, intervalSec: 0 };
  service.readActiveWindow = async () => ({ left: -1920, top: 120, right: -960, bottom: 720, pid: 4242 });
  const result = await service.sessionCapture('hotkey');
  assert.equal(result.ok, true);
  assert.ok(inRect(requests[0].clickPos, MONITORS[2].bounds), 'the frame comes from the 125% monitor');
  assert.deepEqual(pngRect(added[0].png), { x: 0, y: 0, width: 960, height: 600 });
  assert.equal(added[0].fields.title, 'Window capture');
});

test('Capture window outside a recording grabs the active window’s monitor, with no click marker', async () => {
  const { service, added } = windowsService({ cursor: { x: 3700, y: 300 } });
  service.readActiveWindow = async () => ({ left: 3440, top: 127, right: 4400, bottom: 667, pid: 4242 });
  const grabs = [];
  service.captureCurrentFrame = async (mode, point) => {
    grabs.push({ mode, point });
    const monitor = MONITORS[1];
    return {
      mode, image: fakeImage(monitor.physical.width, monitor.physical.height), size: { width: 1922, height: 1082 },
      display: { id: 2, bounds: monitor.bounds }, cursor: point, capturedAt: Date.now(),
    };
  };
  const result = await service.shoot({ guideId: 'g', mode: 'window', delayMs: 0, hideWindow: false });
  assert.equal(result.ok, true);
  assert.equal(grabs[0].mode, 'fullscreen');
  assert.deepEqual(grabs[0].point, { x: 3700, y: 300 }, 'the cursor is on the window, so its monitor is grabbed');
  assert.deepEqual(pngRect(added[0].png), { x: 0, y: 0, width: 960, height: 540 });
  assert.deepEqual(added[0].fields.annotations, [], 'nothing was clicked, so the mouse isn’t circled');
});

test('a Window retake on Windows returns the active window cut from the screen', async () => {
  const { service } = windowsService();
  service.readActiveWindow = async () => ({ left: 100, top: 100, right: 1100, bottom: 900, pid: 4242 });
  service.captureCurrentFrame = async (mode) => ({
    mode, image: fakeImage(3440, 1440), size: { width: 3440, height: 1440 },
    display: { id: 1, bounds: MONITORS[0].bounds }, capturedAt: Date.now(),
  });
  const result = await service.retakeFrame({ mode: 'window', delayMs: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(pngRect(result.png), { x: 100, y: 100, width: 1000, height: 800 });
});

test('when the active window can’t be read, the shot keeps the full screen', async () => {
  const { service, added, events } = windowsService();
  service.readActiveWindow = async () => { throw new Error('PowerShell failed'); };
  service.captureCurrentFrame = async (mode) => ({
    mode, image: fakeImage(3440, 1440), size: { width: 3440, height: 1440 },
    display: { id: 1, bounds: MONITORS[0].bounds }, capturedAt: Date.now(),
  });
  const result = await service.shoot({ guideId: 'g', mode: 'window', delayMs: 0, hideWindow: false });
  assert.equal(result.ok, true);
  assert.equal(added[0].fields.title, 'Screen capture');
  assert.equal(notices(events).length, 1);
});

// ---- the PowerShell side -------------------------------------------------------

/** The click hook script exactly as startClickWatcher builds it. */
function hookScript(captureTypedText = 'false') {
  const source = fs.readFileSync(path.join(__dirname, '../../app/capture.js'), 'utf8');
  const start = source.indexOf('const ps = `') + 'const ps = `'.length;
  const template = source.slice(start, source.indexOf('`;\n', start));
  // eslint-disable-next-line no-new-func
  return new Function('captureTypedText', 'WINDOW_BOUNDS_CS', `return \`${template}\`;`)(captureTypedText, WINDOW_BOUNDS_CS);
}

test('the click hook reports the clicked window and still fits on a Windows command line', () => {
  const script = hookScript('true');
  assert.match(script, /public static class SFWindows/);
  assert.match(script, /queue\.Enqueue\("WIN " \+ area\)/);
  assert.match(script, /SFWindows\.ForClick\(data\.pt\.x, data\.pt\.y, out clicked\)/);
  // Node quotes the argument and escapes each double quote and backslash.
  const args = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const length = args.reduce((n, a) => n + a.length + 3 + (a.match(/["\\]/g) || []).length, 0);
  assert.ok(length < 32767, `the command line is ${length} characters; Windows allows 32,767`);
});

// On Windows this runs with Windows PowerShell 5.1, like the app. Elsewhere
// set STEPFORGE_WINPS (for example to powershell.exe under WSL) to run it.
const windowsPowerShell = process.env.STEPFORGE_WINPS || (process.platform === 'win32' ? 'powershell.exe' : '');
const run = (script) => new Promise((resolve, reject) => {
  execFile(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 120000, windowsHide: true },
    (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
});
const AREA = /^(-|-?\d+ -?\d+ -?\d+ -?\d+ \d+)$/;

test('the click hook compiles in Windows PowerShell and its window finder answers', { skip: !windowsPowerShell && 'needs Windows PowerShell' }, async () => {
  const script = hookScript().replace('[SFHook]::Run()', [
    '$w = [IntPtr]::Zero',
    '"CLICK " + [SFWindows]::ForClick(10, 10, [ref]$w)',
    '"ACTIVE " + [SFWindows]::Active()',
  ].join('\n'));
  const lines = (await run(script)).trim().split(/\r?\n/);
  assert.match(lines.find((l) => l.startsWith('CLICK ')).slice(6), AREA);
  assert.match(lines.find((l) => l.startsWith('ACTIVE ')).slice(7), AREA);
});

test('the active window can be read on its own, as Capture window and Retake do', { skip: !windowsPowerShell && 'needs Windows PowerShell' }, async () => {
  assert.match((await run(activeWindowScript())).trim(), AREA);
  if (process.platform === 'win32') {
    const found = await readActiveWindow();
    assert.ok(found === null || (found.right > found.left && found.bottom > found.top), JSON.stringify(found));
  }
});
