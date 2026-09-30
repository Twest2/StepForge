'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const parts = require('../../core/cloud-parts');

const entries = () => [
  { name: 'manifest.json', data: JSON.stringify({ exportedAt: new Date().toISOString() }) },
  { name: 'guide.json', data: JSON.stringify({ title: 'Reset a password' }) },
  { name: 'steps/s1/step.json', data: '{"title":"One"}' },
  { name: 'steps/s1/original.png', data: Buffer.alloc(40000, 7), store: true },
  { name: 'steps/s1/working.png', data: Buffer.alloc(40000, 7), store: true },
  { name: 'steps/s2/original.png', data: Buffer.alloc(50000, 9), store: true },
];
const manifestOf = (list) => zlib.gzipSync(JSON.stringify({ format: 'stepforge-snapshot', version: 1, entries: list }));

test('small files stay in the manifest and identical screenshots become one part', () => {
  const encoded = parts.encodeSnapshot(entries());
  assert.equal(encoded.parts.size, 2, 'original.png and working.png are the same bytes, stored once');
  assert.equal(encoded.bytes, entries().reduce((n, e) => n + Buffer.byteLength(e.data), 0));
  assert.ok(encoded.manifest.length < 1000, 'the manifest holds no screenshots');

  const manifest = parts.decodeSnapshot(encoded.manifest);
  assert.equal(parts.partShas(manifest).length, 2);
  const rebuilt = parts.assembleEntries(manifest, (sha) => encoded.parts.get(sha));
  assert.equal(parts.contentHash(rebuilt), parts.contentHash(entries()), 'rebuilds the exact same guide');
  assert.equal(rebuilt.find((e) => e.name.endsWith('.png')).store, true, 'screenshots are not recompressed');
  assert.throws(() => parts.assembleEntries(manifest, () => null), /missing some of its files/);
});

test('the content hash ignores the export time in manifest.json', () => {
  const later = entries();
  later[0].data = JSON.stringify({ exportedAt: '2030-01-01T00:00:00Z' });
  assert.equal(parts.contentHash(later), parts.contentHash(entries()));
});

test('a manifest from Drive is checked before anything uses it', () => {
  const sha = crypto.createHash('sha256').update('hi').digest('hex');
  const good = { name: 'guide.json', size: 2, sha, data: Buffer.from('hi').toString('base64') };
  assert.doesNotThrow(() => parts.decodeSnapshot(manifestOf([good])));
  for (const [label, list] of [
    ['path escape', [{ ...good, name: '../../evil' }]],
    ['absolute path', [{ ...good, name: '/etc/passwd' }]],
    ['duplicate name', [good, good]],
    ['inline bytes that do not match their hash', [{ ...good, data: Buffer.from('no').toString('base64') }]],
    ['wrong size', [{ ...good, size: 3 }]],
    ['bad hash', [{ name: 'a.png', size: 5, sha: 'xyz' }]],
    ['entry too large', [{ name: 'a.png', size: parts.LIMITS.maxEntryBytes + 1, sha }]],
  ]) {
    assert.throws(() => parts.decodeSnapshot(manifestOf(list)), /damaged/, label);
  }
  assert.throws(() => parts.decodeSnapshot(Buffer.from('not gzip')), /damaged/);
  assert.throws(() => parts.decodeSnapshot(zlib.gzipSync('{"format":"other","entries":[]}')), /damaged/);
  assert.throws(() => parts.decodeSnapshot(zlib.gzipSync(JSON.stringify({ format: 'stepforge-snapshot', version: 2, entries: [] }))), /newer StepForge/);
  assert.throws(() => parts.decodeSnapshot(zlib.gzipSync(' '.repeat(1024)), { ...parts.LIMITS, maxManifestBytes: 100 }), /damaged/, 'a gzip bomb is cut off');
  const many = Array.from({ length: 3 }, (_, i) => ({ ...good, name: `f${i}.json` }));
  assert.throws(() => parts.decodeSnapshot(manifestOf(many), { ...parts.LIMITS, maxEntries: 2 }), /damaged/);
});
