'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function stampVersion(rootDir, version) {
  if (!version || typeof version !== 'string') {
    throw new Error('version is required');
  }

  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = version;
  writeJson(pkgPath, pkg);

  const lockPath = path.join(rootDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return;

  const lock = readJson(lockPath);
  lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  writeJson(lockPath, lock);
}

if (require.main === module) {
  try {
    const version = process.argv[2] || process.env.VERSION;
    stampVersion(process.cwd(), version);
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  }
}

module.exports = { stampVersion };
