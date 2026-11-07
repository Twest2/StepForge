'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { createTranslator } = require('../../core/i18n');
const LOCALES = require('../../core/locales');
const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { qualityFindings } = require('../../core/quality');
const { buildAiPrompt, isPlaceholderTitle, defaultCaptureTitle } = require('../../core/text-intel');
const { createStep } = require('../../core/schema');
const { TextIntelService } = require('../../app/text-intel');
const CaptureService = require('../../app/capture');

/**
 * Titles StepForge gives new captures follow the interface language: the
 * words it adds ("Click", "in Notepad") are translated, and names read from
 * the screen stay as they are. Before, a Chinese user recording without AI
 * got titles such as "Click 保存 in Notepad".
 */

const translatorFor = (language) => createTranslator(language, LOCALES).t;

/** TextIntelService in `language`, titling from the pre-click window context only. */
function titler(t, language) {
  const dir = makeTmpDir(`capture-titles-${language || 'en'}`);
  t.after(() => rmrf(dir));
  const service = new TextIntelService({
    store: { settingsDir: dir },
    settings: { get: () => ({}) },
    dataDir: dir,
    windowContextProvider: {},
    translate: language ? translatorFor(language) : null,
  });
  service.ocrAroundClick = async () => ({ text: '' });
  service.collectForegroundWindowContext = async () => { throw new Error('must use the pre-click context'); };
  return async (windowContext, extra = {}) => (await service.buildCaptureContext({
    mode: 'fullscreen', clickMeta: { windowContext, ...extra },
  })).title;
}

test('a click recorded with StepForge in Chinese gets a Chinese title around the on-screen name', async (t) => {
  const title = titler(t, 'zh-CN');
  const save = { appName: 'notepad', elementLabel: '保存', elementRole: 'button' };
  assert.equal(await title(save, { button: 'left' }), '在 Notepad 中点击“保存”');
  assert.equal(await title(save, { button: 'right' }), '在 Notepad 中右键单击“保存”');
  assert.equal(await title(save, { button: 'left', double: true }), '在 Notepad 中双击“保存”');
  assert.equal(await title({ appName: 'chrome' }, { keyContext: { recentShortcut: 'Ctrl+Shift+T' } }), '在 Chrome 中重新打开已关闭的标签页');
  assert.equal(await title({ elementLabel: 'Close', elementRole: 'button', parentTabTitle: '文档', appName: 'chrome' }), '在 Chrome 中关闭“文档”标签页');
  assert.equal(await title({ elementLabel: 'Password', elementRole: 'edit', elementIsPassword: true }, { button: 'right' }), '右键单击“密码框”');
  assert.equal(await title({ elementLabel: '用户名', elementRole: 'edit' }), '在“用户名”中输入');
  // Nothing to name the step after: the default title, translated.
  assert.equal(await title({}), '屏幕截图');
});

test('each language puts the app and the action in its own word order', async (t) => {
  const save = { appName: 'notepad', elementLabel: 'Save', elementRole: 'button' };
  assert.equal(await titler(t, 'ja')(save), 'Notepad で「Save」をクリック');
  assert.equal(await titler(t, 'fr')(save), 'Cliquer sur Save dans Notepad');
  assert.equal(await titler(t, 'ru')(save, { button: 'right' }), 'Щёлкнуть правой кнопкой мыши: Save в Notepad');
  // Without a translator, or in English, titles are exactly what they were.
  assert.equal(await titler(t, null)(save), 'Click Save in Notepad');
  assert.equal(await titler(t, 'en')(save, { button: 'middle' }), 'Middle-click Save in Notepad');
});

test('a capture that cannot be titled falls back to the translated default title', async () => {
  const service = new CaptureService({
    store: {},
    settings: { get: () => undefined },
    getWindow: () => null,
    notify: () => {},
    screenApi: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getAllDisplays: () => [] },
    textIntel: { translate: translatorFor('ja'), buildCaptureContext: async () => { throw new Error('no OCR'); } },
  });
  assert.deepEqual(await service.buildStepMeta('window', null), { title: 'ウィンドウ キャプチャ', captureMetadata: null });
  assert.equal(defaultCaptureTitle('region'), 'Region capture');
});

test('a translated default title still counts as untitled, for AI and for the checks before sharing', (t) => {
  for (const language of ['fr', 'es', 'ru', 'zh-CN', 'ja']) {
    const translated = defaultCaptureTitle('fullscreen', translatorFor(language));
    assert.notEqual(translated, 'Screen capture', `${language} translates the default title`);
    assert.equal(isPlaceholderTitle(translated), true, language);
  }
  // AI writes a new title instead of polishing "屏幕截图" as if the user wrote it.
  const { prompt } = buildAiPrompt({ target: 'step', step: createStep({ title: '屏幕截图' }) });
  assert.match(prompt, /Step title: \(not set/);
  assert.doesNotMatch(prompt, /User's draft title/);

  const dir = makeTmpDir('capture-titles-quality');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Lab 5' });
  store.addStep(guide.guideId, { title: 'ウィンドウ キャプチャ', descriptionHtml: '<p>Open the lab.</p>' });
  store.addStep(guide.guideId, { title: '「保存」をクリック', descriptionHtml: '<p>Save it.</p>' });
  const titles = qualityFindings(buildRenderAst(store, guide.guideId)).filter((f) => f.kind === 'title');
  assert.deepEqual(titles.map((f) => [f.detail, f.title]), [['automatic', 'ウィンドウ キャプチャ']]);
});
