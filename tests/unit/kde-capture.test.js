'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { captureServiceClass } = require('../../app/platform/capture-service');
const Base = require('../../app/capture');
const Gnome = require('../../app/platform/linux/gnome-capture');
const Kde = require('../../app/platform/linux/kde-capture');
const { PortalBackend } = require('../../app/platform/linux/portal-backend');
const { detectLinuxDesktop } = require('../../app/platform/linux/desktop');
const { detectLinuxCapabilities, chooseCaptureTrigger } = require('../../app/platform/linux/diagnostics');

const PLASMA = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' };

// ---- desktop selection --------------------------------------------------------

test('Plasma 6 Wayland on Fedora KDE and Kubuntu selects the Plasma capture service', () => {
  assert.equal(captureServiceClass('linux', PLASMA), Kde);
  assert.equal(captureServiceClass('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' }), Kde);
  // GNOME, X11, Plasma 5 and Windows keep their existing services.
  assert.equal(captureServiceClass('linux', { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), Gnome);
  assert.equal(captureServiceClass('linux', { ...PLASMA, XDG_SESSION_TYPE: 'x11' }), Base);
  assert.equal(captureServiceClass('linux', { ...PLASMA, KDE_SESSION_VERSION: '5' }), Base);
  assert.equal(captureServiceClass('win32', PLASMA), Base);
  assert.equal(detectLinuxDesktop({ XDG_CURRENT_DESKTOP: 'KDE-like' }), 'other');
});

test('Plasma diagnostics promise clicks with markers, and say when mouse buttons are unreadable', () => {
  const probe = (readable) => detectLinuxCapabilities({
    env: { ...PLASMA, WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:x' },
    hasBinary: (name) => name === 'pipewire',
    existsSync: () => true,
    readdirSync: () => (readable ? ['event0'] : []),
  });
  const caps = probe(false);
  assert.equal(caps.plasmaRequired, true);
  assert.equal(caps.gnomeRequired, false);
  assert.equal(caps.clickCapture, 'kwin-script-required');
  assert.match(caps.messages.join(' '), /cannot read mouse buttons/);
  const trigger = chooseCaptureTrigger(caps);
  assert.equal(trigger.trigger, 'click');
  assert.equal(trigger.coordinates, true);
  assert.equal(trigger.marker, true);
});

test('the Plasma backend starts the shared helper with the KWin companion', () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (line) => calls.push(JSON.parse(line));
  child.stdin.end = () => {};
  child.kill = () => {};
  const backend = new PortalBackend({ desktop: 'plasma', spawnProcess: (cmd, args) => { calls.push({ cmd, args }); return child; } });
  backend.start({ sampleMs: 50 }).catch(() => {});
  assert.equal(calls[0].cmd, '/usr/bin/python3');
  assert.deepEqual(calls[0].args.slice(-2), ['--desktop', 'plasma']);
  assert.match(calls[0].args[1], /portal_capture\.py$/);
  assert.equal(calls[1].type, 'start');
  backend.stop({ immediate: true });
});

// ---- the KWin script, run against a fake KWin ------------------------------------

function signal() {
  const handlers = [];
  return { connect: (fn) => handlers.push(fn), disconnect: (fn) => handlers.splice(handlers.indexOf(fn), 1),
    emit: () => handlers.slice().forEach((fn) => fn()), get count() { return handlers.length; } };
}

