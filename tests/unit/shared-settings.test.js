'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { CloudSync } = require('../../core/cloud-sync');
const { Settings } = require('../../core/settings');
const { BrandingStore } = require('../../core/branding');
const { SharedSettings, mergeSharedSettings, toEntries, fromEntries } = require('../../core/shared-settings');
const { zipSync, unzipSync } = require('../../core/zip');
const parts = require('../../core/cloud-parts');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#123456"/></svg>');

function setup(t) {
  const root = makeTmpDir('shared-settings');
  t.after(() => rmrf(root));
  const files = [];
  const bytes = new Map();
  let nextFileId = 0;
  const drive = {
    clientId: 'test-client',
    status: () => ({ connected: true }),
    account: async () => 'account-a',
    cancel() {},
    async listVersions() { return files.filter((file) => file.appProperties?.stepforge === 'guide-v1'); },
    async listDeletions() { return files.filter((file) => file.appProperties?.stepforge === 'deletion-v1'); },
    async listParts() { return files.filter((file) => file.appProperties?.stepforge === 'part-v1'); },
    async listSettings() { return files.filter((file) => file.appProperties?.stepforge === 'settings-v1'); },
    async upload({ data, name, properties }) {
      const file = { id: `file-${++nextFileId}`, name, appProperties: properties, size: String(data.length),
        createdTime: new Date(Date.UTC(2026, 0, 1) + nextFileId * 1000).toISOString() };
      files.push(file); bytes.set(file.id, data); return file;
    },
    async download(id) { return bytes.get(id); },
    async deleteFile(id) {
      const index = files.findIndex((file) => file.id === id);
      if (index >= 0) files.splice(index, 1);
      bytes.delete(id);
    },
  };
  function device(name) {
    const store = new GuideStore(path.join(root, name));
    const settings = new Settings(store.settingsDir);
    const branding = new BrandingStore(store.settingsDir);
    const changes = [];
    const d = { store, settings, branding, changes, ready: true };
    d.sync = new CloudSync({ store, drive, enabled: () => true, settleMs: 0,
      shared: new SharedSettings({ settings, branding }), sharedReady: () => d.ready, onSharedChange: (c) => changes.push(c) });
    t.after(() => d.sync.stop());
    return d;
  }
  return { drive, files, bytes, device };
}

const settingsFiles = (files) => files.filter((file) => file.appProperties?.stepforge === 'settings-v1');
async function synced(sync) { const status = await sync.sync(); assert.notEqual(status.phase, 'error', status.message); return status; }
// Merges let the most recent change win; date this computer's changes before
// any cloud version (the fake cloud's clock starts in 2026).
function changedLongAgo(d) {
  const old = new Date(Date.UTC(2020, 0, 1));
  for (const file of [d.settings.file, d.settings.globalPlaceholdersFile]) if (fs.existsSync(file)) fs.utimesSync(file, old, old);
}

test('global placeholders, brand profiles with their files, the active profile and language reach another computer', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.setGlobalPlaceholders({ Company: 'Acme', Support: { format: 'markdown', text: '**Call** us' } });
  const logo = a.branding.addAsset(TINY_PNG, { kind: 'image', fileName: 'logo.png' });
  const banner = a.branding.addAsset(SVG, { kind: 'image', fileName: 'banner.svg' });
  a.branding.setRaster(banner.id, TINY_PNG);
  const profile = a.branding.save({ name: 'Acme', logo: logo.id, banner: banner.id, colors: { primary: '#112233' } });
  a.settings.set('branding.activeProfileId', profile.id);
  a.settings.set('language', 'fr');

  await synced(a.sync); await synced(b.sync);

  assert.deepEqual(b.settings.getGlobalPlaceholders(), { Company: 'Acme', Support: { format: 'markdown', text: '**Call** us' } });
  assert.deepEqual(b.branding.get(profile.id), a.branding.get(profile.id), 'the profile arrives with its own timestamps');
  assert.equal(b.branding.describe(logo.id).name, 'logo.png');
  assert.equal(b.branding.describe(banner.id).needsRaster, false, 'the PNG drawing of the SVG comes along');
  assert.equal(b.settings.get('branding.activeProfileId'), profile.id);
  assert.equal(b.settings.get('language'), 'fr');
  assert.deepEqual(b.changes, [['placeholders', 'branding', 'language']]);

  // Both sides now agree: nothing more is uploaded.
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  assert.equal(settingsFiles(files).length, 1);
});

test('changes on two computers combine, and a deletion reaches the other computer', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.setGlobalPlaceholders({ Company: 'Acme', Old: 'gone soon' });
  await synced(a.sync); await synced(b.sync);

  a.settings.setGlobalPlaceholders({ Company: 'Acme', Old: 'gone soon', Phone: '555' });
  const profile = b.branding.save({ name: 'From B' });
  b.settings.setGlobalPlaceholders({ Company: 'Acme', Email: 'help@acme.test' });
  await synced(a.sync); await synced(b.sync); await synced(a.sync);

  const expected = { Company: 'Acme', Email: 'help@acme.test', Phone: '555' };
  assert.deepEqual(a.settings.getGlobalPlaceholders(), expected);
  assert.deepEqual(b.settings.getGlobalPlaceholders(), expected);
  assert.equal(a.branding.get(profile.id)?.name, 'From B');

  b.branding.remove(profile.id);
  await synced(b.sync); await synced(a.sync);
  assert.equal(a.branding.get(profile.id), null);
});

