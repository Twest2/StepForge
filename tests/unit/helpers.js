'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Create a unique temp directory, auto-registered for cleanup by caller. */
function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stepforge-${label}-`));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Minimal valid 1x1 red PNG, used where pixel content doesn't matter.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

module.exports = { makeTmpDir, rmrf, TINY_PNG };