function fakeKWin({ windows, active = null, screens = [{ name: 'DP-1', geometry: { x: 0, y: 0, width: 1920, height: 1080 } }] }) {
  let now = 1000;
  const sent = [];
  const desktop = { id: 'd1' };
  const workspace = {
    cursorPos: { x: 10, y: 10 }, currentDesktop: desktop, activeWindow: active,
    stackingOrder: windows, screens, cursorPosChanged: signal(), screensChanged: signal(),
  };
  const kwin = {
    workspace, sent, desktop,
    advance(ms) { now += ms; },
    move(x, y) { workspace.cursorPos = { x, y }; workspace.cursorPosChanged.emit(); },
    pendingPoll() { return sent.filter((m) => m.method === 'Poll' && !m.answered).pop(); },
    answer(message) { const poll = kwin.pendingPoll(); poll.answered = true; poll.callback(JSON.stringify(message)); },
    replies() { return sent.filter((m) => m.method === 'Reply').map((m) => JSON.parse(m.args[0])); },
    events() { return sent.filter((m) => m.method === 'Event').map((m) => JSON.parse(m.args[0])); },
  };
  const callDBus = (service, objectPath, iface, method, ...rest) => {
    const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
    sent.push({ service, objectPath, iface, method, args: rest, callback });
  };
  const source = fs.readFileSync(path.join(__dirname, '../../app/platform/linux/kwin/stepforge-capture.js'), 'utf8')
    .replace('@SERVICE@', ':1.42');
  vm.runInNewContext(source, { workspace, callDBus, Date: { now: () => now } });
  return kwin;
}

function win(fields) {
  return { caption: '', resourceClass: '', desktopFileName: '', pid: 4321, minimized: false, hidden: false,
    deleted: false, onAllDesktops: true, desktops: [], ...fields };
}

test('the KWin script answers with the pointer at the click time and the window under it', () => {
  const editor = win({ caption: 'notes.txt — Kate', resourceClass: 'kate', desktopFileName: 'org.kde.kate',
    normalWindow: true, frameGeometry: { x: 100, y: 50, width: 800, height: 600 } });
  const files = win({ caption: 'Home — Dolphin', resourceClass: 'dolphin', desktopFileName: 'org.kde.dolphin',
    normalWindow: true, frameGeometry: { x: 0, y: 0, width: 1920, height: 1080 } });
  const hiddenOnTop = win({ caption: 'Minimized', minimized: true, frameGeometry: { x: 0, y: 0, width: 1920, height: 1080 } });
  const kwin = fakeKWin({ windows: [files, editor, hiddenOnTop], active: files });
  const hello = kwin.events()[0];
  assert.equal(hello.type, 'hello');
  assert.equal(hello.protocol, 1);
  assert.deepEqual(hello.screens, [{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 }]);
  assert.equal(kwin.sent[0].service, ':1.42');

  kwin.advance(10); kwin.move(300, 200); // 1010: over the editor
  const clickAt = 1020;
  kwin.advance(20); kwin.move(1500, 900); // 1030: moved away after the click
  kwin.answer({ requests: [{ id: 7, at: clickAt }] });
  const [reply] = kwin.replies();
  const [result] = reply.results;
  assert.equal(result.id, 7);
  assert.deepEqual(result.pointer, { x: 300, y: 200 }, 'position when the button went down');
  assert.deepEqual(result.window, { x: 100, y: 50, width: 800, height: 600 });
  assert.equal(result.windowTitle, 'notes.txt — Kate');
  assert.equal(result.appId, 'org.kde.kate');
  assert.equal(result.windowPid, 4321);
  assert.ok(kwin.pendingPoll(), 'the script polls again after answering');

  // No click time (Capture window, the hotkey): the active window.
  kwin.answer({ requests: [{ id: 8 }] });
  const noClick = kwin.replies()[1].results[0];
  assert.equal(noClick.windowTitle, 'Home — Dolphin');
  assert.deepEqual(noClick.pointer, { x: 1500, y: 900 });
});

