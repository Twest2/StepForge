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
    if (calls === 2) fs.writeFileSync(path.join(source, 'library', 'changed.json'), 'changed');
    return result;
  };
  assert.equal(location.applyPending(), source);
  assert.match(location.status().error, /not moved/);
  assert.ok(fs.existsSync(path.join(source, 'library', 'guides', 'guide.json')));
});

/**
 * The automatic move off the old Windows default (%APPDATA%\stepforge) to
 * %USERPROFILE%\StepForge. That old folder is also Electron's profile and holds
 * this bookkeeping file, so only StepForge's own entries move.
 */
function windowsLayout(t) {
  const root = makeTmpDir('library-migration');
  t.after(() => rmrf(root));
  const legacy = path.join(root, 'AppData', 'Roaming', 'stepforge');
  const home = path.join(root, 'StepForge');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(legacy, rel)), { recursive: true }); fs.writeFileSync(path.join(legacy, rel), text); };
  write('library/guides/g1/guide.json', '{"title":"Install the VPN"}');
  write('library/guides/g1/steps/s1/original.png', 'png bytes');
  write('settings/app-settings.json', '{"appearance":"dark"}');
  write('cloud/sync-abc.json', '{"records":{}}');
  write('shared-links/links.json', '[]');
  write('temp/scratch.tmp', 'scratch');
  write('ocr/eng/eng.traineddata', 'cache');
  // Electron's profile, in the same folder on Windows.
  write('Local State', '{}');
  write('Cache/data_0', 'browser cache');
  const file = path.join(legacy, 'library-location.json');
  const open = () => new LibraryLocation({ file, defaultPath: home, legacyPath: legacy });
  return { root, legacy, home, file, open };
}

test('until it has moved, a library in the old Windows folder stays the current one, for the app and for agents', t => {
  const { legacy, home, open } = windowsLayout(t);
  const location = open();
  assert.equal(location.status().current, legacy);
  assert.equal(location.status().defaultPath, home);
  assert.equal(fs.existsSync(home), false);
});

test('the old Windows library moves to the new default on its own, checked, with nothing for the user to do', t => {
  const { legacy, home, file, open } = windowsLayout(t);
  const location = open();
  assert.equal(location.scheduleMigration(), true);
  assert.equal(location.applyPending(), home);
  assert.equal(location.status().current, home);
  assert.equal(location.status().error, null);
  assert.equal(location.status().pending, null);

  // StepForge's entries moved, byte for byte.
  for (const rel of ['library/guides/g1/guide.json', 'library/guides/g1/steps/s1/original.png', 'settings/app-settings.json', 'cloud/sync-abc.json', 'shared-links/links.json']) {
    assert.equal(fs.readFileSync(path.join(home, rel), 'utf8'), fs.readFileSync(path.join(legacy, rel), 'utf8'), rel);
  }
  // Browser files, scratch files and caches did not.
  assert.deepEqual(fs.readdirSync(home).sort(), ['cloud', 'library', 'settings', 'shared-links']);
  // The old folder is untouched: it's the safety copy, and Electron's profile.
  assert.ok(fs.existsSync(path.join(legacy, 'library', 'guides', 'g1', 'guide.json')));
  assert.ok(fs.existsSync(path.join(legacy, 'Cache', 'data_0')));
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readdirSync(path.dirname(home)).filter((n) => n.startsWith('.stepforge-move-')).length, 0, 'no staging folder left');

  // The next start, and the MCP server, use the new folder and move nothing again.
  const restarted = open();
  assert.equal(restarted.status().current, home);
  assert.equal(restarted.scheduleMigration(), false);
  assert.ok(Date.parse(restarted.state.migrated.at) > 0);
  assert.equal(restarted.state.migrated.from, legacy);
});

test('nothing moves for a new install, a folder the user chose, or a move the user already asked for', t => {
  const { legacy, home, file, open } = windowsLayout(t);
  // A new install: the old folder is only Electron's profile.
  for (const name of ['library', 'settings', 'cloud', 'shared-links']) fs.rmSync(path.join(legacy, name), { recursive: true });
  const fresh = open();
  assert.equal(fresh.status().current, home);
  assert.equal(fresh.scheduleMigration(), false);

  const chosen = path.join(path.dirname(home), 'Guides');
  fs.writeFileSync(file, JSON.stringify({ current: chosen }));
  assert.equal(open().scheduleMigration(), false);
  assert.equal(open().status().current, chosen);

  fs.writeFileSync(file, JSON.stringify({ current: legacy, pending: { source: legacy, target: chosen } }));
  const userMove = open();
  assert.equal(userMove.scheduleMigration(), false);
  assert.equal(userMove.state.pending.automatic, undefined);
});

