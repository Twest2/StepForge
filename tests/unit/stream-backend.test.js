'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamCaptureBackend, pairDisplaysToSources } = require('../../app/stream-backend');

const display = (id, x, y, width, height, scaleFactor = 1) => ({
  id, scaleFactor, bounds: { x, y, width, height },
});

/**
 * Test host: records commands, exposes the backend's event handler so a test
 * can play the worker's part, and auto-acks start-stream commands so start()
 * resolves without a real worker window.
 */
function makeBackend({ autoReady = true, ...opts } = {}) {
  const sent = [];
  let emit = null;
  let destroyed = false;
  const backend = new StreamCaptureBackend({
    createHost: async (onEvent) => {
      emit = onEvent;
      return {
        send(msg) {
          sent.push(msg);
          if (autoReady && msg.type === 'start-stream') {
            queueMicrotask(() => emit({ type: 'stream-ready', displayId: msg.displayId }));
          }
        },
        destroy() { destroyed = true; },
      };
    },
    ackTimeoutMs: 40,
    encodeTimeoutMs: 120,
    startTimeoutMs: 100,
    ...opts,
  });
  return { backend, sent, worker: (msg) => emit(msg), isDestroyed: () => destroyed };
}

const oneDisplay = [display(7, 0, 0, 1920, 1080, 1)];
const oneSource = [{ id: 'screen:1:0', display_id: '7' }];

test('start() opens one stream per display and reports active once ready', async () => {
  const { backend, sent } = makeBackend();

  const ok = await backend.start({ displays: oneDisplay, sources: oneSource, sampleMs: 50 });

  assert.equal(ok, true);
  assert.equal(backend.isActive(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'start-stream');
  assert.equal(sent[0].sourceId, 'screen:1:0');
  assert.equal(sent[0].sampleMs, 50);
  assert.deepEqual(sent[0].display.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  backend.stop();
});

test('start() fails cleanly when every stream errors', async () => {
  const { backend, sent, worker, isDestroyed } = makeBackend({ autoReady: false });
  const startPromise = backend.start({ displays: oneDisplay, sources: oneSource });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  worker({ type: 'stream-error', displayId: 7, reason: 'no permission' });

  const ok = await startPromise;

  assert.equal(ok, false);
  assert.equal(backend.isActive(), false);
  assert.equal(isDestroyed(), true, 'a failed start must tear the worker down');
});

test('a frame request resolves with the worker frame, carrying its timestamps and display', async () => {
  const { backend, sent, worker } = makeBackend();
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const promise = backend.frameForClick({ clickPos: { x: 100, y: 100 }, clickAt: 5000, strict: true });
  const request = sent.find((m) => m.type === 'frame-request');
  assert.ok(request, 'a frame-request must be sent to the worker');
  assert.equal(request.clickAt, 5000);
  assert.equal(request.strict, true);
  assert.equal(request.displayId, 7);
  worker({
    type: 'frame-response',
    requestId: request.requestId,
    ok: true,
    png: Uint8Array.from([1, 2, 3]),
    width: 1920,
    height: 1080,
    startedAt: 4900,
    capturedAt: 4910,
  });

  const frame = await promise;

  assert.equal(frame.mode, 'fullscreen');
  assert.deepEqual([...frame.png], [1, 2, 3]);
  assert.deepEqual(frame.size, { width: 1920, height: 1080 });
  assert.equal(frame.startedAt, 4900);
  assert.equal(frame.capturedAt, 4910);
  assert.equal(frame.display.id, 7);
  assert.equal(frame.source, 'stream');
  backend.stop();
});

test('a "no qualifying frame" reply resolves null without counting as a failure', async () => {
  const { backend, sent, worker } = makeBackend();
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const promise = backend.frameForClick({ clickAt: 5000 });
  const request = sent.find((m) => m.type === 'frame-request');
  worker({ type: 'frame-response', requestId: request.requestId, ok: false, reason: 'click predates first frame' });

  assert.equal(await promise, null);
  assert.equal(backend.isActive(), true, 'an honest empty answer is healthy');
  backend.stop();
});

test('clicks on a multi-monitor setup route to the stream of the clicked display', async () => {
  const displays = [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 1920, 1080)];
  const sources = [
    { id: 'screen:1:0', display_id: '1' },
    { id: 'screen:2:0', display_id: '2' },
  ];
  const { backend, sent } = makeBackend();
  await backend.start({ displays, sources });

  backend.frameForClick({ clickPos: { x: 2500, y: 400 }, clickAt: 1 });
  backend.frameForClick({ clickPos: { x: 300, y: 400 }, clickAt: 2 });

  const requests = sent.filter((m) => m.type === 'frame-request');
  assert.deepEqual(requests.map((r) => r.displayId), [2, 1]);
  backend.stop();
});

test('repeated unanswered frame requests mark the backend unhealthy exactly once', async () => {
  let unhealthy = 0;
  const { backend, isDestroyed } = makeBackend({ onUnhealthy: () => { unhealthy += 1; } });
  await backend.start({ displays: oneDisplay, sources: oneSource });

  // Two consecutive ack timeouts (the worker never answers at all).
  assert.equal(await backend.frameForClick({ clickAt: 1 }), null);
  assert.equal(await backend.frameForClick({ clickAt: 2 }), null);

  assert.equal(unhealthy, 1, 'degradation must fire once, not per click');
  assert.equal(backend.isActive(), false);
  assert.equal(isDestroyed(), true);
});

test('a slow PNG encode after a prompt selection ack is not mistaken for a dead worker', async () => {
  // The ack window is 40ms here; the payload arrives at ~80ms — well past
  // the ack deadline but inside the encode deadline. The frame must land
  // and the failure counter must stay clean.
  let unhealthy = 0;
  const { backend, sent, worker } = makeBackend({ onUnhealthy: () => { unhealthy += 1; } });
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const promise = backend.frameForClick({ clickPos: { x: 10, y: 10 }, clickAt: 5000 });
  const request = sent.find((m) => m.type === 'frame-request');
  worker({ type: 'frame-selected', requestId: request.requestId, startedAt: 4900, capturedAt: 4910 });
  setTimeout(() => {
    worker({
      type: 'frame-response',
      requestId: request.requestId,
      ok: true,
      png: Uint8Array.from([7]),
      width: 1920,
      height: 1080,
      startedAt: 4900,
      capturedAt: 4910,
    });
  }, 80);

  const frame = await promise;

  assert.ok(frame, 'the slowly-encoded frame must still be delivered');
  assert.deepEqual([...frame.png], [7]);
  assert.equal(unhealthy, 0);
  assert.equal(backend.isActive(), true);
  backend.stop();
});

test('an acked request whose payload never arrives resolves null after the encode deadline', async () => {
  const { backend, sent, worker } = makeBackend();
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const promise = backend.frameForClick({ clickAt: 5000 });
  const request = sent.find((m) => m.type === 'frame-request');
  worker({ type: 'frame-selected', requestId: request.requestId });

  assert.equal(await promise, null, 'a stuck encode must not hang the click forever');
  backend.stop();
});

test('a click on a display without a ready stream is not served from another display', async () => {
  // Only display 1 has a screen source; a click on display 2 must resolve
  // null (the caller falls back to a fresh shot of the correct monitor)
  // rather than returning display 1 pixels with meaningless marker math.
  const displays = [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 1920, 1080)];
  const { backend, sent } = makeBackend();
  await backend.start({ displays, sources: [{ id: 'screen:1:0', display_id: '1' }] });

  const frame = await backend.frameForClick({ clickPos: { x: 2500, y: 400 }, clickAt: 1 });

  assert.equal(frame, null);
  assert.equal(sent.some((m) => m.type === 'frame-request'), false,
    'no request should even be sent for the wrong display');
  backend.stop();
});

