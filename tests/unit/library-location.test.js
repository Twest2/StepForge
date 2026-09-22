'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LibraryLocation } = require('../../core/library-location');
const { makeTmpDir, rmrf } = require('./helpers');

function setup(t) {
  const root = makeTmpDir('library-location');
  t.after(() => rmrf(root));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'library', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(source, 'library', 'guides', 'guide.json'), 'guide');
  return { root, source, target, file: path.join(root, 'bootstrap.json') };
}

test('a scheduled library move copies and verifies before activating on restart', t => {
  const { source, target, file } = setup(t);
  const location = new LibraryLocation({ file, defaultPath: source });
  assert.equal(location.status().current, source);
  location.schedule(target);
  assert.equal(location.status().pending, target);
  const restarted = new LibraryLocation({ file, defaultPath: source });
  assert.equal(restarted.applyPending(), target);
  assert.equal(restarted.status().current, target);
  assert.equal(fs.readFileSync(path.join(target, 'library', 'guides', 'guide.json'), 'utf8'), 'guide');
  assert.ok(restarted.status().backup && fs.existsSync(restarted.status().backup));
});

test('invalid destinations, nested paths, override mode, and cancellation never move the source', t => {
  const { source, target, file } = setup(t);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'existing.txt'), 'keep');
  const location = new LibraryLocation({ file, defaultPath: source });
  assert.throws(() => location.schedule(target), /empty folder/);
  assert.throws(() => location.schedule(path.join(source, 'nested')), /separate folder/);
  const elsewhere = path.join(path.dirname(source), 'elsewhere');
  fs.mkdirSync(elsewhere);
  location.schedule(elsewhere);
  location.cancel();
  assert.equal(new LibraryLocation({ file, defaultPath: source }).applyPending(), source);
  const locked = new LibraryLocation({ file: path.join(path.dirname(file), 'locked.json'), defaultPath: source, override: source });
  assert.throws(() => locked.schedule(elsewhere), /STEPFORGE_DATA_DIR/);
  assert.equal(fs.readFileSync(path.join(source, 'library', 'guides', 'guide.json'), 'utf8'), 'guide');
});

test('a changed source during a scheduled move leaves the original active', t => {
  const { source, target, file } = setup(t);
  const location = new LibraryLocation({ file, defaultPath: source });
  location.schedule(target);
  const original = location.manifest.bind(location);
  let calls = 0;
  location.manifest = dir => {
    calls += 1;
    const result = original(dir);
    if (calls === 2) fs.writeFileSync(path.join(source, 'changed.txt'), 'changed');
    return result;
  };
  assert.equal(location.applyPending(), source);
  assert.match(location.status().error, /not moved/);
  assert.ok(fs.existsSync(path.join(source, 'library', 'guides', 'guide.json')));
});
