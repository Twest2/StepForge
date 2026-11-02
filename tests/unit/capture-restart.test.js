'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CaptureService = require('../../app/capture');
const { rendererI18n } = require('./helpers');

function setup({ session } = {}) {
  const calls = [];
  const toasts = [];
  const win = {
    visible: true, isDestroyed: () => false, isMinimized: () => false,
    isVisible() { return this.visible; },
    hide() { this.visible = false; }, minimize() { this.visible = false; },
    show() { this.visible = true; }, showInactive() { this.visible = true; }, focus() {},
  };
  const settings = { get: (key) => ({ 'capture.streamCapture': false, 'capture.postHideSettleMs': 0, 'capture.captureOutsideClicks': false })[key] };
  const capture = new CaptureService({ store: {}, settings, getWindow: () => win, notify: () => {} });
  capture.createSessionControls = () => {};
  capture.clickCaptureAvailable = () => true;
  const invoke = async (payload) => {
    calls.push(payload);
    if (session) return session(payload, capture);
    if (payload.action === 'start') capture.startSession(payload.guideId);
    else if (payload.action === 'resume') capture.togglePause(false);
    return capture.state();
  };
  let reminders = 0;
  const context = vm.createContext({
    ...rendererI18n(),
    window: { stepforge: { capture: { session: invoke } }, StepForgeDialogs: { showRecordingReminder: () => { reminders += 1; return true; } } },
    document: { addEventListener() {} },
    toast: (message) => toasts.push(message),
    el: (selector, attrs = {}, ...children) => ({ selector, ...attrs, children }),
    clearNode: (node) => { node.children = []; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInContext(source.replace('\nboot();', '\n'), context);
  const ui = Object.create(context.window.StepForgeApp.prototype);
  ui.state = { view: 'editor' };
  ui.editor = { guideId: 'existing-guide', dirty: true };
  ui.captureStatus = { children: [], classList: { add() {}, remove() {} }, append(...children) { this.children.push(...children); } };
  const button = () => ui.captureStatus.children.find((node) => node.selector === 'button');
  return { ui, capture, win, calls, toasts, button, reminders: () => reminders };
}

test('Finish → edit → Start recording restarts the same guide and hides the editor in one click, repeatedly', async (t) => {
  const f = setup();
  t.after(() => f.capture.finishSession());
  f.capture.startSession('existing-guide');
  f.capture.togglePause(false);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    f.capture.finishSession();
    assert.equal(f.win.visible, true, 'Finish restores the editor');
    f.ui.updateCaptureState(f.capture.state());
    assert.equal(f.button().children[0], 'Start recording');
    assert.equal(f.button().disabled, false);
    const restarted = await f.button().onClick();
    assert.equal(restarted.active, true);
    assert.equal(restarted.paused, false, 'the new session must resume without another control click');
    assert.equal(restarted.guideId, 'existing-guide');
    assert.equal(f.win.visible, false, 'the editor tucks away again');
    assert.equal(f.ui.editor.dirty, true, 'the start action does not reset editor work');
    assert.equal(f.ui.startingCaptureSession, false);
  }
  assert.deepEqual(f.calls.map((call) => call.action), ['start', 'resume', 'start', 'resume', 'start', 'resume']);
  assert.equal(f.reminders(), 0, 'restarting does not ask the user to start a second time');
});

test('opening a guide still arms a paused session without starting unexpectedly', async (t) => {
  const f = setup();
  t.after(() => f.capture.finishSession());
  const state = await f.ui.armCaptureSession('existing-guide');
  assert.equal(state.paused, true);
  assert.equal(f.win.visible, true);
  assert.deepEqual(f.calls.map((call) => call.action), ['start']);
});

test('rapid repeated starts cannot create competing sessions or leave the interim Start button enabled', async () => {
  let finishStart;
  let finishResume;
  const f = setup({ session: (payload) => payload.action === 'start'
    ? new Promise((resolve) => { finishStart = () => resolve({ active: true, paused: true, guideId: payload.guideId, count: 0 }); })
    : new Promise((resolve) => { finishResume = () => resolve({ active: true, paused: false, guideId: payload.guideId, count: 0 }); }) });
  f.ui.updateCaptureState({ active: false });
  const first = f.button().onClick();
  assert.equal(f.button().disabled, true);
  assert.equal(f.button().children[0], 'Starting…');
  await f.ui.startCaptureSession('existing-guide');
  assert.equal(f.calls.length, 1);
  finishStart();
  await new Promise(setImmediate);
  assert.equal(f.ui.captureState.paused, true);
  assert.equal(f.button().disabled, true, 'the interim paused state cannot be started again');
  assert.equal(f.button().children[0], 'Starting…');
  finishResume();
  await first;
  assert.deepEqual(f.calls.map((call) => call.action), ['start', 'resume']);
  assert.equal(f.button().disabled, false);
  assert.equal(f.ui.captureState.paused, false);
});

test('failed start or resume requests clear the busy state and leave recording controls usable', async () => {
  for (const failAction of ['start', 'resume']) {
    const f = setup({ session: (payload) => {
      if (payload.action === failAction) throw new Error(`${failAction} failed`);
      return { active: true, paused: true, guideId: payload.guideId, count: 0 };
    } });
    f.ui.updateCaptureState({ active: false });
    await f.button().onClick();
    assert.equal(f.ui.startingCaptureSession, false);
    assert.equal(f.button().disabled, false);
    assert.deepEqual(f.toasts, [`${failAction} failed`]);
    assert.equal(Boolean(f.ui.captureState.active), failAction === 'resume');
    if (failAction === 'resume') assert.equal(f.ui.captureState.paused, true);
  }
});
