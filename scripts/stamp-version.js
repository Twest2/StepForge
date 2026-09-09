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

  const requested = version.replace(/^v/i, '');
  const parts = requested.split('.');
  if (parts.length < 1 || parts.length > 4 || !parts.every((part) => /^(0|[1-9]\d*)$/.test(part))) {
    throw new Error('version must be numeric major.minor.patch (or a four-part build version), for example 0.4.0 or 0.4.0.1');
  }
  // Electron Builder requires a three-component package version. Let release
  // operators enter the natural shorthand "0.4" while producing valid,
  // unambiguous package metadata (0.4.0). Four-part versions retain their
  // final component as the installer/package build label.
  const packageParts = [...parts, '0', '0'].slice(0, 3);
  const packageVersion = packageParts.join('.');
  const buildVersion = parts.length === 4 ? requested : packageVersion;

  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = packageVersion;
  pkg.buildVersion = buildVersion;
  writeJson(pkgPath, pkg);

  const lockPath = path.join(rootDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return;

  const lock = readJson(lockPath);
  lock.version = packageVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = packageVersion;
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