test('menus stand for their window, panels and the desktop keep the whole screen', () => {
  const app = win({ caption: 'Document — LibreOffice', resourceClass: 'libreoffice', normalWindow: true,
    frameGeometry: { x: 100, y: 100, width: 600, height: 400 } });
  const menu = win({ popupMenu: true, resourceClass: 'libreoffice', transientFor: app,
    frameGeometry: { x: 650, y: 150, width: 200, height: 300 } });
  const panel = win({ dock: true, resourceClass: 'plasmashell', caption: 'Plasma',
    frameGeometry: { x: 0, y: 1040, width: 1920, height: 40 } });
  const wallpaper = win({ desktopWindow: true, resourceClass: 'plasmashell', frameGeometry: { x: 0, y: 0, width: 1920, height: 1080 } });
  const kwin = fakeKWin({ windows: [wallpaper, app, menu, panel], active: app });
  kwin.answer({ requests: [] }); // keepalive: nothing to answer
  assert.equal(kwin.replies().length, 0);
  const ask = (x, y) => {
    kwin.move(x, y);
    kwin.advance(5);
    kwin.answer({ requests: [{ id: 1, at: 1e12 }] });
    return kwin.replies().pop().results[0];
  };
  const onMenu = ask(700, 200);
  assert.equal(onMenu.windowTitle, 'Document — LibreOffice');
  assert.deepEqual(onMenu.window, { x: 100, y: 100, width: 750, height: 400 }, 'window and menu together');
  const onPanel = ask(20, 1060);
  assert.equal(onPanel.window, null);
  assert.equal(onPanel.hitKind, 'panel');
  assert.equal(onPanel.hitClass, 'plasmashell');
  const onDesktop = ask(1500, 600);
  assert.equal(onDesktop.window, null);
  assert.equal(onDesktop.hitKind, 'desktop');
});

test('the KWin script reports layout changes and goes quiet when told to quit or orphaned', () => {
  const kwin = fakeKWin({ windows: [] });
  kwin.workspace.screensChanged.emit();
  assert.equal(kwin.events().pop().type, 'screens');
  kwin.answer({ quit: true });
  assert.equal(kwin.pendingPoll(), undefined, 'no further polling');
  assert.equal(kwin.workspace.cursorPosChanged.count, 0);
  assert.equal(kwin.workspace.screensChanged.count, 0);

  // A helper that crashed never answers again; the script stops on its own.
  const orphan = fakeKWin({ windows: [] });
  orphan.advance(31000);
  orphan.move(5, 5);
  assert.equal(orphan.workspace.cursorPosChanged.count, 0);
});

// ---- the Plasma capture service ---------------------------------------------------

const PNG = Buffer.from('frame');

function fixture(settings = {}) {
  const saved = [];
  const events = [];
  const backend = new EventEmitter();
  Object.assign(backend, {
    start: async () => true, arm: async () => {}, stop: () => {}, isActive: () => true,
    frameForClick: async () => ({ mode: 'fullscreen', png: PNG, size: { width: 3840, height: 2160 },
      display: { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } } }),
  });
  const values = { 'capture.clickMarker': true, 'capture.clickDebounceMs': 0, ...settings };
  const service = new Kde({
    store: { addStep: (guideId, data, png, size) => { const step = { stepId: 's' + saved.length, guideId, ...data, png, size }; saved.push(step); return step; } },
    settings: { get: (key) => values[key] },
    getWindow: () => null, notify: (name, value) => events.push([name, value]), screenApi: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    backendFactory: () => backend,
  });
  // Plain Node has no nativeImage; crop records the pixel rectangle instead.
  service.imageFromPng = (png) => ({
    crop: (rect) => ({ getSize: () => ({ width: rect.width, height: rect.height }), toPNG: () => Buffer.from(JSON.stringify(rect)) }),
    getSize: () => (png.equals(PNG) ? { width: 3840, height: 2160 } : { width: 640, height: 480 }),
  });
  service.session = { guideId: 'g1', paused: false, count: 0, intervalSec: 0 };
  service.streamBackend = backend;
  return { service, saved, events };
}

const click = (fields) => ({ x: 400, y: 300, at: 5000, button: 1, windowPid: 99, hitKind: 'window', hitClass: 'kate', ...fields });

