'use strict';

// Dependency-free, so the release workflow's Store submission job can use it
// without installing the packaging tools. The app uses it too, to compare its
// version with the one live in the Store (app/update-check.js).

/**
 * The Store version for a StepForge build version. The Store reserves the
 * fourth part and needs it to be 0, and every submission must be newer than
 * the last, so a.b.c.d becomes a.b.(c*100+d).0: 1.5.3 → 1.5.300.0 and
 * 1.5.3.1 → 1.5.301.0. Each part must fit in 16 bits.
 */
function storeVersion(buildVersion) {
  const parts = String(buildVersion || '').split('.');
  if (parts.length < 1 || parts.length > 4 || !parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part))) {
    throw new Error(`Build version ${JSON.stringify(buildVersion)} is not a numeric version.`);
  }
  const [major, minor = 0, patch = 0, revision = 0] = parts.map(Number);
  if (revision > 99) throw new Error(`Build version ${buildVersion}: the fourth part must be below 100 for the Store version.`);
  const build = patch * 100 + revision;
  if ([major, minor, build].some((n) => n > 65535)) throw new Error(`Build version ${buildVersion} does not fit a Store version.`);
  return `${major}.${minor}.${build}.0`;
}

/** The StepForge version a Store version stands for: 1.5.300.0 → 1.5.3, 1.5.301.0 → 1.5.3.1. Null if it isn't one. */
function versionFromStore(storeVersionText) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0$/.exec(String(storeVersionText || ''));
  if (!match) return null;
  const build = Number(match[3]);
  const [patch, revision] = [Math.floor(build / 100), build % 100];
  return [match[1], match[2], patch, ...(revision ? [revision] : [])].join('.');
}

module.exports = { storeVersion, versionFromStore };
