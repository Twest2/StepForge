'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { createStep } = require('../../core/schema');
const { GuideStore } = require('../../core/store');
const { encodePng, decodePng } = require('../../core/png');
const { createImage } = require('../../core/raster');
const { renderScreenshotForAi, AI_SCREENSHOT_MAX_EDGE } = require('../../core/ai-image');
const {
  buildAiPrompt,
  buildGuideAiPrompt,
  normalizeAiPatch,
  normalizeGuidePatch,
  applyAiPatchToStep,
  applyGuidePatch,
  plainTextToHtml,
  splitPinnedParagraphs,
} = require('../../core/text-intel');
const { TextIntelService } = require('../../app/text-intel');

function makeSettings(ai = {}) {
  const data = { ai: { enabled: true, ollama: { host: 'http://127.0.0.1:11434', model: 'gemma3' }, ...ai } };
  return { get: (key) => key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), data) };
}

test('placeholder-only paragraphs stay where the user put them and are never shown to the model', () => {
  const step = createStep({ title: 'Open Canvas', descriptionHtml: '<p>[[intro]]</p><p>Open the lab.</p><p>[[stepforge]]</p>' });
  const { prompt } = buildAiPrompt({ target: 'description', step });
  assert.match(prompt, /User's draft description \(rewrite this\): "Open the lab\."/);
  assert.doesNotMatch(prompt, /\[\[stepforge\]\]|\[\[intro\]\]/);

  const patch = normalizeAiPatch('{"description":"Open the lab from the course page."}');
  const updated = applyAiPatchToStep(step, patch, { target: 'description' });
  assert.equal(updated.descriptionHtml, '<p>[[intro]]</p><p>Open the lab from the course page.</p><p>[[stepforge]]</p>');

  const guide = { guideId: 'g1', title: 'Lab 5', descriptionHtml: '<p>Old intro.</p><div>[[stepforge]]</div>' };
  const next = applyGuidePatch(guide, normalizeGuidePatch('{"title":"Submit Lab 5 in Canvas","description":"How to paste your answers."}'));
  assert.equal(next.title, 'Submit Lab 5 in Canvas');
  assert.equal(next.descriptionHtml, '<p>How to paste your answers.</p><div>[[stepforge]]</div>');

  // A description that is only a placeholder counts as empty for the model.
  assert.deepEqual(splitPinnedParagraphs('<p>[[stepforge]]</p>'), { before: ['<p>[[stepforge]]</p>'], body: '', after: [] });
});

test('block prompts list existing blocks by id and ask for at most two new ones', () => {
  const step = createStep({
    title: 'Run the installer',
    textBlocks: [{ id: 'tb9', order: 1, level: 'warn', title: 'Careful', descriptionHtml: '<p>Close other apps.</p>' }],
  });
  const { prompt } = buildAiPrompt({ target: 'blocks', step });
  assert.match(prompt, /"id": "tb9"/);
  assert.match(prompt, /"id"\?: string/);
  assert.match(prompt, /at most 2 new blocks/);
  assert.doesNotMatch(prompt, /"title": string/, 'a blocks-only request must not ask for a title');

  const titleOnly = buildAiPrompt({ target: 'title', step }).prompt;
  assert.match(titleOnly, /Do NOT include a "blocks" key/);
  assert.doesNotMatch(titleOnly, /"description": string/);
});

test('a guide prompt summarizes the steps and keeps a good existing title', () => {
  const { prompt } = buildGuideAiPrompt({
    guide: { title: 'Untitled guide', descriptionHtml: '' },
    steps: [
      { number: '1', title: 'Open Canvas', descriptionHtml: '<p>Sign in first.</p>' },
      { number: '1.1', title: 'Screen capture', descriptionHtml: '' },
    ],
  });
  assert.match(prompt, /1\. Open Canvas — Sign in first\./);
  assert.match(prompt, /1\.1\. \(untitled\)/);
  assert.match(prompt, /If the current title already says what the guide does, keep it/);
});

test('AI text keeps paragraphs and line breaks', () => {
  assert.equal(plainTextToHtml('First  line\nsecond\n\nNext <para>'), '<p>First line<br>second</p><p>Next &lt;para&gt;</p>');
  assert.equal(plainTextToHtml('   '), '');
});

test('AI screenshots are capped at the long-edge limit', (t) => {
  const dir = makeTmpDir('ai-image');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'wide.png');
  fs.writeFileSync(file, encodePng(createImage(AI_SCREENSHOT_MAX_EDGE * 2, 40)));
  const out = decodePng(renderScreenshotForAi(file, []));
  assert.equal(out.width, AI_SCREENSHOT_MAX_EDGE);
  assert.equal(out.height, 20);
  assert.equal(renderScreenshotForAi(path.join(dir, 'missing.png')), null);
});