test('a late worker reply after the timeout is ignored', async () => {
  const { backend, sent, worker } = makeBackend();
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const result = await backend.frameForClick({ clickAt: 1 }); // times out at 40ms
  const request = sent.find((m) => m.type === 'frame-request');
  worker({ type: 'frame-response', requestId: request.requestId, ok: true, png: Uint8Array.from([9]), width: 1, height: 1 });

  assert.equal(result, null);
  backend.stop();
});

test('stop() drains: a frame already selected at finish time still resolves', async () => {
  // This is the "I clicked many times but only got two screenshots" fix.
  // The session finishes (stop) while a click's frame is still encoding;
  // the frame must still come back, not be cancelled to null.
  const { backend, sent, worker, isDestroyed } = makeBackend();
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const pending = backend.frameForClick({ clickPos: { x: 10, y: 10 }, clickAt: 1 });
  const request = sent.find((m) => m.type === 'frame-request');
  worker({ type: 'frame-selected', requestId: request.requestId, startedAt: 0, capturedAt: 0 });

  backend.stop(); // user finishes the session while the encode is in flight
  assert.equal(backend.isActive(), false);
  assert.equal(isDestroyed(), false, 'the worker stays alive to finish encoding');

  worker({
    type: 'frame-response',
    requestId: request.requestId,
    ok: true,
    png: Uint8Array.from([5]),
    width: 1,
    height: 1,
  });

  const frame = await pending;
  assert.ok(frame, 'the in-flight frame must survive the stop');
  assert.deepEqual([...frame.png], [5]);
  assert.equal(isDestroyed(), true, 'the worker tears down once draining completes');
});

test('stop({ immediate: true }) abandons in-flight requests at once', async () => {
  const { backend, isDestroyed } = makeBackend();
  await backend.start({ displays: oneDisplay, sources: oneSource });

  const pending = backend.frameForClick({ clickPos: { x: 10, y: 10 }, clickAt: 1 });
  backend.stop({ immediate: true });

  assert.equal(await pending, null);
  assert.equal(backend.isActive(), false);
  assert.equal(isDestroyed(), true);
});

test('displays pair to screen sources by display_id; single display pairs to a lone source', () => {
  const displays = [display(1, 0, 0, 100, 100), display(2, 100, 0, 100, 100)];
  const sources = [
    { id: 'screen:b', display_id: '2' },
    { id: 'screen:a', display_id: '1' },
    { id: 'window:x', display_id: '' },
  ];

  assert.deepEqual(pairDisplaysToSources(displays, sources), [
    { display: displays[0], sourceId: 'screen:a' },
    { display: displays[1], sourceId: 'screen:b' },
  ]);
  // WSLg and some portals leave display_id empty — a single display still
  // pairs with the single screen source.
  assert.deepEqual(
    pairDisplaysToSources([displays[0]], [{ id: 'screen:0', display_id: '' }]),
    [{ display: displays[0], sourceId: 'screen:0' }],
  );
});
