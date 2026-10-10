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

const { usablePlaceholders, substitutePlaceholders, isValidPlaceholderName } = require('../../core/ai-placeholders');
const { isValidOutline, withParent, planSubsteps } = require('../../core/step-outline');
const { planOrganize } = require('../../core/ai-organize');
const { Settings } = require('../../core/settings');

test('AI uses the guide and global placeholders it is given, in descriptions only', () => {
  const placeholders = usablePlaceholders({
    globals: { Org: { format: 'markdown', text: 'TAMU' }, stepforge: { format: 'markdown', text: `*Made with StepForge.* ${'x'.repeat(90)}` } },
    guidePlaceholders: { Product: 'StepForge', Org: 'Texas A&M' },
  });
  // Guide placeholders win over global ones; paragraph-long values are never used inline.
  assert.deepEqual(placeholders.map((p) => [p.name, p.value]), [['Product', 'StepForge'], ['Org', 'Texas A&M']]);

  const step = createStep({ title: 'Screen capture' });
  const { prompt } = buildAiPrompt({ target: 'step', step, placeholders });
  assert.match(prompt, /\[\[Product\]\] = "StepForge"/);
  assert.match(prompt, /never in titles/);

  const patch = normalizeAiPatch(JSON.stringify({
    title: 'Install StepForge',
    description: 'Run the StepForge installer from Texas A&M. StepForgeX is different.',
    blocks: [{ kind: 'text', level: 'tip', body: 'Ask Texas A&M IT about StepForge.' }],
  }));
  const updated = applyAiPatchToStep(step, patch, { target: 'step', placeholders });
  assert.equal(updated.title, 'Install StepForge', 'titles keep plain text');
  assert.equal(updated.descriptionHtml, '<p>Run the [[Product]] installer from [[Org]]. StepForgeX is different.</p>');
  assert.equal(updated.textBlocks[0].descriptionHtml, '<p>Ask [[Org]] IT about [[Product]].</p>');
  assert.equal(substitutePlaceholders('<p><code>StepForge</code> [[Product]]</p>', placeholders), '<p><code>StepForge</code> [[Product]]</p>');
  assert.equal(isValidPlaceholderName('Course_Code'), true);
  assert.equal(isValidPlaceholderName('Date'), false, 'built-in names are taken');
});

test('substeps keep the outline readable top to bottom, and never reorder', () => {
  const order = ['a', 'b', 'c', 'd'];
  const flat = new Map(order.map((id) => [id, null]));
  const nested = planSubsteps(order, flat, [
    { stepId: 'c', parentId: 'b' }, { stepId: 'd', parentId: 'a' }, { stepId: 'b', parentId: 'a' }, { stepId: 'a', parentId: 'd' },
  ]);
  // b under a, then c under b; d under a is valid once b is; a can't go under a later step.
  assert.deepEqual([...nested], [['b', 'a'], ['c', 'b'], ['d', 'a']]);
  const tree = new Map([['a', null], ['b', 'a'], ['c', 'a'], ['d', null]]);
  assert.equal(isValidOutline(order, tree), true);
  assert.equal(withParent(order, tree, 'b', null), null, 'b can\'t leave while its sibling c follows');
  assert.ok(withParent(order, tree, 'c', null), 'the last substep can move back out');
  assert.equal(withParent(order, tree, 'd', 'b'), null, 'd can only nest under c or a');
  // Steps that are already substeps are left alone by AI organizing.
  assert.equal(planSubsteps(order, tree, [{ stepId: 'c', parentId: 'b' }]).size, 0);
});

test('organizing keeps only placeholders for values that really repeat', () => {
  const steps = [
    { stepId: 'a', title: 'Open Canvas', descriptionHtml: '<p>Go to canvas.tamu.edu for ECEN 350.</p>' },
    { stepId: 'b', title: 'Open the lab', descriptionHtml: '<p>In ECEN 350, open Lab 5.</p>' },
    { stepId: 'c', title: 'Resume the lab', descriptionHtml: '' },
  ];
  const plan = planOrganize(JSON.stringify({
    substeps: [{ step: 'S3', parent: 'S2' }, { step: 'S2', parent: 'S7' }],
    placeholders: [
      { name: 'Course Code', value: 'ECEN 350', scope: 'guide' },
      { name: 'Lab', value: 'Lab 5' },
      { name: 'Date', value: 'ECEN 350' },
      { name: 'Org', value: 'TAMU', scope: 'global' },
    ],
  }), { steps, parentOf: new Map(steps.map((s) => [s.stepId, null])), existing: { names: ['Org'], values: [] } });
  assert.deepEqual([...plan.parents], [['c', 'b']]);
  assert.deepEqual(plan.placeholders, [{ name: 'Course_Code', value: 'ECEN 350', scope: 'guide' }]);
});

