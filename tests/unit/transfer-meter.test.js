'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TransferMeter } = require('../../core/transfer-meter');

function meter(options = {}) {
  let now = 0;
  const updates = [];
  const m = new TransferMeter({ direction: 'download', name: 'Guide', total: 4000, now: () => now, onUpdate: (u) => updates.push(u), ...options });
  return { m, updates, advance(ms) { now += ms; } };
}

test('reports bytes moved, total and a rate over the recent window', () => {
  const { m, updates, advance } = meter();
  m.report();
  assert.deepEqual(updates.at(-1), { direction: 'download', name: 'Guide', loaded: 0, total: 4000, bytesPerSecond: 0 });
  advance(1000); m.update(1000);
  assert.deepEqual(updates.at(-1), { direction: 'download', name: 'Guide', loaded: 1000, total: 4000, bytesPerSecond: 1000 });
  advance(1000); m.update(3000);
  assert.equal(updates.at(-1).bytesPerSecond, 1500);
});

test('throttles updates but always reports completion', () => {
  const { m, updates, advance } = meter();
  m.report();
  advance(10); m.update(100);
  advance(10); m.update(200);
  assert.equal(updates.length, 1);
  advance(300); m.update(300);
  assert.equal(updates.length, 2);
  advance(10); m.update(4000);
  assert.equal(updates.at(-1).loaded, 4000);
});

test('a retried request restarting from zero resets the rate instead of going negative', () => {
  const { m, updates, advance } = meter();
  advance(1000); m.update(2000);
  advance(1000); m.update(0);
  advance(1000); m.update(500);
  assert.equal(updates.at(-1).loaded, 500);
  assert.equal(updates.at(-1).bytesPerSecond, 500);
});

test('an unknown or understated total grows to the bytes actually moved', () => {
  const { m, updates, advance } = meter({ total: undefined });
  advance(500); m.update(700);
  assert.equal(updates.at(-1).total, 700);
});
