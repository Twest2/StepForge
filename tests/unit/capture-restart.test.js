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
    else if (payload.action === 'pause') capture.togglePause(true);
    return capture.state();
  };
  let reminders = 0;
  let reminderAnswer = { dontShowAgain: false };
  const settingsSet = [];
  const context = vm.createContext({
    ...rendererI18n(),
    window: {
      stepforge: { capture: { session: invoke }, settings: { set: async (change) => { settingsSet.push({ ...change }); return { capture: { recordingReminder: change.value } }; } } },
      StepForgeDialogs: { showRecordingReminder: async () => { reminders += 1; return reminderAnswer; } },
    },
    document: { addEventListener() {} },
    toast: (message) => toasts.push(message),
    el: (selector, attrs = {}, ...children) => ({ selector, ...attrs, children }),
    clearNode: (node) => { node.children = []; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInContext(source.replace('\nboot();', '\n'), context);
  const ui = Object.create(context.window.StepForgeApp.prototype);
  ui.state = { view: 'editor', settings: {} };
  ui.editor = { guideId: 'existing-guide', dirty: true };
  ui.captureStatus = { children: [], classList: { add() {}, remove() {}, toggle() {} }, append(...children) { this.children.push(...children); } };
  const button = () => ui.captureStatus.children.find((node) => node.selector === 'button');
  return { ui, capture, win, calls, toasts, button, settingsSet, reminders: () => reminders, answerReminder: (answer) => { reminderAnswer = answer; } };
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

test('the recording pill offers Start, Stop or Resume recording and does that', async (t) => {
  const f = setup();
  t.after(() => f.capture.finishSession());
  await f.ui.armCaptureSession('existing-guide');
  assert.equal(f.button().children[0], 'Start recording', 'an armed session has not started yet');
  await f.button().onClick();
  assert.equal(f.reminders(), 1, 'the first start shows the reminder');
  assert.equal(f.ui.captureState.paused, false);
  assert.equal(f.button().children[0], 'Stop recording');
  f.capture.session.count = 2; // two clicks recorded
  await f.button().onClick();
  assert.equal(f.ui.captureState.paused, true);
  assert.equal(f.button().children[0], 'Resume recording');
  await f.button().onClick();
  assert.equal(f.ui.captureState.paused, false);
  assert.equal(f.reminders(), 1, 'resuming does not show the reminder again');
});

test('Start recording does not resume a paused session that belongs to another guide', async (t) => {
  const f = setup();
  t.after(() => f.capture.finishSession());
  await f.ui.armCaptureSession('other-guide');
  f.capture.session.count = 3; // guide A already recorded; guide B is now open (ui.editor.guideId)
  f.capture.togglePause(true);
  f.ui.updateCaptureState(f.capture.state());
  await f.ui.startRecording();
  assert.equal(f.ui.captureState.guideId, 'existing-guide');
  assert.equal(f.ui.captureState.paused, false);
});

test('Cancel in the reminder leaves the session paused; Don’t show this again is saved and skips it next time', async (t) => {
  const f = setup();
  t.after(() => f.capture.finishSession());
  await f.ui.armCaptureSession('existing-guide');
  f.answerReminder(false);
  await f.ui.startRecording();
  assert.equal(f.ui.captureState.paused, true);
  assert.deepEqual(f.settingsSet, []);

  f.answerReminder({ dontShowAgain: true });
  await f.ui.startRecording();
  assert.equal(f.ui.captureState.paused, false);
  assert.deepEqual(f.settingsSet, [{ keyPath: 'capture.recordingReminder', value: false }]);

  f.capture.togglePause(true);
  f.ui.updateCaptureState(f.capture.state());
  await f.ui.startRecording();
  assert.equal(f.reminders(), 2, 'the turned-off reminder is not shown again');
  assert.equal(f.ui.captureState.paused, false);
});

test('the red control remains available in the editor across recording states', () => {
  const f = setup();
  const classes = new Set(['hidden']);
  f.ui.captureStatus.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c) };
  const status = () => f.ui.captureStatus.children[0].children.join('');

  f.ui.updateCaptureState({ active: false });
  assert.ok(!classes.has('hidden'));
  assert.equal(status(), 'Recording - stopped');
  assert.equal(f.button().children[0], 'Start recording');
  f.ui.updateCaptureState({ active: true, paused: true, count: 0 });
  assert.ok(!classes.has('hidden'));
  assert.equal(status(), 'Recording - ready');
  f.ui.updateCaptureState({ active: true, paused: false, count: 0, clickCapture: true });
  assert.ok(!classes.has('hidden'));
  assert.equal(status(), 'Recording - on click');
  f.ui.updateCaptureState({ active: true, paused: true, count: 3 });
  assert.ok(!classes.has('hidden'));
  assert.equal(status(), 'Recording - paused');
  f.ui.updateCaptureState({ active: true, paused: false, count: 0, gnomeRequired: true, warmingUp: true });
  assert.equal(status(), 'Recording - waiting for screen sharing');
  f.ui.state.view = 'library';
  f.ui.updateCaptureState({ active: false });
  assert.ok(classes.has('hidden'));
});

test('the blue Capture button opens the screenshot menu without starting a recording', () => {
  const f = setup();
  let menuEvent = null;
  f.ui.editor.openCaptureMenu = (event) => { menuEvent = event; };
  f.ui.topbarContext = { children: [], append(...children) { this.children.push(...children); } };
  f.ui.renderTopbar();
  const blue = f.ui.topbarContext.children.filter((node) => node.selector === 'button.primary');
  assert.equal(blue.length, 1);
  assert.equal(blue[0].children[0], 'Capture ▾');
  const event = {};
  blue[0].onClick(event);
  assert.equal(menuEvent, event);
  assert.deepEqual(f.calls, []);
});
