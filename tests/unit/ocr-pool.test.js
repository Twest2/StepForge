'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OcrPool, defaultSize } = require('../../app/ocr-pool');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Workers whose reads finish when the test says so.
function fakeWorkers() {
  const state = { started: 0, starting: 0, maxStarting: 0, reading: 0, maxReading: 0, terminated: 0, waiting: [] };
  const start = async () => {
    state.starting += 1;
    state.maxStarting = Math.max(state.maxStarting, state.starting);
    await tick();
    state.starting -= 1;
    state.started += 1;
    const id = state.started;
    return {
      id,
      read: (value) => new Promise((resolve) => {
        state.reading += 1;
        state.maxReading = Math.max(state.maxReading, state.reading);
        state.waiting.push(() => { state.reading -= 1; resolve(`${value} by ${id}`); });
      }),
      terminate: async () => { state.terminated += 1; },
    };
  };
  const finishAll = async () => {
    while (state.waiting.length || state.reading) {
      state.waiting.splice(0).forEach((finish) => finish());
      await tick();
    }
  };
  return { state, start, finishAll };
}

test('reads side by side up to the pool size, starting workers one at a time', async () => {
  const { state, start, finishAll } = fakeWorkers();
  const pool = new OcrPool({ start, size: 3, idleMs: 60000 });
  const reads = Array.from({ length: 7 }, (_, i) => pool.run((worker) => worker.read(i)));
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(state.started, 3);
  assert.equal(state.maxStarting, 1, 'never two starting at once');
  assert.equal(state.reading, 3);
  await finishAll();
  const results = await Promise.all(reads);
  assert.deepEqual(results.map((r) => Number(r.split(' ')[0])), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(state.maxReading, 3);
  assert.equal(state.started, 3, 'workers are reused');
  await pool.stop();
});

test('a lone read starts one worker, and idle workers stop until reading starts again', async () => {
  const { state, start, finishAll } = fakeWorkers();
  const pool = new OcrPool({ start, size: 4, idleMs: 5 });
  const read = pool.run((worker) => worker.read('a'));
  await tick(); await tick();
  await finishAll();
  assert.equal(await read, 'a by 1');
  assert.equal(state.started, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.terminated, 1);
  assert.equal(pool.workers.length, 0);

  const again = pool.run((worker) => worker.read('b'));
  await tick(); await tick();
  await finishAll();
  assert.equal(await again, 'b by 2');
  await pool.stop();
});

test('a failed read keeps its worker; a worker that cannot start fails the reads only when none are running', async () => {
  let fail = true;
  const pool = new OcrPool({
    size: 2,
    idleMs: 60000,
    start: async () => {
      if (fail) throw new Error('no language data');
      return { recognize: async (x) => x, terminate: async () => {} };
    },
  });
  await assert.rejects(pool.run((worker) => worker.recognize(1)), /no language data/);
  fail = false;
  await assert.rejects(pool.run(() => { throw new Error('bad image'); }), /bad image/);
  assert.equal(await pool.run((worker) => worker.recognize(2)), 2);
  assert.equal(pool.workers.length, 1);

  // A second worker failing to start leaves the first one reading.
  fail = true;
  const both = await Promise.all([pool.run((w) => w.recognize(3)), pool.run((w) => w.recognize(4))]);
  assert.deepEqual(both, [3, 4]);
  assert.equal(pool.size, 1);
  await pool.stop();
});

test('the default size leaves processors free and is at least one', () => {
  const size = defaultSize();
  assert.ok(Number.isInteger(size) && size >= 1 && size <= 8);
});
