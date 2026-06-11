'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  systemPlaceholders, resolveScopes, expandPlaceholders,
  listPlaceholders, collectGuidePlaceholders,
} = require('../../core/placeholders');
const { createGuide, createStep } = require('../../core/schema');
const { Settings, DEFAULT_SETTINGS } = require('../../core/settings');
const { writeJsonSync } = require('../../core/util');
const { makeTmpDir, rmrf } = require('./helpers');

test('placeholder expansion respects guide > global > system precedence', () => {
  const guide = createGuide({ title: 'Install VPN', placeholders: { Author: 'Alice' } });
  const system = systemPlaceholders(guide, { now: new Date(2026, 5, 10, 9, 5), stepCount: 4 });
  const values = resolveScopes({ guide, globals: { Author: 'Bob', Company: 'Acme' }, system });

  const out = expandPlaceholders(
    'Guide [[Guide_Title]] by [[Author]] at [[Company]] on [[Date]] ([[Step_Count]] steps)',
    values
  );
  assert.equal(out, 'Guide Install VPN by Alice at Acme on 2026-06-10 (4 steps)');
});

test('unknown placeholders stay visible instead of disappearing', () => {
  const out = expandPlaceholders('Hello [[Nobody]] and [[Author]]', { Author: 'A' });
  assert.equal(out, 'Hello [[Nobody]] and A');
});

test('placeholders used across a guide are collected from every surface', () => {
  const guide = createGuide({ title: '[[Product]] setup', descriptionHtml: '<p>[[Company]]</p>' });
  const steps = [
    createStep({ title: 'Login as [[Author]]' }),
    createStep({
      textBlocks: [{ title: 'Warning [[Severity]]', descriptionHtml: '<p>[[Company]]</p>' }],
      annotations: [{ type: 'text', x: 0, y: 0, w: 0.1, h: 0.1, text: 'See [[Doc_Ref]]' }],
    }),
  ];
  assert.deepEqual(
    collectGuidePlaceholders(guide, steps),
    ['Author', 'Company', 'Doc_Ref', 'Product', 'Severity']
  );
  assert.deepEqual(listPlaceholders('no tokens here'), []);
});

test('settings persist, deep-merge with defaults, and store global placeholders', (t) => {
  const dir = makeTmpDir('settings');
  t.after(() => rmrf(dir));

  const s1 = new Settings(dir);
  assert.equal(s1.get('appearance'), DEFAULT_SETTINGS.appearance);
  s1.set('appearance', 'dark');
  s1.set('capture.delayMs', 1500);
  s1.setGlobalPlaceholders({ Company: 'Acme', Author: 'Tyler' });

  // A fresh instance reads back the changed values merged over defaults.
  const s2 = new Settings(dir);
  assert.equal(s2.get('appearance'), 'dark');
  assert.equal(s2.get('capture.delayMs'), 1500);
  assert.equal(s2.get('capture.clickMarker'), DEFAULT_SETTINGS.capture.clickMarker);
  assert.deepEqual(s2.getGlobalPlaceholders(), { Company: 'Acme', Author: 'Tyler' });
});

test('a corrupted placeholders/settings file falls back instead of crashing the settings dialog', (t) => {
  const dir = makeTmpDir('settings-corrupt');
  t.after(() => rmrf(dir));

  // Simulate a file left over from a past bug: literal "undefined" instead of JSON.
  fs.writeFileSync(path.join(dir, 'placeholders.json'), 'undefined\n');
  fs.writeFileSync(path.join(dir, 'app-settings.json'), 'undefined\n');

  const s = new Settings(dir);
  assert.deepEqual(s.getGlobalPlaceholders(), {});
  assert.equal(s.get('appearance'), DEFAULT_SETTINGS.appearance);

  // Saving afterwards overwrites the corrupted file with valid JSON.
  s.setGlobalPlaceholders({ Author: 'Tyler' });
  assert.deepEqual(s.getGlobalPlaceholders(), { Author: 'Tyler' });
});

test('writeJsonSync refuses to write a non-JSON value instead of writing the literal string "undefined"', () => {
  const dir = makeTmpDir('write-json-guard');
  try {
    assert.throws(() => writeJsonSync(path.join(dir, 'bad.json'), undefined), TypeError);
  } finally {
    rmrf(dir);
  }
});
