'use strict';

const { LANGUAGES, createTranslator } = require('./i18n');
const LOCALES = require('./locales');

/**
 * The text StepForge itself writes into exported guides ("Contents", "Last
 * verified: …", alt text, page numbers), in the interface language the export
 * was made in (Settings → General → Language). The render AST carries that
 * language (`ast.language`, see core/renderast.js); a guide's own text is
 * left as written.
 */

const translators = new Map();

/** { t, tn, tc, language } for a language code; English for anything unknown. */
function exportTranslator(language) {
  const key = String(language || 'en');
  if (!translators.has(key)) translators.set(key, createTranslator(key, LOCALES));
  return translators.get(key);
}

/** The translator for a render AST's export language. */
function exportText(ast) {
  return exportTranslator(ast && ast.language);
}

/** The BCP 47 tag for a document's language attribute: "en-US", "zh-CN", "ja-JP". */
function languageTag(language) {
  const found = LANGUAGES.find((l) => l.code === language);
  return found ? found.store : 'en-US';
}

module.exports = { exportTranslator, exportText, languageTag };
