'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * Text outside the editor that used to be hard-coded English (issue #215):
 * the publish conflict dialog, cloud transfer progress and the private
 * details summary follow the interface language.
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
  const context = vm.createContext({ ...rendererI18n(language), StepForgeLocales: require('../../core/locales'), setTimeout, clearTimeout });
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8'), context);
  }
  context.el = fakeEl;
  return context;
}

function openConflict(language, edited, where, history) {
  const context = load(language, ['util.js']);
  let modal = null;
  context.openModal = (options) => { modal = options; return { close() {} }; };
  void context.confirmReplaceEdits({}, edited, { where: context.t(where), history: context.t(history) });
  return modal;
}

test('the publish conflict dialog is translated, including the site and who edited it', () => {
  const history = 'Confluence keeps the edited version in the page history.';
  const zh = openConflict('zh-CN', { url: 'https://wiki.example/p/1', by: 'Ana' }, 'in Confluence', history);
  assert.equal(zh.title, '页面在你发布后被编辑过');
  assert.equal(zh.body.text, '自你上次发布以来，此页面已在 Confluence 中被 Ana 编辑。发布将覆盖这些编辑。Confluence 会在页面历史中保留编辑后的版本。');
  assert.deepEqual([...zh.footer].map((b) => b.text), ['打开页面', '取消', '仍然发布']);

  const en = openConflict('en', {}, 'on the wiki', 'Wiki.js keeps the edited version in the page history.');
  assert.equal(en.body.text, 'This page was edited on the wiki since you last published. Publishing will replace those edits.Wiki.js keeps the edited version in the page history.');
  assert.deepEqual([...en.footer].map((b) => b.text), ['Cancel', 'Publish anyway'], 'no Open page without a link');
});

test('cloud transfer progress follows the interface language', () => {
  const transfer = { direction: 'upload', name: 'Onboarding', loaded: 512 * 1024, total: 2 * 1024 * 1024, bytesPerSecond: 256 * 1024 };
  assert.equal(load('en', ['util.js']).describeTransfer(transfer).detail, 'Uploading “Onboarding” — 512.0 KB of 2.0 MB · 256.0 KB/s');
  assert.equal(load('fr', ['util.js']).describeTransfer({ ...transfer, direction: 'download' }).detail,
    'Téléchargement de « Onboarding » — 512.0 KB sur 2.0 MB · 256.0 KB/s');
  assert.equal(load('zh-CN', ['util.js']).describeTransfer({ ...transfer, name: '' }).detail, '正在上传“指南”— 512.0 KB/2.0 MB · 256.0 KB/s');
});

test('the private details summary is translated with each language’s plural forms', () => {
  const review = (blurs, text, steps) => ({ blurs: Array(blurs).fill({}), text: Array(text).fill({}), steps });
  const en = load('en', ['util.js', 'privacy.js']);
  assert.equal(en.privacySummary(review(0, 0, 0)), 'No private details found.');
  assert.equal(en.privacySummary(review(2, 1, 2)), 'Blurred 2 possible private details and found 1 more in step text in 2 steps.');
  assert.equal(en.privacySummary(review(1, 0, 1)), 'Blurred 1 possible private detail in 1 step.');
  // Used to read "Found 2 mores in step text".
  assert.equal(en.privacySummary(review(0, 2, 1)), 'Found 2 possible private details in step text in 1 step.');

  const ru = load('ru', ['util.js', 'privacy.js']);
  assert.equal(ru.privacySummary(review(1, 0, 1)), 'Размыт 1 фрагмент с возможными личными данными в 1 шаге.');
  assert.equal(ru.privacySummary(review(3, 0, 5)), 'Размыто 3 фрагмента с возможными личными данными в 5 шагах.');

  assert.equal(load('ja', ['util.js', 'privacy.js']).privacySummary(review(2, 0, 2)), '2 ステップで、個人情報の可能性がある箇所を 2 件ぼかしました。');
});
