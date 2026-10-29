'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GuideStore } = require('../../core/store');
const { CloudSync } = require('../../core/cloud-sync');
const { Settings, DEFAULT_SETTINGS } = require('../../core/settings');
const { BrandingStore } = require('../../core/branding');
const { SharedSettings, mergeSharedSettings, toEntries, fromEntries } = require('../../core/shared-settings');
const { zipSync, unzipSync } = require('../../core/zip');
const { encodePng } = require('../../core/png');
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
  d.settings.setSharedChangeTimes(Object.fromEntries(Object.keys(d.settings.getSharedChangeTimes()).map((key) => [key, old.toISOString()])));
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

test('newer settings fields and brand schemas are refused before they can be merged away', async (t) => {
  const { device, drive, files } = setup(t);
  const d = device('local');
  d.settings.setGlobalPlaceholders({ Mine: 'keep' });
  const profile = d.branding.save({ name: 'Keep my brand' });
  const shared = d.sync.shared;
  for (const alter of [
    (model) => { model.settings.futureSetting = true; },
    (model) => { model.profiles[profile.id].schemaVersion = 2; },
    (model) => { model.profiles[profile.id].fonts.heading.futureFeature = true; },
  ]) {
    const model = shared.read();
    model.placeholders = { Theirs: 'incoming' };
    alter(model);
    const entries = toEntries(model);
    const file = await drive.upload({ data: zipSync(entries), name: 'Settings', properties: { stepforge: 'settings-v1', hash: parts.contentHash(entries) } });
    assert.equal((await d.sync.sync()).phase, 'error');
    assert.deepEqual(d.settings.getGlobalPlaceholders(), { Mine: 'keep' });
    assert.equal(d.branding.get(profile.id).name, 'Keep my brand');
    assert.equal(settingsFiles(files).length, 1, 'no replacement version uploaded');
    await drive.deleteFile(file.id);
  }
});

test('invalid or missing synced brand assets leave local settings and profiles intact', async (t) => {
  const { device, drive, files } = setup(t);
  const d = device('local');
  d.settings.setGlobalPlaceholders({ Mine: 'keep' });
  const kept = d.branding.save({ name: 'Keep my brand' });
  const assetId = 'a'.repeat(32);
  for (const data of [Buffer.from('not an image'), null]) {
    const model = d.sync.shared.read();
    model.placeholders = { Theirs: 'incoming' };
    model.profiles[kept.id].name = 'Incoming brand';
    model.profiles[kept.id].updatedAt = '2099-01-01T00:00:00.000Z';
    model.profiles[kept.id].logo = assetId;
    if (data) model.assets[assetId] = { kind: 'image', ext: 'png', name: 'logo.png', data };
    const entries = toEntries(model);
    const remote = await drive.upload({ data: zipSync(entries), name: 'Settings', properties: { stepforge: 'settings-v1', hash: parts.contentHash(entries) } });
    const status = await d.sync.sync();
    assert.equal(status.phase, 'error');
    assert.match(status.message, /brand asset/);
    assert.deepEqual(d.settings.getGlobalPlaceholders(), { Mine: 'keep' });
    assert.equal(d.branding.get(kept.id).name, 'Keep my brand');
    assert.equal(settingsFiles(files).length, 1, 'the damaged settings were not republished');
    await drive.deleteFile(remote.id);
  }
});

test('the same image uploaded with different names converges without repeated uploads', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  const one = a.branding.addAsset(TINY_PNG, { kind: 'image', fileName: 'logo.png' });
  const two = b.branding.addAsset(TINY_PNG, { kind: 'image', fileName: 'company.png' });
  assert.equal(one.id, two.id);
  // Independently rendered PNG copies can differ across computers too.
  a.branding.setRaster(one.id, encodePng({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }));
  b.branding.setRaster(two.id, encodePng({ width: 1, height: 1, data: Buffer.from([0, 0, 255, 255]) }));
  a.branding.save({ name: 'A', logo: one.id });
  b.branding.save({ name: 'B', logo: two.id });
  await synced(a.sync); await synced(b.sync); await synced(a.sync); await synced(b.sync);
  assert.equal(a.sync.shared.snapshot().hash, b.sync.shared.snapshot().hash);
  assert.equal(a.branding.assetMeta(one.id).name, b.branding.assetMeta(one.id).name);
  assert.deepEqual(fs.readFileSync(a.branding.rasterFile(a.branding.assetMeta(one.id))),
    fs.readFileSync(b.branding.rasterFile(b.branding.assetMeta(one.id))));
  const count = settingsFiles(files).length;
  await synced(a.sync); await synced(b.sync);
  assert.equal(settingsFiles(files).length, count);
});

