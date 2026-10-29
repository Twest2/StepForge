'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LANGUAGES, createTranslator, matchLocale, resolveLanguage } = require('../../core/i18n');
const LOCALES = require('../../core/locales');
const { DEFAULT_SETTINGS } = require('../../core/settings');

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('the six interface languages, English first, each with a Store language tag', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.code), ['en', 'fr', 'es', 'ru', 'zh-CN', 'ja']);
  assert.deepEqual(LANGUAGES.map((l) => l.store), ['en-US', 'fr-FR', 'es-ES', 'ru-RU', 'zh-CN', 'ja-JP']);
  assert.deepEqual(Object.keys(LOCALES).sort(), LANGUAGES.slice(1).map((l) => l.code).sort());
  assert.equal(DEFAULT_SETTINGS.language, 'system');
});

test('system locales map to the closest language StepForge has', () => {
  assert.equal(matchLocale('fr-CA'), 'fr');
  assert.equal(matchLocale('es_MX'), 'es');
  assert.equal(matchLocale('ru'), 'ru');
  assert.equal(matchLocale('zh-CN'), 'zh-CN');
  assert.equal(matchLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(matchLocale('zh-TW'), null, 'Traditional Chinese is not translated');
  assert.equal(matchLocale('zh-Hant-HK'), null);
  assert.equal(matchLocale('ja-JP'), 'ja');
  assert.equal(matchLocale('de-DE'), null);
  assert.equal(matchLocale(''), null);
});

test('a chosen language wins; System default takes the first supported OS language, else English', () => {
  assert.equal(resolveLanguage('ja', ['fr-FR']), 'ja');
  assert.equal(resolveLanguage('system', ['de-DE', 'es-ES', 'fr-FR']), 'es');
  assert.equal(resolveLanguage('system', ['de-DE']), 'en');
  assert.equal(resolveLanguage('system', []), 'en');
  assert.equal(resolveLanguage('klingon', ['ru-RU']), 'ru', 'an unknown setting acts like System default');
});

test('text is translated with its placeholders filled, and falls back to English', () => {
  const { t, language } = createTranslator('fr', LOCALES);
  assert.equal(language, 'fr');
  assert.equal(t('Settings'), 'Paramètres');
  assert.equal(t('Move to {folder}', { folder: 'Docs' }), 'Déplacer vers Docs');
  assert.equal(t('Text no catalog has yet'), 'Text no catalog has yet');
  assert.equal(t('Hello {name}', { name: 'Ana' }), 'Hello Ana');
  assert.equal(t('Hello {name}'), 'Hello {name}', 'a missing value leaves the placeholder');
  const english = createTranslator('en', LOCALES);
  assert.equal(english.t('Settings'), 'Settings');
  assert.equal(createTranslator('xx', LOCALES).language, 'en');
});

test('counted text uses each language’s plural forms', () => {
  const en = createTranslator('en', LOCALES);
  assert.equal(en.tn(1, '{count} guide', '{count} guides'), '1 guide');
  assert.equal(en.tn(3, '{count} guide', '{count} guides'), '3 guides');
  const ru = createTranslator('ru', LOCALES);
  assert.equal(ru.tn(1, '{count} step', '{count} steps'), '1 шаг');
  assert.equal(ru.tn(3, '{count} step', '{count} steps'), '3 шага');
  assert.equal(ru.tn(5, '{count} step', '{count} steps'), '5 шагов');
  assert.equal(ru.tn(21, '{count} step', '{count} steps'), '21 шаг');
  const fr = createTranslator('fr', LOCALES);
  assert.equal(fr.tn(1, '{count} step', '{count} steps'), '1 étape');
  assert.equal(fr.tn(2, '{count} step', '{count} steps'), '2 étapes');
  assert.equal(createTranslator('ja', LOCALES).tn(2, '{count} step', '{count} steps'), '2 ステップ');
  assert.equal(fr.tn(2, 'Uncounted {count} thing', 'Uncounted {count} things'), 'Uncounted 2 things');
});

test('every catalog has the same text, with the same placeholders as the English', () => {
  const keys = Object.keys(LOCALES.fr).sort();
  for (const [code, catalog] of Object.entries(LOCALES)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, `${code} has the same keys as fr`);
    const rules = new Intl.PluralRules(code);
    for (const [key, value] of Object.entries(catalog)) {
      if (typeof value === 'string') {
        assert.ok(value.trim(), `${code}: ${key} is empty`);
        assert.deepEqual(placeholders(value), placeholders(key), `${code}: ${key}`);
        continue;
      }
      assert.ok(value.other, `${code}: ${key} has an "other" form`);
      for (const n of [0, 1, 2, 3, 5, 11, 21, 22, 25, 100]) {
        assert.ok(value[rules.select(n)] || value.other, `${code}: ${key} has a form for ${n}`);
      }
      for (const form of Object.values(value)) {
        const want = placeholders(key).filter((name) => name !== 'count');
        assert.deepEqual(placeholders(form).filter((name) => name !== 'count'), want, `${code}: ${key} → ${form}`);
      }
    }
  }
});

test('the renderer shows the language index.html was loaded with', () => {
  const load = (search) => {
    const context = vm.createContext({ URLSearchParams, location: { search } });
    context.window = context; // as in the page, where the script tags attach to window
    for (const file of ['core/i18n.js', 'core/locales/fr.js', 'core/locales/ja.js', 'app/renderer/util.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), context);
    }
    return vm.runInContext('({ settings: t("Settings"), language: uiLanguage, dateLocale, guides: tn(2, "{count} guide", "{count} guides") })', context);
  };
  const fr = load('?lang=fr');
  assert.equal(fr.settings, 'Paramètres');
  assert.equal(fr.language, 'fr');
  assert.equal(fr.dateLocale, 'fr');
  assert.equal(fr.guides, '2 guides');
  assert.equal(load('?lang=ja').settings, '設定');
  const en = load('');
  assert.equal(en.settings, 'Settings');
  assert.equal(en.dateLocale, undefined, 'English dates keep the system’s format');
});
