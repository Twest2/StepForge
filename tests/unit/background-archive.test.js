'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeArchive } = require('../../core/background-archive');
const { unzipSync } = require('../../core/zip');

test('archive work yields to the event loop and preserves binary data', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.zip');
  const bytes = Buffer.alloc(8 * 1024 * 1024, 173);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    await writeArchive([{ name: 'image.png', data: bytes, store: true }], file);
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'main event loop runs while writing');
  assert.deepEqual(unzipSync(fs.readFileSync(file))[0].data, bytes);
});

test('failed writes reject and do not poison subsequent jobs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(writeArchive([{ name: '../unsafe', data: 'bad' }], path.join(dir, 'bad.zip')));
  const file = path.join(dir, 'good.zip');
  await writeArchive([{ name: 'text', data: 'ok' }], file);
  assert.equal(unzipSync(fs.readFileSync(file))[0].data.toString(), 'ok');
});