test('a Window step on Plasma is the clicked window, cut from the pre-click frame, with its marker', async () => {
  const { service, saved } = fixture({ 'capture.mode': 'window' });
  service.onGnomeClick(click({ window: { x: 200, y: 100, width: 800, height: 600 }, appName: 'Kate', windowTitle: 'notes.txt — Kate' }));
  await service.clickQueue;
  assert.equal(saved.length, 1);
  assert.deepEqual(JSON.parse(saved[0].png), { x: 400, y: 200, width: 1600, height: 1200 }, 'HiDPI pixels of the window');
  const mark = saved[0].annotations[0];
  assert.equal(mark.x + mark.w / 2, 0.25);
  assert.ok(Math.abs(mark.y + mark.h / 2 - 1 / 3) < 1e-9);
  assert.equal(service.state().plasmaRequired, true);
  assert.equal(service.state().gnomeRequired, false);
});

test('a Window-mode click with no window keeps the screen and says so once', async () => {
  const { service, saved, events } = fixture({ 'capture.mode': 'window' });
  service.onGnomeClick(click({ window: null }));
  service.onGnomeClick(click({ window: null, at: 6000, x: 900 }));
  await service.clickQueue;
  assert.equal(saved.length, 2);
  assert.ok(saved.every((step) => step.size.width === 3840), 'full screen');
  assert.equal(events.filter(([, value]) => value && value.kind === 'window-not-found').length, 1);
});

test('the panel click that opens the tray menu and the one that stops recording are not steps', async () => {
  const { service, saved } = fixture();
  service.onGnomeClick(click({ x: 10, y: 10, at: 1000 }));
  service.onGnomeClick(click({ x: 1880, y: 1060, at: 2000, hitKind: 'panel', hitClass: 'plasmashell' }));
  service.onGnomeClick(click({ x: 1700, y: 900, at: 2600, hitKind: 'popup', hitClass: 'plasmashell' }));
  service.noteUiStopGesture(); // Finish session in StepForge's tray menu
  service.session.paused = true;
  await service.clickQueue;
  assert.deepEqual(saved.map((step) => step.annotations.length), [1]);
  assert.equal(saved.length, 1, 'only the workflow click');
});

test('a panel click is a step once the user clicks elsewhere or after the hold', async (t) => {
  const { service, saved } = fixture();
  service.onGnomeClick(click({ x: 20, y: 1060, at: 1000, hitKind: 'panel', hitClass: 'plasmashell' }));
  service.onGnomeClick(click({ x: 500, y: 500, at: 3000 }));
  await service.clickQueue;
  assert.equal(saved.length, 2, 'launcher click kept when the next click lands in an app');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  service.onGnomeClick(click({ x: 40, y: 1060, at: 9000, hitKind: 'panel', hitClass: 'plasmashell' }));
  t.mock.timers.tick(Kde.PANEL_CLICK_HOLD_MS);
  await service.clickQueue;
  assert.equal(saved.length, 3);
});

test('clicks on StepForge itself, during warmup or while paused are not stored', async () => {
  const { service, saved } = fixture();
  service.onGnomeClick(click({ windowPid: process.pid }));
  service.warmingUp = true;
  service.onGnomeClick(click({ at: 7000 }));
  service.warmingUp = false;
  service.session.paused = true;
  service.onGnomeClick(click({ at: 9000 }));
  await service.clickQueue;
  assert.equal(saved.length, 0);
});

test('Capture region uses Spectacle and stores the selected area', async () => {
  const { service, saved } = fixture();
  service.session = null;
  service.runSpectacle = async (file) => { fs.writeFileSync(file, Buffer.from('region')); };
  const result = await service.regionCapture('g1');
  assert.equal(result.ok, true);
  assert.equal(saved[0].png.toString(), 'region');
  assert.deepEqual(saved[0].size, { width: 640, height: 480 });

  service.runSpectacle = async () => {}; // Esc in Spectacle: no file
  assert.deepEqual(await service.regionCapture('g1'), { ok: false, reason: 'selection cancelled' });
  service.runSpectacle = async () => { throw new Error('Install Spectacle to select a region on KDE Plasma.'); };
  assert.match((await service.regionCapture('g1')).reason, /Install Spectacle/);
});
