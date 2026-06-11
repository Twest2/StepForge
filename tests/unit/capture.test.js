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
