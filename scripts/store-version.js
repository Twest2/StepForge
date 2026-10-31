'use strict';

// Dependency-free, so the release workflow's Store submission job can use it
// without installing the packaging tools.

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

module.exports = { storeVersion };
