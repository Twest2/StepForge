'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HookShots } = require('../../app/hook-shots');

const shot = (name) => ({ file: name, width: 1, height: 1 });

test('a click gets its screenshot whether it arrives before or after the click asks', async () => {
  const shots = new HookShots();
  const early = shot('early');
  shots.deliver(100, early);
  assert.equal(await shots.take(100, 1000), early);

  const late = shot('late');
  const waiting = shots.take(200, 1000);
  shots.deliver(200, late);
  assert.equal(await waiting, late);
});

test('a failed or missing screenshot gives the click null, so it uses the stream frame', async () => {
  const shots = new HookShots();
  const failed = shots.take(100, 1000);
  shots.deliver(100, null);
  assert.equal(await failed, null);
  assert.equal(await shots.take(200, 10), null);
});

test('screenshots no click takes are discarded, and a late one is not lost on disk', async () => {
  const discarded = [];
  const shots = new HookShots({ discard: (s) => discarded.push(s.file), keepMs: 20 });
  assert.equal(await shots.take(100, 5), null);
  shots.deliver(100, shot('late'));
  shots.deliver(200, shot('ignored click'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(discarded.sort(), ['ignored click', 'late']);
});

test('stopping discards held screenshots and releases waiting clicks', async () => {
  const discarded = [];
  const shots = new HookShots({ discard: (s) => discarded.push(s.file) });
  shots.deliver(100, shot('held'));
  const waiting = shots.take(200, 60000);
  shots.clear();
  assert.equal(await waiting, null);
  assert.deepEqual(discarded, ['held']);
});
