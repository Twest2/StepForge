'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// The license was a release blocker: package.json/spec said MPL-2.0 while the
// README/docs said CC-BY-NC. The owner chose CC BY-NC 4.0. These guards keep
// every surface consistent so it can never silently drift back to a
// contradiction.

test('a root LICENSE exists with the full CC BY-NC 4.0 text', () => {
  assert.ok(exists('LICENSE'), 'root LICENSE must exist');
  const license = read('LICENSE');
  assert.match(license, /Creative Commons/);
  assert.match(license, /Attribution-NonCommercial 4\.0 International/);
  assert.match(license, /SPDX-License-Identifier:\s*CC-BY-NC-4\.0/);
  // It must be the real legalcode, not a one-paragraph paraphrase.
  assert.ok(license.length > 8000, 'LICENSE should contain the full legal text');
  assert.match(license, /Section 1 -+ Definitions/);
});

test('package.json declares CC-BY-NC-4.0 and never MPL', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'CC-BY-NC-4.0');
});

test('no shipping license surface still claims MPL-2.0', () => {
  for (const rel of [
    'package.json',
    'README.md',
    'docs/LICENSE',
    'docs/CONTRIBUTING.md',
    'packaging/linux/fedora/stepforge.spec',
  ]) {
    assert.doesNotMatch(read(rel), /MPL-2\.0|Mozilla Public/i, `${rel} must not mention MPL`);
  }
});

test('the license story is consistent across the shipping surfaces', () => {
  assert.match(read('README.md'), /CC BY-NC 4\.0/);
  assert.match(read('docs/CONTRIBUTING.md'), /CC BY-NC 4\.0/);
  assert.match(read('docs/LICENSE'), /CC-BY-NC-4\.0/);
  assert.match(read('packaging/linux/fedora/stepforge.spec'), /^License:\s+CC-BY-NC-4\.0$/m);
});

test('the About info surface reports the license from package.json', () => {
  // main.js exposes license in app:info so the About view can never contradict.
  const main = read('app/main.js');
  assert.match(main, /license: PACKAGE_JSON\.license/);
});
