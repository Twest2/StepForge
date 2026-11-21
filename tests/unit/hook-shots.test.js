'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HookShots, clearStaleShotDirs } = require('../../app/hook-shots');
const { makeTmpDir, rmrf } = require('./helpers');

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

test('screenshot folders left by a crashed run are removed, a running one\'s are kept', (t) => {
  const tmp = makeTmpDir('shot-dirs');
  t.after(() => rmrf(tmp));
  const make = (name) => {
    fs.mkdirSync(path.join(tmp, name));
    fs.writeFileSync(path.join(tmp, name, '1-1.bgra'), 'pixels');
  };
  make('stepforge-shots-111');
  make(`stepforge-shots-${process.pid}`);
  make('something-else');
  clearStaleShotDirs(tmp); // the real check: this process is running
  assert.ok(fs.existsSync(path.join(tmp, `stepforge-shots-${process.pid}`, '1-1.bgra')));
  clearStaleShotDirs(tmp, (pid) => pid === process.pid); // 111 has exited
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['something-else', `stepforge-shots-${process.pid}`].sort());
});
