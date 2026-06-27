'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { stampVersion } = require('../../scripts/stamp-version');

test('stampVersion splits build labels into package and build versions', () => {
  const root = makeTmpDir('stamp-version');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'stepforge',
      version: '0.1.0',
      private: true,
      buildVersion: '0.1.0',
    }, null, 2));

    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      name: 'stepforge',
      version: '0.1.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'stepforge',
          version: '0.1.0',
        },
      },
    }, null, 2));

    stampVersion(root, '0.3.2.1');

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

    assert.equal(pkg.version, '0.3.2');
    assert.equal(pkg.buildVersion, '0.3.2.1');
    assert.equal(lock.version, '0.3.2');
    assert.equal(lock.packages[''].version, '0.3.2');
  } finally {
    rmrf(root);
  }
});
