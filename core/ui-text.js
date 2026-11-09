'use strict';

const { createTranslator } = require('./i18n');
const LOCALES = require('./locales');

/**
 * Text the main process shows the person (errors, sign-in and sync
 * messages, the tray menu) in the interface language. app/main.js sets the
 * language from Settings → General → Language; until then, and in helper
 * processes such as the MCP server, it is English.
 */

let current = createTranslator('en');

/** Switch to `language` (a code from core/i18n.js); returns the code in use. */
function setUiLanguage(language) {
  current = createTranslator(language, LOCALES);
  return current.language;
}

const t = (text, params) => current.t(text, params);
const tn = (count, singular, plural, params) => current.tn(count, singular, plural, params);

/** The language in use, such as 'fr' or 'en'. */
const uiLanguage = () => current.language;

module.exports = { setUiLanguage, uiLanguage, t, tn };
