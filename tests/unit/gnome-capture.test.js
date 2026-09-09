'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { captureServiceClass } = require('../../app/platform/capture-service');
const Base = require('../../app/capture');
const Gnome = require('../../app/platform/linux/gnome-capture');
const { PortalBackend } = require('../../app/platform/linux/portal-backend');

test('Windows selects exactly the existing capture class regardless of Linux environment hints', () => {
  assert.equal(captureServiceClass('win32', { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }), Base);
  assert.equal(captureServiceClass('linux', { XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' }), Base);
  assert.equal(captureServiceClass('linux', { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), Gnome);
});

test('Shell button transitions produce one step per press, including simultaneous and held buttons', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../gnome-extension/stepforge@twestbrook.com/buttons.js'), 'utf8');
  const { Buttons } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const buttons = new Buttons();
  assert.deepEqual(buttons.update(256), [1]);
  assert.deepEqual(buttons.update(256), []);
  assert.deepEqual(buttons.update(256 | 512 | 1024), [2, 3]);
  assert.deepEqual(buttons.update(0), []);
  assert.deepEqual(buttons.update(256), [1]);
  assert.deepEqual(new Buttons(256).update(256), [], 'held button at arm is not a click');
  assert.deepEqual(new Buttons().update(0xff), [], 'keyboard modifiers are not clicks');
});

test('fractional-scale secondary-monitor crop preserves logical origin and pixel alignment', () => {
  const crop = Gnome.cropGeometry({ x: -1600, y: 200, width: 1600, height: 900 },
    { x: -1500, y: 300, width: 800, height: 500 }, { width: 2400, height: 1350 });
  assert.deepEqual(crop.bounds, { x: -1500, y: 300, width: 800, height: 500 });
  assert.deepEqual(crop.pixels, { x: 150, y: 150, width: 1200, height: 750 });
});

function fixture(options = {}) {
  const events = [];
  const saved = [];
  const backend = new EventEmitter();
  Object.assign(backend, {
    start: async () => true, arm: async () => {}, stop: () => {}, isActive: () => true,
    frameForClick: async () => ({ mode: 'fullscreen', png: Buffer.from('frame'), size: { width: 2400, height: 1350 },
      display: { id: 2, bounds: { x: -1600, y: 0, width: 1600, height: 900 } } }),
  });
  const service = new Gnome({
    store: { addStep: (guideId, data, png) => { const step = { stepId: 's' + saved.length, guideId, ...data, png }; saved.push(step); return step; } },
    settings: { get: (key) => ({ 'capture.clickMarker': true, 'capture.clickDebounceMs': 0 })[key] },
    getWindow: () => null, notify: (name, value) => events.push([name, value]),
    screenApi: {}, backendFactory: () => backend, ensureCompanion: async () => {}, ...options,
  });
  service.session = { guideId: 'first', paused: false, count: 0, intervalSec: 0 };
  service.streamBackend = backend;
  return { service, saved, backend, events };
}

test('GNOME clicks save correctly positioned markers and drain into the original guide', async () => {
  const { service, saved } = fixture();
  const firstSession = service.session;
  for (let i = 0; i < 8; i++) service.onGnomeClick({ x: -800, y: 450, at: 1000 + i * 50, button: 1 });
  service.session = { guideId: 'second', paused: true, count: 0 };
  await service.clickQueue;
  assert.equal(saved.length, 8);
  assert.ok(saved.every(step => step.guideId === 'first'));
  assert.equal(service.session.count, 0);
  assert.equal(firstSession.guideId, 'first');
  const mark = saved[0].annotations[0];
  assert.equal(mark.x + mark.w / 2, 0.5);
  assert.equal(mark.y + mark.h / 2, 0.5);
});

test('no clicks are stored during warmup, pause, or from StepForge itself', async () => {
  const { service, saved } = fixture();
  const click = { x: 20, y: 30, at: 1000, button: 1 };
  service.warmingUp = true;
  service.onGnomeClick(click);
  service.warmingUp = false;
  service.session.paused = true;
  service.onGnomeClick(click);
  service.session.paused = false;
  service.onGnomeClick({ ...click, windowPid: process.pid });
  await service.clickQueue;
  assert.equal(saved.length, 0);
});

test('missing extension blocks recording and reports actionable error instead of falling back', async () => {
  const { service } = fixture({ ensureCompanion: async () => { throw new Error('Enable StepForge Capture'); } });
  service.armRecording();
  await service.starting;
  assert.equal(service.session.paused, true);
  assert.equal(service.state().captureError, 'Enable StepForge Capture');
  assert.equal(service.state().intervalSec, 0);
});

test('an unshared monitor produces an explicit error, no wrong-monitor screenshot', async () => {
  const { service, backend, saved } = fixture();
  backend.frameForClick = async () => { throw new Error('This monitor was not shared.'); };
  service.onGnomeClick({ x: -800, y: 450, at: 1000, button: 1 });
  await service.clickQueue;
  assert.equal(saved.length, 0);
  assert.match(service.state().captureError, /not shared/);
});

test('a late frame rejection after an intentional stop does not leave a capture warning', async () => {
  const { service, backend } = fixture();
  let rejectFrame;
  backend.frameForClick = () => new Promise((_, reject) => { rejectFrame = reject; });
  service.onGnomeClick({ x: 20, y: 30, at: 1000, button: 1 });
  service.session.paused = true; // mirrors the explicit Stop recording action
  rejectFrame(new Error('GNOME capture stopped.'));
  await service.clickQueue;
  assert.equal(service.state().captureError, '');
});

test('backend keeps selected frames alive while draining and converts monotonic time', async () => {
  const backend = new PortalBackend();
  backend.active = true;
  backend.offset = 10000;
  const messages = [];
  backend.send = (message) => messages.push(message);
  let destroyed = false;
  backend.destroy = () => { destroyed = true; };
  const pending = backend.frameForClick({ clickPos: { x: -10, y: 20 }, clickAt: 12000 });
  assert.equal(messages[0].at, 2000);
  backend.stop();
  assert.equal(destroyed, false);
  backend.receive({ type: 'frame', id: messages[0].id, png: Buffer.from('png').toString('base64'),
    width: 10, height: 20, at: 1980, display: { id: 2 } });
  const frame = await pending;
  assert.equal(frame.capturedAt, 11980);
  assert.equal(frame.png.toString(), 'png');
  assert.equal(destroyed, true);
});
