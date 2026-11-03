'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');
const { findMessages } = require('../../scripts/check-translations');
const LOCALES = require('../../core/locales');

/**
 * Screens that used to be English in every language: the Export and Publish
 * checks, cloud sync, GitHub sharing, branding, and the Export dialog's format
 * and option text.
 */

function fakeEl(spec, props, ...children) {
  return {
    spec,
    ...props,
    children: children.flat().filter((c) => c != null && c !== false),
    get text() { return this.children.map((c) => (typeof c === 'object' ? c.text : String(c))).join(''); },
  };
}

function load(language, files) {
  const context = vm.createContext({ ...rendererI18n(language), StepForgeLocales: LOCALES, setTimeout, clearTimeout });
  context.window = context;
  for (const file of ['util.js', ...files]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  }
  context.el = fakeEl;
  return context;
}

test('the things-to-check panel is translated, with plural forms', () => {
  const findings = [
    { kind: 'placeholder', names: ['Product', 'Version'] },
    { kind: 'screenshot', stepId: 's1', stepNumber: '2' },
    { kind: 'title', detail: 'automatic', title: 'Click OK', stepId: 's2', stepNumber: '3' },
  ];
  const fr = load('fr', ['quality.js']).qualityPanel(findings, () => {});
  assert.equal(fr['aria-label'], 'Points à vérifier');
  assert.equal(fr.children[0].text, '3 points à vérifier avant de partager · vous pouvez quand même exporter tel quel');
  const items = fr.children[1].children;
  assert.deepEqual(items.map((item) => item.text), [
    'Guide[[Product]], [[Version]] n’ont pas de valeur',
    'Étape 2Aucune capture',
    'Étape 3A encore le titre automatique « Click OK »',
  ]);
  assert.equal(items[1].title, 'Aller à l’étape 2');

  const ru = load('ru', ['quality.js']).qualityPanel(findings.slice(0, 2), () => {});
  assert.equal(ru.children[0].children[0], '2 пункта стоит проверить перед публикацией');
});

test('cloud services, GitHub sharing and branding text follow the interface language', () => {
  const zh = load('zh-CN', ['cloud.js']);
  const google = vm.runInContext('CLOUD_SERVICES.google', zh);
  assert.equal(google.signIn, '使用 Google 登录');
  assert.equal(google.replaceWith, '用此计算机替换 Drive');
  const nextcloud = vm.runInContext('CLOUD_SERVICES.webdav', load('ru', ['cloud.js']));
  assert.equal(nextcloud.deleteFrom, 'Удалить с сервера');
  assert.equal(load('ru', []).t('No guides {where} yet.', { where: 'в Google Drive' }), 'Пока нет руководств в Google Drive.');
  assert.equal(zh.t('No guides {where} yet.', { where: google.where }), 'Google Drive 中还没有指南。');

  const ru = load('ru', ['github.js']);
  const inHours = (hours) => new Date(Date.now() + hours * 3600000 + 60000).toISOString();
  assert.equal(ru.githubTimeLeft(inHours(2)), 'Будет удалено через 2 часа');
  assert.equal(ru.githubTimeLeft(inHours(24 * 5)), 'Будет удалено через 5 дней');
  assert.equal(ru.githubExpiryLabel(1), '1 день');
  assert.match(vm.runInContext('PUBLIC_WARNING_TEXT', ru), /^Любой, у кого есть ссылка/);
  assert.ok(!/[A-Za-z]{4,} [a-z]{4,}/.test(vm.runInContext('PUBLIC_WARNING_TEXT', ru).replace(/GitHub/g, '')), 'no English left in the warning');

  const es = load('es', ['branding.js']);
  const support = vm.runInContext('BRAND_SUPPORT', es);
  assert.deepEqual([...support[0]], ['HTML (simple y enriquecido)',
    'Logotipo, banner, colores, fuentes (las fuentes subidas se incrustan), estilo de portada, texto del pie de página y tu CSS.']);
  assert.equal(support[2][0], 'PDF', 'format names stay as they are');
});

test('a link can sit anywhere in a translated sentence', () => {
  const ja = load('ja', []);
  const link = fakeEl('button.link', {}, ja.t('the same page'));
  const parts = ja.fillNodes(ja.t('Published before. Publishing again updates {link}.'), { link });
  assert.deepEqual([...parts].map((p) => (typeof p === 'object' ? `[${p.text}]` : p)), ['公開済みです。もう一度公開すると', '[同じページ]', 'が更新されます。']);
});

test('the Export dialog’s format descriptions and option labels are translated in every language', () => {
  const exportText = [...findMessages()].filter(([, info]) => info.where.startsWith('exporters'));
  assert.ok(exportText.some(([text]) => text === 'A print-ready document with a cover page and contents.'));
  assert.ok(exportText.some(([text]) => text === 'Start with a title card'));
  for (const [code, catalog] of Object.entries(LOCALES)) {
    for (const [text] of exportText) assert.ok(catalog[text], `${code}: ${text}`);
  }
});
