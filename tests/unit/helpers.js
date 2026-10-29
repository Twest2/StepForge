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

/**
 * The globals renderer scripts translate with, for a vm context: what
 * index.html's script tags and util.js give them in the app.
 */
function rendererI18n(language = 'en') {
  const StepForgeI18n = require('../../core/i18n');
  const { t, tn } = StepForgeI18n.createTranslator(language, require('../../core/locales'));
  return { StepForgeI18n, URLSearchParams, location: { search: `?lang=${language}` }, t, tn, uiLanguage: language, dateLocale: undefined };
}

module.exports = { makeTmpDir, rmrf, TINY_PNG, rendererI18n };
