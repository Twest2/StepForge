'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CaptureService = require('../../app/capture');
const GnomeCaptureService = require('../../app/platform/linux/gnome-capture');

/**
 * Window mode on a Wayland desktop without GNOME records the full screen.
 * The user must see that before and during a recording, not only in a log.
 */

function service(Class, { mode = 'window', wayland = true } = {}) {
  const s = new Class({
    store: {},
    settings: { get: (key) => (key === 'capture.mode' ? mode : null) },
    getWindow: () => null,
    notify: () => {},
    screenApi: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getAllDisplays: () => [] },
  });
  s._wayland = wayland;
  s.session = { guideId: 'g1', paused: true, count: 0, intervalSec: 0 };
  return s;
}

test('the recording state says up front when Window mode will record the full screen', () => {
  assert.match(service(CaptureService).state().modeNote, /records the full screen/);
  assert.equal(service(CaptureService, { wayland: false }).state().modeNote, '', 'X11 and Windows grab the window');
  assert.equal(service(CaptureService, { mode: 'fullscreen' }).state().modeNote, '');
  assert.equal(service(GnomeCaptureService).state().modeNote, '', 'GNOME crops the window itself');
});

test('the window-mode-unavailable notice reaches the renderer through preload', () => {
  let exposed;
  const listeners = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/preload.js'), 'utf8'), {
    Promise,
    require: () => ({
      contextBridge: { exposeInMainWorld(name, api) { exposed = api; } },
      ipcRenderer: { invoke: async () => null, on: (channel, fn) => { listeners[channel] = fn; } },
    }),
  });
  const received = [];
  exposed.capture.onDiagnostic((payload) => received.push(payload));
  assert.equal(typeof listeners['capture:diagnostic'], 'function', 'something listens on the channel');
  listeners['capture:diagnostic']({}, { kind: 'window-mode-unavailable', reason: 'full screen' });
  assert.deepEqual(received, [{ kind: 'window-mode-unavailable', reason: 'full screen' }]);
});

function app() {
  const toasts = [];
  // Like the DOM's append(): anything that isn't a node becomes text, so a stray null shows as "null".
  const node = () => ({ children: [], classList: { add() {}, remove() {} }, append(...kids) { this.children.push(...kids.map((k) => (k && typeof k === 'object' ? k : String(k)))); } });
  const context = vm.createContext({ window: {}, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/util.js'), 'utf8'), context);
  context.toast = (message, opts) => toasts.push([message, opts]);
  context.el = (selector, attrs = {}, ...children) => ({ selector, ...attrs, children: children.flat().filter((c) => c != null && c !== false) });
  context.clearNode = (n) => { n.children = []; };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInContext(source.replace('\nboot();', '\n'), context);
  const instance = Object.create(context.window.StepForgeApp.prototype);
  instance.state = { view: 'editor' };
  instance.captureStatus = node();
  return { app: instance, toasts };
}

test('the recording bar shows the full-screen note before recording starts, and the notice is a toast', () => {
  const { app: ui, toasts } = app();
  const note = 'Window capture is not available on this desktop, so StepForge records the full screen.';
  ui.updateCaptureState({ active: true, paused: true, count: 0, modeNote: note });
  const shown = ui.captureStatus.children.find((c) => c.selector === 'span.capture-mode-note');
  assert.ok(shown, 'the note is in the recording bar');
  assert.equal(shown.title, note);
  ui.updateCaptureState({ active: true, paused: true, count: 0, modeNote: '' });
  assert.equal(ui.captureStatus.children.some((c) => c.selector === 'span.capture-mode-note'), false);
  assert.equal(ui.captureStatus.children.some((c) => typeof c !== 'object'), false, 'no stray "null" text beside the button');

  ui.onCaptureDiagnostic({ kind: 'window-mode-unavailable', reason: note });
  ui.onCaptureDiagnostic({ kind: 'strict-click-skipped', reason: 'not shown' });
  assert.deepEqual(toasts.map(([message]) => message), [note]);
});
