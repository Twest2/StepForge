'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { createStep } = require('../../core/schema');
const {
  buildCaptureTitle,
  buildAiPrompt,
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
  assert.equal(title, 'Click Save');
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

test('capture titles ignore browser chrome noise in favor of OCR', () => {
  const title = buildCaptureTitle({
    mode: 'window',
    metadata: {
      windowTitle: 'Google Chrome ** PR reviews ** /chrome/tyler/autodoc',
      appName: 'Google Chrome',
    },
    ocrText: 'New tab',
  });
  // OCR wins over the noisy window title; app name is appended for context.
  assert.equal(title, 'Click New tab in Google Chrome');
});

test('tab-like roles use select when OCR identifies a tab label', () => {
  const title = buildCaptureTitle({
    mode: 'window',
    metadata: {
      elementLabel: 'New tab',
      elementRole: 'tab item',
      windowTitle: 'Google Chrome - PR reviews',
    },
    ocrText: 'New tab',
  });
  assert.equal(title, 'Select New tab');
});

test('capture titles fall back to OCR when metadata is absent', () => {
  const title = buildCaptureTitle({
    mode: 'window',
    metadata: {},
    ocrText: 'Save changes',
  });
  assert.equal(title, 'Click Save changes');
});

test('browser window title strips browser name and falls back to page title', () => {
  // OCR fails; browser window title should give something useful, not "Screen capture".
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: {
      windowTitle: 'Oracle | Cloud Applications and Cloud Platform - Google Chrome',
      appName: 'chrome',
    },
    ocrText: '',
  });
  // Stripped title "Oracle | Cloud Applications and Cloud Platform" → best fragment
  assert.ok(title !== 'Screen capture', `Expected smart title, got: ${title}`);
  assert.ok(title.toLowerCase().includes('oracle') || title.toLowerCase().includes('cloud'), `Expected oracle/cloud in title, got: ${title}`);
});

test('search query is extracted when user was typing (search step)', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { windowTitle: 'oracle - Google Search - Google Chrome', appName: 'chrome' },
    ocrText: '',
    recentTyped: 'oracle',   // user was typing → this IS the search step
  });
  assert.equal(title, 'Search for Oracle in Chrome');
});

test('search results window title produces select-result title when no typing (click on results page)', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { windowTitle: 'oracle - Google Search - Google Chrome', appName: 'chrome' },
    ocrText: '',
    recentTyped: '',         // no recent typing → user is clicking a result, not searching
  });
  assert.equal(title, 'Select a Oracle result in Chrome');
});

test('full link text with pipe separator is preserved in OCR phrases', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { elementRole: 'hyperlink' },
    ocrText: 'Oracle | Cloud Applications and Cloud Platform',
  });
  assert.equal(title, 'Select Oracle | Cloud Applications and Cloud Platform');
});

test('link element role uses Select verb', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { elementLabel: 'Sign in', elementRole: 'hyperlink' },
    ocrText: '',
  });
  assert.equal(title, 'Select Sign in');
});

test('search box element role uses Search for verb', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { elementLabel: 'oracle', elementRole: 'search box' },
    ocrText: '',
  });
  assert.equal(title, 'Search for Oracle');
});

test('keyboard shortcut produces action title qualified with app', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { appName: 'chrome' },
    ocrText: '',
    recentShortcut: 'Ctrl+T',
  });
  assert.equal(title, 'Open new tab in Chrome');
});

test('keyboard shortcut title without app name', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: {},
    ocrText: '',
    recentShortcut: 'Ctrl+S',
  });
  assert.equal(title, 'Save');
});

test('typed text with search input role produces Search for title', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { elementRole: 'search box', appName: 'chrome' },
    ocrText: '',
    recentTyped: 'oracle',
  });
  assert.equal(title, 'Search for "oracle" in Chrome');
});

test('UIAutomation element value takes priority over keyboard buffer', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { elementRole: 'edit', elementValue: 'oracle', appName: 'chrome' },
    ocrText: '',
    recentTyped: 'ignored',
  });
  // elementValue (from UIAutomation) wins over the keyboard buffer
  assert.ok(title.includes('oracle'), `expected oracle in title, got: ${title}`);
});

test('app-qualified OCR title includes app name', () => {
  const title = buildCaptureTitle({
    mode: 'fullscreen',
    metadata: { appName: 'code' },
    ocrText: 'Save',
  });
  assert.equal(title, 'Click Save in VS Code');
});

test('ai prompts include the deterministic OCR-backed title candidate', () => {
  const { prompt } = buildAiPrompt({
    captureContext: {
      windowTitle: 'Google Chrome ** PR reviews ** /chrome/tyler/autodoc',
      appName: 'Google Chrome',
      ocrText: 'New tab',
      titleCandidate: 'Click New tab',
      mode: 'content',
    },
  });

  assert.match(prompt, /Suggested title: Click New tab/);
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

test('ocr failures fall back to empty text instead of crashing', async (t) => {
  const root = makeTmpDir('text-intel-ocr-fallback');
  t.after(() => rmrf(root));
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings(),
    getWindow: () => null,
    dataDir: root,
    fetchImpl: global.fetch,
  });
  service.getWorker = async () => {
    throw new Error('tesseract missing');
  };

  const result = await service.ocrAroundClick({
    image: {},
    size: { width: 100, height: 100 },
    display: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
  }, { x: 50, y: 50 });

  assert.deepEqual(result, { text: '', confidence: null });
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