test('the organizing pass nests steps, adds guide and global placeholders, and uses them', async (t) => {
  const dir = makeTmpDir('ai-organize');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const settings = new Settings(store.settingsDir);
  settings.set('ai', { ...settings.get('ai'), enabled: true, ollama: { host: 'http://127.0.0.1:11434', model: 'gemma3' } });
  settings.setGlobalPlaceholders({ Existing: 'Keep me' });
  const guide = store.createGuide({ title: 'Lab 5', descriptionHtml: '<p>Submit Lab 5 for ECEN 350 at Texas A&amp;M.</p>' });
  const s1 = store.addStep(guide.guideId, { title: 'Open Canvas', descriptionHtml: '<p>Open Canvas for ECEN 350 at Texas A&amp;M.</p>' });
  const s2 = store.addStep(guide.guideId, { title: 'Open Lab 5', descriptionHtml: '<p>In ECEN 350, open the lab.</p>' });
  const s3 = store.addStep(guide.guideId, { title: 'Resume the lab', descriptionHtml: '<p>Texas A&amp;M keeps your progress.</p>' });
  const service = new TextIntelService({
    store,
    settings,
    dataDir: dir,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ message: { content: JSON.stringify({
        substeps: [{ step: 'S3', parent: 'S2' }],
        placeholders: [
          { name: 'Course', value: 'ECEN 350', scope: 'guide' },
          { name: 'School', value: 'Texas A&M', scope: 'global' },
          { name: 'Existing', value: 'Open', scope: 'global' },
        ],
      }) } }),
    }),
  });
  const result = await service.organizeGuide({ guideId: guide.guideId });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.substeps, 1);
  assert.deepEqual(result.placeholders.map((p) => p.name), ['Course', 'School']);
  const saved = store.getGuide(guide.guideId);
  assert.deepEqual(saved.stepsOrder, [s1.stepId, s2.stepId, s3.stepId], 'order never changes');
  assert.equal(saved.placeholders.Course, 'ECEN 350');
  assert.deepEqual(settings.getGlobalPlaceholders(), { Existing: 'Keep me', School: { format: 'markdown', text: 'Texas A&M' } });
  assert.equal(saved.descriptionHtml, '<p>Submit Lab 5 for [[Course]] at [[School]].</p>');
  assert.equal(store.getStep(guide.guideId, s3.stepId).parentStepId, s2.stepId);
  assert.equal(store.getStep(guide.guideId, s1.stepId).descriptionHtml, '<p>Open Canvas for [[Course]] at [[School]].</p>');
  assert.equal(store.getStep(guide.guideId, s1.stepId).title, 'Open Canvas');
});

test('qwen3-vl style names count as models that read images', async () => {
  const service = new TextIntelService({ store: {}, settings: makeSettings(), dataDir: '.', fetchImpl: async () => ({ ok: false }) });
  assert.equal(await service.modelSupportsVision({ host: 'http://127.0.0.1:11434', model: 'qwen3-vl:4b' }), true);
  assert.equal(await service.modelSupportsVision({ host: 'http://127.0.0.1:11434', model: 'qwen3:4b' }), false);
});

test('automatic organizing nests one level only, even when a model chains every step', () => {
  const steps = ['a', 'b', 'c', 'd', 'e'].map((stepId) => ({ stepId, title: stepId, descriptionHtml: '' }));
  const plan = planOrganize(JSON.stringify({
    substeps: [{ step: 'S2', parent: 'S1' }, { step: 'S3', parent: 'S2' }, { step: 'S4', parent: 'S3' }, { step: 'S5', parent: 'S4' }],
  }), { steps, parentOf: new Map(steps.map((s) => [s.stepId, null])) });
  // b nests under a. c can't nest under b (a substep), so it stays top-level
  // and d nests under it; e can't nest under d, now a substep.
  assert.deepEqual([...plan.parents], [['b', 'a'], ['d', 'c']]);
});
