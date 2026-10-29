'use strict';

/**
 * Interface languages: Settings → General → Language.
 *
 * The English text is the key: code calls t('Settings') and each catalog in
 * core/locales/ maps that text to its translation. Text a catalog doesn't
 * have yet shows in English, so a missing translation never breaks the UI.
 * `{name}` in a text is filled from the params object. Text that changes with
 * a number uses tn(count, singular, plural), and its catalog entry is an
 * object with one string per plural category of that language (Intl.PluralRules).
 *
 * The main process and the sandboxed renderer (which loads this file and the
 * catalogs with script tags) share it. Exported guides stay in English.
 */

(function attachI18n(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StepForgeI18n = api;
  }
})(typeof window !== 'undefined' ? window : null, () => {
  // `store` is the Microsoft Store language tag (appxmanifest Resources).
  const LANGUAGES = [
    { code: 'en', name: 'English', store: 'en-US' },
    { code: 'fr', name: 'Français', store: 'fr-FR' },
    { code: 'es', name: 'Español', store: 'es-ES' },
    { code: 'ru', name: 'Русский', store: 'ru-RU' },
    { code: 'zh-CN', name: '简体中文', store: 'zh-CN' },
    { code: 'ja', name: '日本語', store: 'ja-JP' },
  ];
  const CODES = LANGUAGES.map((l) => l.code);

  /** The supported language for a locale such as "fr-CA" or "zh-Hans-CN", or null. */
  function matchLocale(locale) {
    const tag = String(locale || '').toLowerCase().replace(/_/g, '-');
    if (!tag) return null;
    const exact = CODES.find((code) => code.toLowerCase() === tag);
    if (exact) return exact;
    const [base] = tag.split('-');
    // Only Simplified Chinese is translated: Traditional Chinese readers get English.
    if (base === 'zh') return /-(hant|tw|hk|mo)(-|$)/.test(tag) ? null : 'zh-CN';
    return CODES.find((code) => code === base) || null;
  }

  /**
   * The language to show. `setting` is a language code or 'system'; with
   * 'system', the first of the OS's preferred languages that StepForge has.
   */
  function resolveLanguage(setting, systemLocales = []) {
    if (CODES.includes(setting)) return setting;
    for (const locale of systemLocales || []) {
      const match = matchLocale(locale);
      if (match) return match;
    }
    return 'en';
  }

  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] == null ? whole : String(params[name])));
  }

  /**
   * { t, tn, language } for `language`. `catalogs` maps a language code to
   * its messages.
   */
  function createTranslator(language, catalogs = {}) {
    const code = CODES.includes(language) ? language : 'en';
    const messages = (code !== 'en' && catalogs[code]) || {};
    let plurals = null;
    const category = (count) => {
      plurals = plurals || new Intl.PluralRules(code);
      return plurals.select(count);
    };
    const t = (text, params) => {
      const found = messages[text];
      return fill(typeof found === 'string' && found ? found : text, params);
    };
    // `plural` is the key; `{count}` is filled in unless params set it.
    const tn = (count, singular, plural, params) => {
      const values = { count, ...params };
      const found = messages[plural];
      if (found && typeof found === 'object') {
        const form = found[category(count)] || found.other;
        if (form) return fill(form, values);
      }
      return fill(count === 1 ? singular : plural, values);
    };
    return { t, tn, language: code };
  }

  return { LANGUAGES, createTranslator, matchLocale, resolveLanguage };
});