test('an empty cloud settings listing republishes the local settings instead of retaining a missing head', async (t) => {
  const { device, files, drive } = setup(t);
  const a = device('a');
  a.settings.setGlobalPlaceholders({ Company: 'Acme' });
  await synced(a.sync);
  const oldHead = a.sync.state.settings.head;
  for (const file of [...settingsFiles(files)]) await drive.deleteFile(file.id);
  await synced(a.sync);
  assert.equal(settingsFiles(files).length, 1);
  assert.notEqual(a.sync.state.settings.head, oldHead);
  const b = device('b');
  await synced(b.sync);
  assert.deepEqual(b.settings.getGlobalPlaceholders(), { Company: 'Acme' });
});


test('synced language changes use the language reload handler only after open edits are saved', async () => {
  for (const available of [false, true]) {
    for (const saved of [false, true]) {
      const events = [];
      const settings = { language: 'fr' };
      const api = { settings: { all: async () => settings }, app: {} };
      if (available) api.app.setLanguage = async ({ language }) => { events.push(`language:${language}`); };
      const context = {
        window: { stepforge: api }, document: { addEventListener() {} },
        ensurePendingBrandRasters: async () => {},
      };
      const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
      vm.runInNewContext(source.replace('\nboot();', '\n'), context);
      const app = Object.create(context.window.StepForgeApp.prototype);
      app.state = {};
      app.editor = { setSettings(value) { assert.equal(value, settings); } };
      app.flushEditorBeforeNavigation = async () => { events.push('saved'); return saved; };
      await app.onSettingsSynced(['language']);
      assert.deepEqual(events, available ? (saved ? ['saved', 'language:fr'] : ['saved']) : []);
      events.length = 0;
      await app.onSettingsSynced(['placeholders']);
      assert.deepEqual(events, [], 'other synced settings never reload the window');
    }
  }
});


const setSharedTime = (device, key, time) => device.settings.setSharedChangeTimes({ ...device.settings.getSharedChangeTimes(), [key]: time });

test('unrelated settings and placeholder edits cannot promote an older conflicting language choice', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.set('language', 'fr');
  setSharedTime(a, 'setting:language', '2020-01-01T00:00:00.000Z');
  await synced(a.sync); await synced(b.sync);
  a.settings.set('language', 'de');
  setSharedTime(a, 'setting:language', '2021-01-01T00:00:00.000Z');
  b.settings.set('language', 'ja');
  setSharedTime(b, 'setting:language', '2022-01-01T00:00:00.000Z');
  a.settings.set('appearance', 'dark');
  a.settings.set('capture.delayMs', 500);
  a.settings.setGlobalPlaceholders({ New: 'A later placeholder edit' });
  setSharedTime(a, 'placeholder:New', '2023-01-01T00:00:00.000Z');
  // The unsynced choice was made before upload, not at upload time.
  fs.utimesSync(b.settings.file, new Date('2024-01-01'), new Date('2024-01-01'));
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  assert.equal(a.settings.get('language'), 'ja');
  assert.equal(b.settings.get('language'), 'ja');
  assert.deepEqual(b.settings.getGlobalPlaceholders(), { New: 'A later placeholder edit' });
});

test('shared value clocks survive reloads and ignore saves that do not change shared values', (t) => {
  const { device } = setup(t);
  const a = device('a');
  a.settings.set('language', 'fr');
  a.settings.setGlobalPlaceholders({ Company: 'Acme' });
  const before = a.sync.shared.snapshot();
  a.settings.set('appearance', 'dark');
  a.settings.set('capture.delayMs', 500);
  a.settings.set('language', 'fr');
  a.settings.setGlobalPlaceholders({ Company: 'Acme' });
  const after = a.sync.shared.snapshot();
  assert.equal(after.hash, before.hash);
  assert.equal(after.time, before.time);
  assert.deepEqual(new Settings(a.store.settingsDir).getSharedChangeTimes(), a.settings.getSharedChangeTimes());
});