test('writing the guide title and description summarizes its steps and never clobbers a newer edit', async (t) => {
  const dir = makeTmpDir('ai-guide');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Untitled guide', descriptionHtml: '<p>[[stepforge]]</p>' });
  store.addStep(guide.guideId, { title: 'Open Canvas', descriptionHtml: '<p>Sign in.</p>' });
  store.addStep(guide.guideId, { title: 'Hidden step', hidden: true });

  let prompt = '';
  let editDuringRequest = null;
  const service = new TextIntelService({
    store,
    settings: makeSettings(),
    dataDir: dir,
    fetchImpl: async (url, init) => {
      prompt = JSON.parse(init.body).messages[1].content;
      if (editDuringRequest) editDuringRequest();
      return { ok: true, json: async () => ({ message: { content: '{"title":"Submit a lab in Canvas","description":"Turn in a lab."}' } }) };
    },
  });

  const result = await service.generateGuidePatch({ guideId: guide.guideId });
  assert.equal(result.ok, true);
  assert.match(prompt, /1\. Open Canvas — Sign in\./);
  assert.doesNotMatch(prompt, /Hidden step/);
  const saved = store.getGuide(guide.guideId);
  assert.equal(saved.title, 'Submit a lab in Canvas');
  // The description was only the placeholder, so it stays first.
  assert.equal(saved.descriptionHtml, '<p>[[stepforge]]</p><p>Turn in a lab.</p>');

  // The user renames the guide while the model is still writing: their edit wins.
  editDuringRequest = () => store.saveGuide({ ...store.getGuide(guide.guideId), title: 'My own title' });
  const conflict = await service.generateGuidePatch({ guideId: guide.guideId });
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /nothing was overwritten/);
  assert.equal(store.getGuide(guide.guideId).title, 'My own title');
});

test('AI explains what to fix when it is off or has no model', async () => {
  const off = new TextIntelService({ store: {}, settings: makeSettings({ enabled: false }), dataDir: '.' });
  assert.match((await off.generateGuidePatch({ guideId: 'g' })).reason, /Turn on AI in Settings/);
  const noModel = new TextIntelService({ store: {}, settings: makeSettings({ ollama: { host: 'http://127.0.0.1:11434', model: '' } }), dataDir: '.' });
  assert.match((await noModel.generateStepPatch({ guideId: 'g', stepId: 's' })).reason, /Choose an Ollama host and model/);
});

test('a step that has its own title never takes the guide title from a confused model', () => {
  const patch = normalizeAiPatch('{"title":"Install StepForge","description":"Click Run anyway to continue."}');
  const titled = createStep({ title: 'Click Run anyway' });
  assert.equal(applyAiPatchToStep(titled, patch, { target: 'step', guideTitle: 'Install StepForge' }).title, 'Click Run anyway');
  // An untitled step may still get any title the model writes.
  const untitled = createStep({ title: 'Screen capture' });
  assert.equal(applyAiPatchToStep(untitled, patch, { target: 'step', guideTitle: 'Install StepForge' }).title, 'Install StepForge');
  const { prompt } = buildAiPrompt({ target: 'step', guide: { title: 'Install StepForge' }, step: titled });
  assert.match(prompt, /context only — never copy it into the step/);
});