test('when the new folder already holds a library, the old one stays in use and nothing is mixed', t => {
  const { legacy, home, open } = windowsLayout(t);
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  fs.writeFileSync(path.join(home, 'library', 'folders.json'), '[]');
  const location = open();
  assert.equal(location.scheduleMigration(), false);
  assert.equal(location.applyPending(), legacy);
  assert.match(location.status().error, /still in .*already holds a StepForge library/);
  assert.deepEqual(fs.readdirSync(home), ['library']);
});

test('a move that fails its check changes nothing and is tried again at the next start', t => {
  const { legacy, home, open } = windowsLayout(t);
  const location = open();
  location.scheduleMigration();
  const original = location.manifest.bind(location);
  let calls = 0;
  location.manifest = (dir) => {
    calls += 1;
    const result = original(dir);
    if (calls === 2) fs.writeFileSync(path.join(legacy, 'library', 'guides', 'g1', 'guide.json'), '{"title":"edited"}');
    return result;
  };
  assert.equal(location.applyPending(), legacy);
  assert.match(location.status().error, /still in .*tries again the next time it starts/);
  assert.equal(location.status().pending, null, 'no move left waiting in Settings');
  assert.equal(fs.existsSync(home) && fs.readdirSync(home).length, 0, 'nothing left half-copied');
  assert.equal(fs.readFileSync(path.join(legacy, 'library', 'guides', 'g1', 'guide.json'), 'utf8'), '{"title":"edited"}');

  const next = open();
  assert.equal(next.scheduleMigration(), true);
  assert.equal(next.applyPending(), home);
});

test('the old copy is removed after 30 days, only StepForge’s entries, and never by the Store app', t => {
  const { legacy, home, file, open } = windowsLayout(t);
  const location = open();
  location.scheduleMigration();
  location.applyPending();
  const at = Date.parse(location.state.migrated.at);
  const day = 24 * 60 * 60 * 1000;

  assert.equal(open().removeMigratedCopy({ now: at + 29 * day }), false);
  assert.ok(fs.existsSync(path.join(legacy, 'library')));
  assert.equal(open().removeMigratedCopy({ now: at + 31 * day, allowDelete: false }), false, 'the Store app leaves the installer’s folder');
  assert.ok(fs.existsSync(path.join(legacy, 'library')));

  const later = open();
  assert.equal(later.removeMigratedCopy({ now: at + 31 * day }), true);
  assert.deepEqual(fs.readdirSync(legacy).sort(), ['Cache', 'Local State', 'library-location.json']);
  assert.ok(fs.existsSync(path.join(home, 'library', 'guides', 'g1', 'guide.json')), 'the library itself is untouched');
  const after = open();
  assert.equal(after.status().current, home);
  assert.equal(after.state.migrated, undefined);
  assert.equal(after.removeMigratedCopy({ now: at + 60 * day }), false, 'only once');
  assert.ok(fs.existsSync(file));
});

test('a location-file write failure rolls back the copy so automatic migration can retry', t => {
  const { legacy, home, file, open } = windowsLayout(t);
  const location = open();
  location.scheduleMigration();
  const rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw Object.assign(new Error('location file is locked'), { code: 'EACCES' });
    return rename(from, to);
  });
  assert.equal(location.applyPending(), legacy);
  assert.match(location.status().error, /location file is locked/);
  assert.deepEqual(fs.readdirSync(home), [], 'the uncommitted copy must not block the next attempt');
  assert.ok(fs.existsSync(path.join(legacy, 'library', 'guides', 'g1', 'guide.json')));
  failure.mock.restore();

  const next = open();
  assert.equal(next.scheduleMigration(), true);
  assert.equal(next.applyPending(), home);
  assert.equal(open().status().current, home);
});

test('a leftover empty staging directory does not undo a committed migration', t => {
  const { home, open } = windowsLayout(t);
  const location = open();
  location.scheduleMigration();
  const rmdir = fs.rmdirSync;
  const cleanupFailure = t.mock.method(fs, 'rmdirSync', (dir, ...args) => {
    if (path.basename(dir).startsWith('.stepforge-move-')) throw new Error('temporary folder is locked');
    return rmdir(dir, ...args);
  });
  assert.equal(location.applyPending(), home);
  assert.equal(location.status().error, null);
  assert.equal(open().status().current, home);
  cleanupFailure.mock.restore();
});

test('a move the user chooses also takes only StepForge’s entries and leaves a folder holding this file in place', t => {
  const { legacy, root, file, open } = windowsLayout(t);
  const chosen = path.join(root, 'Guides');
  fs.writeFileSync(file, JSON.stringify({ current: legacy }));
  const location = open();
  location.schedule(chosen);
  const restarted = open();
  assert.equal(restarted.applyPending(), chosen);
  assert.deepEqual(fs.readdirSync(chosen).sort(), ['cloud', 'library', 'settings', 'shared-links']);
  assert.ok(fs.existsSync(path.join(legacy, 'Cache', 'data_0')), 'not renamed away: it is Electron’s profile');
  assert.ok(fs.existsSync(file));
  assert.equal(restarted.status().backup, legacy);
});
