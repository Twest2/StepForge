'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CaptureService = require('../../app/capture');

function makeService() {
  const store = {
    addStep() {
      throw new Error('not used in this test');
    },
  };
  const settings = {
    get(key) {
      if (key === 'capture.mode') return 'fullscreen';
      if (key === 'capture.delayMs') return 0;
      return null;
    },
  };
  return new CaptureService({
    store,
    settings,
    getWindow: () => null,
    notify: () => {},
  });
}

test('click-triggered session capture uses the low-latency hide pause', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-1', paused: false, count: 0, intervalSec: 0 };

  let seenOptions = null;
  service.shoot = async (options) => {
    seenOptions = options;
    return { ok: true, step: { stepId: 'step-1' } };
  };

  const result = await service.sessionCapture('click');

  assert.equal(result.ok, true);
  assert.equal(service.session.count, 1);
  assert.deepEqual(seenOptions, {
    guideId: 'guide-1',
    mode: 'fullscreen',
    delayMs: 0,
    hideWindowDelayMs: 25,
    refocus: false,
  });
});

test('click-triggered session capture prefers the cached frame when ready', async () => {
  const service = makeService();
  service.settings.get = (key) => {
    if (key === 'capture.mode') return 'fullscreen';
    if (key === 'capture.delayMs') return 0;
    if (key === 'capture.clickMarker') return true;
    if (key === 'capture.clickMarkerColor') return '#E5484D';
    if (key === 'editor.focusedViewDefaultForNewSteps') return false;
    return null;
  };
  service.session = { guideId: 'guide-2', paused: false, count: 0, intervalSec: 0 };
  service.captureCache = {
    mode: 'fullscreen',
    png: Buffer.from('cached-png'),
    size: { width: 120, height: 80 },
    display: { bounds: { x: 10, y: 20, width: 120, height: 80 } },
    cursor: { x: 70, y: 40 },
    capturedAt: Date.now(),
  };

  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    throw new Error('fresh shot should not run when cache is ready');
  };

  const added = [];
  service.store.addStep = (guideId, fields, png, size) => {
    added.push({ guideId, fields, png, size });
    return { stepId: 'step-2', ...fields };
  };
  service.notify = (channel, payload) => {
    added.push({ channel, payload });
  };

  const result = await service.sessionCapture('click');

  assert.equal(result.ok, true);
  assert.equal(shootCalled, false);
  assert.equal(service.session.count, 1);
  assert.equal(added[0].guideId, 'guide-2');
  assert.deepEqual(added[0].png, Buffer.from('cached-png'));
  assert.deepEqual(added[0].size, { width: 120, height: 80 });
  assert.equal(added[0].fields.annotations.length, 1);
  assert.equal(added[0].fields.annotations[0].type, 'oval');
});