test('first sync preserves newer explicit local choices and combines nonconflicting placeholders', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.set('language', 'fr');
  a.settings.setGlobalPlaceholders({ Remote: 'A', Company: 'Old company' });
  for (const key of Object.keys(a.settings.getSharedChangeTimes())) setSharedTime(a, key, '2020-01-01T00:00:00.000Z');
  await synced(a.sync);
  b.settings.set('language', 'ja');
  b.settings.setGlobalPlaceholders({ Local: 'B', Company: 'New company' });
  for (const key of Object.keys(b.settings.getSharedChangeTimes())) setSharedTime(b, key, '2021-01-01T00:00:00.000Z');
  for (const file of [b.settings.file, b.settings.globalPlaceholdersFile]) fs.utimesSync(file, new Date('2021-01-01'), new Date('2021-01-01'));
  await synced(b.sync); await synced(a.sync);
  for (const d of [a, b]) {
    assert.equal(d.settings.get('language'), 'ja');
    assert.deepEqual(d.settings.getGlobalPlaceholders(), { Remote: 'A', Local: 'B', Company: 'New company' });
  }
});

test('edits to different fields in the same brand profile combine across computers', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const profile = a.branding.save({ name: 'Acme', colors: { primary: '#112233' }, header: { text: 'Original' } });
  await synced(a.sync); await synced(b.sync);
  a.branding.save({ ...a.branding.get(profile.id), colors: { ...profile.colors, primary: '#FF0000' } });
  b.branding.save({ ...b.branding.get(profile.id), header: { text: 'New header' } });
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  for (const d of [a, b]) {
    assert.equal(d.branding.get(profile.id).colors.primary, '#FF0000');
    assert.equal(d.branding.get(profile.id).header.text, 'New header');
  }
});

test('a malformed settings head stops settings sync without blocking guides or discarding local settings', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a');
  const guide = a.store.createGuide({ title: 'A valid guide' });
  a.settings.setGlobalPlaceholders({ Mine: 'kept' });
  const entries = [{ name: 'settings.json', data: 'not json' }];
  const remote = await drive.upload({ data: zipSync(entries), name: 'Broken settings', properties: { stepforge: 'settings-v1', hash: parts.contentHash(entries) } });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await a.sync.sync()).phase, 'error');
    assert.deepEqual(a.settings.getGlobalPlaceholders(), { Mine: 'kept' });
    assert.deepEqual(settingsFiles(files).map((file) => file.id), [remote.id]);
    assert.ok((await drive.listVersions()).some((file) => file.appProperties.guideId === guide.guideId));
  }
});


test('an explicit change back to the base language is still a newer edit', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.set('language', 'fr');
  setSharedTime(a, 'setting:language', '2020-01-01T00:00:00.000Z');
  await synced(a.sync); await synced(b.sync);
  b.settings.set('language', 'ja');
  setSharedTime(b, 'setting:language', '2021-01-01T00:00:00.000Z');
  a.settings.set('language', 'de');
  a.settings.set('language', 'fr');
  setSharedTime(a, 'setting:language', '2022-01-01T00:00:00.000Z');
  await synced(b.sync); await synced(a.sync); await synced(b.sync);
  assert.equal(a.settings.get('language'), 'fr');
  assert.equal(b.settings.get('language'), 'fr');
});


test('a deliberate reset to the default language is newer than a conflicting older choice', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  a.settings.set('language', 'fr');
  setSharedTime(a, 'setting:language', '2020-01-01T00:00:00.000Z');
  await synced(a.sync); await synced(b.sync);
  b.settings.set('language', 'ja');
  setSharedTime(b, 'setting:language', '2021-01-01T00:00:00.000Z');
  a.settings.set('language', DEFAULT_SETTINGS.language);
  setSharedTime(a, 'setting:language', '2022-01-01T00:00:00.000Z');
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  assert.equal(a.settings.get('language'), DEFAULT_SETTINGS.language);
  assert.equal(b.settings.get('language'), DEFAULT_SETTINGS.language);
});

test('recording shortcuts sync immediately, including disabled bindings, while other capture options stay local', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'), b = device('b');
  a.settings.set('capture', { ...a.settings.get('capture'), hotkeyCapture: 'CommandOrControl+Shift+7', hotkeyPauseResume: '', delayMs: 750, mode: 'window' });
  b.settings.set('capture.delayMs', 250);
  await synced(a.sync); await synced(b.sync);
  assert.equal(b.settings.get('capture.hotkeyCapture'), 'CommandOrControl+Shift+7');
  assert.equal(b.settings.get('capture.hotkeyPauseResume'), '', 'a cleared shortcut stays disabled');
  assert.equal(b.settings.get('capture.delayMs'), 250);
  assert.equal(b.settings.get('capture.mode'), 'fullscreen');
  assert.ok(b.changes.some((changes) => changes.includes('shortcuts')));
  const count = settingsFiles(files).length;
  await synced(a.sync); await synced(b.sync);
  assert.equal(settingsFiles(files).length, count, 'matching shortcuts do not trigger repeated uploads');
});