test('when both computers change the same placeholder, the newest change wins', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.setGlobalPlaceholders({ Company: 'Acme' });
  await synced(a.sync); await synced(b.sync);

  b.settings.setGlobalPlaceholders({ Company: 'Acme Ltd' });
  changedLongAgo(b);
  a.settings.setGlobalPlaceholders({ Company: 'Acme Inc' });
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  assert.equal(b.settings.getGlobalPlaceholders().Company, 'Acme Inc');
  assert.equal(a.settings.getGlobalPlaceholders().Company, 'Acme Inc');
});

test('a new computer’s default settings never replace another computer’s choices', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  a.settings.set('language', 'de');
  await synced(a.sync);
  // B starts later with every default, and its settings file is newer.
  const b = device('b');
  b.settings.set('appearance', 'dark');
  b.settings.setGlobalPlaceholders({ Laptop: 'B' });
  await synced(b.sync); await synced(a.sync);
  assert.equal(b.settings.get('language'), 'de');
  assert.equal(a.settings.get('language'), 'de');
  assert.equal(a.settings.get('appearance'), 'system', 'other settings stay on each computer');
  assert.deepEqual(a.settings.getGlobalPlaceholders(), { Laptop: 'B' });
});

test('incoming settings wait while Settings is open, then sync', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.setGlobalPlaceholders({ Company: 'Acme' });
  await synced(a.sync);
  b.ready = false;
  const status = await b.sync.sync();
  assert.equal(status.phase, 'pending');
  assert.match(status.message, /Placeholders and branding sync when Settings closes/);
  assert.deepEqual(b.settings.getGlobalPlaceholders(), {});
  b.ready = true;
  await synced(b.sync);
  assert.deepEqual(b.settings.getGlobalPlaceholders(), { Company: 'Acme' });
});

test('settings saved by a newer StepForge are left alone', async (t) => {
  const { device, drive } = setup(t);
  const b = device('b');
  b.settings.setGlobalPlaceholders({ Mine: 'kept' });
  const entries = [...toEntries({ placeholders: { Theirs: 'x' }, settings: {}, profiles: {}, assets: {} }), { name: 'templates/one.json', data: '{}' }];
  await drive.upload({ data: zipSync(entries), name: 'StepForge settings', properties: { stepforge: 'settings-v1', hash: parts.contentHash(entries) } });
  const status = await b.sync.sync();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /newer StepForge/);
  assert.deepEqual(b.settings.getGlobalPlaceholders(), { Mine: 'kept' });
});

test('a settings version whose content doesn’t match its hash is refused', async (t) => {
  const { device, drive } = setup(t);
  const b = device('b');
  const entries = toEntries({ placeholders: { Theirs: 'x' }, settings: {}, profiles: {}, assets: {} });
  await drive.upload({ data: zipSync(entries), name: 'StepForge settings', properties: { stepforge: 'settings-v1', hash: 'a'.repeat(64) } });
  const status = await b.sync.sync();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /integrity check/);
  assert.deepEqual(b.settings.getGlobalPlaceholders(), {});
});

test('old settings versions are pruned and Replace cloud with local replaces them too', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  for (let i = 1; i <= 5; i++) {
    a.settings.setGlobalPlaceholders({ Count: String(i) });
    await synced(a.sync);
  }
  assert.equal(settingsFiles(files).length, 3, 'the current version and two before it');
  await synced(b.sync);
  b.settings.setGlobalPlaceholders({ Only: 'B' });
  await b.sync.replaceCloudWithLocal();
  assert.equal(settingsFiles(files).length, 1);
  a.sync.state.settings.syncedAt = 0; // long enough ago that it isn't the cloud lagging
  await synced(a.sync);
  assert.deepEqual(a.settings.getGlobalPlaceholders(), { Only: 'B' }, 'B’s settings are the cloud’s now');
});

test('merging is the same whichever computer does it', () => {
  const base = toEntries({ placeholders: { A: '1', B: '2' }, settings: {}, profiles: {}, assets: {} });
  const one = { entries: toEntries({ placeholders: { A: 'one', B: '2' }, settings: { language: 'fr' }, profiles: {}, assets: {} }), time: '2026-01-02T00:00:00.000Z', hash: '1' };
  const two = { entries: toEntries({ placeholders: { A: 'two' }, settings: {}, profiles: {}, assets: {} }), time: '2026-01-03T00:00:00.000Z', hash: '2' };
  const forward = mergeSharedSettings({ base, sides: [one, two] });
  const backward = mergeSharedSettings({ base, sides: [two, one] });
  assert.deepEqual(forward.entries, backward.entries);
  assert.equal(forward.conflicts, 1);
  assert.deepEqual(fromEntries(forward.entries).placeholders, { A: 'two' }, 'B was deleted, A took the newest edit');
  assert.deepEqual(fromEntries(forward.entries).settings, { language: 'fr' });
});

test('the archive round-trips and only includes files a profile uses', (t) => {
  const root = makeTmpDir('shared-settings-entries');
  t.after(() => rmrf(root));
  const settings = new Settings(root);
  const branding = new BrandingStore(root);
  const used = branding.addAsset(TINY_PNG, { kind: 'image', fileName: 'used.png' });
  branding.addAsset(SVG, { kind: 'image', fileName: 'unused.svg' });
  branding.save({ name: 'One', logo: used.id });
  const shared = new SharedSettings({ settings, branding });
  const entries = shared.snapshot().entries;
  assert.deepEqual(entries.filter((e) => e.name.startsWith('branding/assets/')).map((e) => e.name).sort(),
    [`branding/assets/${used.id}.json`, `branding/assets/${used.id}.png`, `branding/assets/${used.id}.raster.png`]);
  const again = toEntries(fromEntries(unzipSync(zipSync(entries))));
  assert.equal(parts.contentHash(again), shared.snapshot().hash);
});
