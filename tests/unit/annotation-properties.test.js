'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const properties = require('../../core/annotation-properties');
const { Settings } = require('../../core/settings');

test('recent colors are validated, case-insensitively unique, bounded and ordered by most recent choice', () => {
  let recent = properties.colors(['#abcdef', '#ABCDEF', null, 'transparent', '<script>']);
  assert.deepEqual(recent, ['#ABCDEF']);
  for (let i = 0; i < 15; i++) recent = properties.recentColor(recent, '#' + i.toString(16).padStart(6, '0'));
  assert.equal(recent.length, 12);
  assert.equal(recent[0], '#00000E');
  recent = properties.recentColor(recent, '#000004');
  assert.equal(recent[0], '#000004');
  assert.equal(new Set(recent).size, recent.length);
});

test('the default palette remains available alongside recent and brand colors without repeated swatches', () => {
  const groups = properties.colorGroups(['#ABCDEF', '#E5484D'], ['#abcdef', '#123456', '#FFFFFF']);
  assert.deepEqual(groups.defaults, properties.DEFAULT_COLORS);
  assert.deepEqual(groups.recent, ['#ABCDEF']);
  assert.deepEqual(groups.brand, ['#123456']);
});

test('percentage display and editing avoid float noise and reject invalid font values', () => {
  assert.equal(properties.percentage(0.022), 2.2);
  assert.equal(properties.percentage(0.123456789), 12.35);
  assert.ok(Math.abs(properties.fontSizeFromPercent('2.2') - 0.022) < 1e-12);
  assert.equal(properties.fontSizeFromPercent('3.25'), 0.0325);
  for (const value of ['', ' ', 'bad', 'Infinity', '-1', '0', '101']) assert.equal(properties.fontSizeFromPercent(value), null);
});

test('recent colors persist in application settings across guides and settings reloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-colors-'));
  try {
    const settings = new Settings(dir);
    settings.set('editor.recentColors', ['#aabbcc', '#AABBCC', 'bad', '#123456']);
    assert.deepEqual(new Settings(dir).get('editor.recentColors'), ['#AABBCC', '#123456']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
