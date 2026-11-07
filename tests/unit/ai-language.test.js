'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { createStep } = require('../../core/schema');
const { buildAiPrompt, buildGuideAiPrompt } = require('../../core/text-intel');
const { LANGUAGES } = require('../../core/i18n');
const { TextIntelService } = require('../../app/text-intel');

/**
 * AI writes in StepForge's interface language (core/i18n.js). The prompts are English
 * and capture titles are built from English templates, so unless every
 * request names the language, models answer half in English and half in the
 * user's own language (GitHub discussion #188).
 */

function settingsFor(dir, ai) {
  const settings = new Settings(dir);
  settings.set('ai', { ...settings.get('ai'), enabled: true, ...ai });
  return settings;
}

/** A fake AI server for either provider; records each request's two messages. */
function recordingFetch(reply) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const [system, user] = JSON.parse(init.body).messages;
    requests.push({ url: String(url), system: system.content, user: user.content });
    const content = typeof reply === 'function' ? reply(String(url)) : reply;
    return { ok: true, status: 200, json: async () => ({ message: { content }, choices: [{ message: { content } }] }) };
  };
  return { requests, fetchImpl };
}

for (const provider of ['ollama', 'openai']) {
  test(`with StepForge in Chinese, ${provider} is told to write steps and the guide in Chinese and to translate English capture titles`, async (t) => {
    const dir = makeTmpDir(`ai-language-${provider}`);
    t.after(() => rmrf(dir));
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'Untitled guide' });
    // The title StepForge built at capture time: an English template around a Chinese button name.
    const step = store.addStep(guide.guideId, { title: 'Click 保存', descriptionHtml: '' });
    const { requests, fetchImpl } = recordingFetch('{"title":"点击“保存”","description":"保存文件。"}');
    const service = new TextIntelService({
      store,
      settings: settingsFor(dir, { provider, openai: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'deepseek-chat' } }),
      dataDir: dir,
      fetchImpl,
      getInterfaceLanguage: () => 'zh-CN',
    });

    const stepResult = await service.generateStepPatch({ guideId: guide.guideId, stepId: step.stepId, target: 'step' });
    assert.equal(stepResult.ok, true, stepResult.reason);
    const guideResult = await service.generateGuidePatch({ guideId: guide.guideId });
    assert.equal(guideResult.ok, true, guideResult.reason);

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, provider === 'openai' ? /\/v1\/chat\/completions$/ : /\/api\/chat$/);
    for (const { system, user } of requests) {
      assert.match(system, /Write every text value in Simplified Chinese; keep the JSON keys exactly as the schema names them/);
      assert.match(user, /- Write in Simplified Chinese\. Where .* use another language, translate them into Simplified Chinese\./);
      assert.match(user, /\(these examples are English; write yours in Simplified Chinese\)/);
      assert.match(user, /Do not translate the names of buttons, menus, fields and windows as they appear on screen/);
    }
    // The capture title counts as the user's draft, and the model may now translate it.
    assert.match(requests[0].user, /User's draft title \(rewrite this\): "Click 保存"/);
    assert.match(requests[0].user, /translate it if it is not in Simplified Chinese/);
    assert.equal(store.getStep(guide.guideId, step.stepId).title, '点击“保存”');
  });
}

test('every interface language is named in the prompts, and an unknown one writes English', () => {
  const step = createStep({ title: 'Screen capture' });
  const names = LANGUAGES.map(({ code }) => /Write every text value in ([A-Za-z ]+);/.exec(buildAiPrompt({ target: 'step', step, language: code }).systemPrompt)[1]);
  assert.deepEqual(names, ['English', 'French', 'Spanish', 'Russian', 'Simplified Chinese', 'Japanese']);
  assert.match(buildAiPrompt({ target: 'step', step, language: 'xx' }).systemPrompt, /in English;/);
});

test('AI follows the interface language as it changes, and a service built without one writes English', async (t) => {
  const dir = makeTmpDir('ai-language-switch');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Lab 5' });
  store.addStep(guide.guideId, { title: 'Open Canvas' });
  const { requests, fetchImpl } = recordingFetch('{"title":"Lab 5","description":"Open the lab."}');
  let ui = 'ja';
  const service = new TextIntelService({ store, settings: settingsFor(dir, {}), dataDir: dir, fetchImpl, getInterfaceLanguage: () => ui });
  await service.generateGuidePatch({ guideId: guide.guideId });
  ui = 'fr';
  await service.generateGuidePatch({ guideId: guide.guideId });
  await new TextIntelService({ store, settings: settingsFor(dir, {}), dataDir: dir, fetchImpl }).generateGuidePatch({ guideId: guide.guideId });
  assert.deepEqual(requests.map((r) => /in ([A-Za-z ]+);/.exec(r.system)[1]), ['Japanese', 'French', 'English']);
});

test('English prompts name the language without noting that their examples are English', () => {
  const step = createStep({ title: 'Screen capture' });
  const { systemPrompt, prompt } = buildAiPrompt({ target: 'step', step });
  assert.match(systemPrompt, /Write every text value in English/);
  assert.match(prompt, /- Write in English\./);
  assert.match(prompt, /"Click Save", "Select New document", "Open Settings"\.$/m);
  assert.doesNotMatch(prompt, /these examples are English/);

  const french = buildGuideAiPrompt({ guide: { title: 'Lab 5' }, steps: [], language: 'fr' });
  assert.match(french.systemPrompt, /in French;/);
  assert.match(french.prompt, /keep it and only fix its grammar, translating it if it is not in French/);
});
