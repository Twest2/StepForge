'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// The license was a release blocker: package.json/spec once said MPL-2.0
// while the README/docs said CC-BY-NC. The owner has since chosen Apache 2.0.
// These guards keep every surface consistent so it can never silently drift
// back to a contradiction.

test('a root LICENSE exists with the full Apache 2.0 text', () => {
  assert.ok(exists('LICENSE'), 'root LICENSE must exist');
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  // It must be the real license text, not a one-paragraph paraphrase.
  assert.ok(license.length > 8000, 'LICENSE should contain the full legal text');
  assert.match(license, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
});

test('package.json declares Apache-2.0', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'Apache-2.0');
});

test('no shipping license surface still claims an earlier license', () => {
  for (const rel of [
    'package.json',
    'README.md',
    'docs/LICENSE',
    'docs/CONTRIBUTING.md',
    'packaging/linux/fedora/stepforge.spec',
    'packaging/linux/launchpad/debian/copyright',
  ]) {
    assert.doesNotMatch(read(rel), /MPL-2\.0|Mozilla Public/i, `${rel} must not mention MPL`);
    assert.doesNotMatch(read(rel), /CC[- ]BY|NonCommercial|non-commercial/i, `${rel} must not mention CC BY-NC`);
  }
});

test('the license story is consistent across the shipping surfaces', () => {
  assert.match(read('README.md'), /Apache License 2\.0/);
  assert.match(read('docs/CONTRIBUTING.md'), /Apache License 2\.0/);
  assert.match(read('docs/LICENSE'), /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(read('packaging/linux/fedora/stepforge.spec'), /^License:\s+Apache-2\.0$/m);
  assert.match(read('packaging/linux/launchpad/debian/copyright'), /^License: Apache-2\.0$/m);
});

test('the About info surface reports the license from package.json', () => {
  // main.js exposes license in app:info so the About view can never contradict.
  const main = read('app/main.js');
  assert.match(main, /license: PACKAGE_JSON\.license/);
});