test('shortcut edits merge independently, and a newer explicit default reset wins a conflict', async (t) => {
  const { device } = setup(t);
  const a = device('a'), b = device('b');
  a.settings.set('capture.hotkeyCapture', 'Alt+1');
  setSharedTime(a, 'setting:hotkeyCapture', '2020-01-01T00:00:00.000Z');
  await synced(a.sync); await synced(b.sync);
  a.settings.set('capture.hotkeyCapture', 'Alt+3');
  setSharedTime(a, 'setting:hotkeyCapture', '2021-01-01T00:00:00.000Z');
  b.settings.set('capture.hotkeyPauseResume', 'Alt+4');
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  for (const d of [a, b]) {
    assert.equal(d.settings.get('capture.hotkeyCapture'), 'Alt+3');
    assert.equal(d.settings.get('capture.hotkeyPauseResume'), 'Alt+4');
  }
  b.settings.set('capture.hotkeyCapture', 'Alt+5');
  setSharedTime(b, 'setting:hotkeyCapture', '2022-01-01T00:00:00.000Z');
  a.settings.set('capture.hotkeyCapture', DEFAULT_SETTINGS.capture.hotkeyCapture);
  setSharedTime(a, 'setting:hotkeyCapture', '2023-01-01T00:00:00.000Z');
  a.settings.set('capture.delayMs', 900);
  await synced(b.sync); await synced(a.sync); await synced(b.sync);
  for (const d of [a, b]) assert.equal(d.settings.get('capture.hotkeyCapture'), DEFAULT_SETTINGS.capture.hotkeyCapture);
});

test('new computer defaults do not overwrite shortcuts, and unrelated capture saves do not change their clocks', async (t) => {
  const { device } = setup(t);
  const a = device('a'), b = device('b');
  a.settings.set('capture.hotkeyCapture', 'Alt+8');
  const clocks = a.settings.getSharedChangeTimes();
  a.settings.set('capture', { ...a.settings.get('capture'), delayMs: 150 });
  assert.deepEqual(a.settings.getSharedChangeTimes(), clocks);
  await synced(a.sync); await synced(b.sync);
  assert.equal(b.settings.get('capture.hotkeyCapture'), 'Alt+8');
  const before = a.sync.shared.snapshot().hash;
  a.settings.set('capture.delayMs', 1000);
  assert.equal(a.sync.shared.snapshot().hash, before);
  // Upgrading from a version whose clock file tracked only language.
  a.settings.setSharedChangeTimes({ 'setting:language': '2020-01-01T00:00:00.000Z' });
  const loaded = new Settings(a.store.settingsDir);
  assert.ok(loaded.getSharedChangeTimes()['setting:hotkeyCapture']);
  assert.equal(loaded.getSharedChangeTimes()['setting:language'], '2020-01-01T00:00:00.000Z');
});

test('incoming shortcut changes re-register the running app hotkeys before notifying the renderer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
  const hook = source.match(/onSharedChange: (\(changes\) => \{[\s\S]*?\n      \}),/)[1];
  const events = [];
  const onSharedChange = vm.runInNewContext(`(${hook})`, {
    registerHotkeys: () => events.push('register'), sendToRenderer: (name, payload) => events.push([name, [...payload.changes]]),
  });
  onSharedChange(['shortcuts']);
  assert.deepEqual(events, ['register', ['cloud:settings-changed', ['shortcuts']]]);
  events.length = 0;
  onSharedChange(['branding']);
  assert.deepEqual(events, [['cloud:settings-changed', ['branding']]]);
  assert.match(source, /keyPath === 'capture' \|\| keyPath\.startsWith\('capture\.hotkey'\)/);
});

test('malformed shortcut values are refused before applying synced settings', (t) => {
  const { device } = setup(t);
  const a = device('a');
  const shared = a.sync.shared;
  for (const value of [null, 42, 'Alt+\nA', 'A'.repeat(257)]) {
    const entries = shared.snapshot().entries.map((entry) => entry.name === 'settings.json'
      ? { ...entry, data: JSON.stringify({ hotkeyCapture: value }) } : entry);
    assert.throws(() => shared.apply(entries), /damaged/);
    assert.equal(a.settings.get('capture.hotkeyCapture'), DEFAULT_SETTINGS.capture.hotkeyCapture);
  }
});
