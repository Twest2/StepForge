'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { createStep } = require('../../core/schema');
const {
  buildCaptureTitle,
  normalizeAiPatch,
  applyAiPatchToStep,
} = require('../../core/text-intel');
const { TextIntelService } = require('../../app/text-intel');

function makeSettings(values = {}) {
  const data = {
    ai: {
      enabled: true,
      ollama: {
        host: 'http://127.0.0.1:11434',
        model: 'llama3.2:1b',
      },
    },
    ...values,
  };
  return {
    get(key) {
      return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), data);
    },
  };
}

test('capture titles prefer semantic metadata before OCR fallback', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { windowTitle: 'Reset user password in admin portal' },
    ocrText: 'Save',
  });
  assert.equal(title, 'Open Reset user password in admin portal');
});

test('capture titles prefer element metadata before window chrome and OCR', () => {
  const title = buildCaptureTitle({
    mode: 'window',
    metadata: {
      elementLabel: 'Open advanced settings',
      windowTitle: 'Preferences',
    },
    ocrText: 'Cancel',
  });
  assert.equal(title, 'Open advanced settings');
});

test('capture titles fall back to OCR when metadata is absent', () => {
  const title = buildCaptureTitle({
    mode: 'window',
    metadata: {},
    ocrText: 'Save changes',
  });
  assert.equal(title, 'Click Save changes');
});

test('ocr crop rectangles clamp to the image bounds', (t) => {
  const root = makeTmpDir('text-intel-crop');
  t.after(() => rmrf(root));
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings(),
    getWindow: () => null,
    dataDir: root,
    fetchImpl: global.fetch,
  });

  const frame = {
    size: { width: 1000, height: 500 },
    display: { bounds: { x: 0, y: 0, width: 1000, height: 500 } },
  };

  const topLeft = service.cropRectForPoint(frame, { x: 5, y: 5 });
  assert.deepEqual(topLeft, { x: 0, y: 0, width: 420, height: 220 });

  const bottomRight = service.cropRectForPoint(frame, { x: 995, y: 495 });
  assert.deepEqual(bottomRight, { x: 580, y: 280, width: 420, height: 220 });
});

test('ai response normalization and application keeps fields structured', () => {
  const patch = normalizeAiPatch(JSON.stringify({
    title: 'Open settings',
    description: 'Pick the AI tab.',
    blocks: [
      {
        kind: 'text',
        position: 'after-description',
        level: 'tip',
        title: 'Tip',
        body: 'Use the local Ollama model.',
      },
      {
        kind: 'code',
        language: 'bash',
        code: 'ollama pull llama3.2:1b',
      },
      {
        kind: 'table',
        rows: [['Name', 'Value'], ['Host', '127.0.0.1']],
      },
    ],
  }));

  const step = createStep({
    title: 'Old title',
    descriptionHtml: '<p>Old text</p>',
    textBlocks: [{ id: 'tb1', order: 1, position: 'after-description', level: 'info', title: 'Old tip', descriptionHtml: '<p>Old body</p>' }],
    codeBlocks: [{ id: 'cb1', order: 2, language: 'text', code: 'old' }],
    tableBlocks: [{ id: 'tbl1', order: 3, rows: [['x']] }],
  });

  const updated = applyAiPatchToStep(step, patch, { target: 'all' });
  assert.equal(updated.title, 'Open settings');
  assert.equal(updated.descriptionHtml, '<p>Pick the AI tab.</p>');
  assert.equal(updated.textBlocks.length, 1);
  assert.equal(updated.textBlocks[0].level, 'success');
  assert.equal(updated.textBlocks[0].descriptionHtml, '<p>Use the local Ollama model.</p>');
  assert.equal(updated.codeBlocks[0].code, 'ollama pull llama3.2:1b');
  assert.deepEqual(updated.tableBlocks[0].rows, [['Name', 'Value'], ['Host', '127.0.0.1']]);
});

test('ollama connection test reports installed models', async (t) => {
  const root = makeTmpDir('text-intel-ai');
  t.after(() => rmrf(root));
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings(),
    getWindow: () => null,
    dataDir: root,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.2:1b' },
          { name: 'qwen3:0.6b' },
        ],
      }),
    }),
  });

  const result = await service.testAiConnection();
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.equal(result.model, 'llama3.2:1b');
});

test('invalid ollama output fails safely without saving the step', async (t) => {
  const root = makeTmpDir('text-intel-ai-invalid');
  t.after(() => rmrf(root));
  let saveCalls = 0;
  const step = createStep({
    title: 'Old title',
    descriptionHtml: '<p>Old text</p>',
  });
  const service = new TextIntelService({
    store: {
      settingsDir: root,
      getGuide: () => ({ guideId: 'g1', title: 'Guide', descriptionHtml: '', stepsOrder: ['s1'] }),
      getStep: () => step,
      stepImagePath: () => null,
      saveStep: () => {
        saveCalls += 1;
        throw new Error('save should not be called');
      },
    },
    settings: makeSettings(),
    getWindow: () => null,
    dataDir: root,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: 'not json at all',
        },
      }),
    }),
  });

  const result = await service.generateStepPatch({
    guideId: 'g1',
    stepId: 's1',
    target: 'all',
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /JSON/i);
  assert.equal(saveCalls, 0);
  assert.equal(step.title, 'Old title');
});
