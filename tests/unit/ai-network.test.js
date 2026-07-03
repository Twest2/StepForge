'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { isLoopbackHost, validateOllamaHost } = require('../../core/text-intel');
const { TextIntelService } = require('../../app/text-intel');
const CaptureService = require('../../app/capture');

function makeSettings(ai = {}) {
  const data = {
    ai: {
      enabled: true,
      allowRemoteHost: false,
      attachScreenshots: true,
      timeoutMs: 60000,
      maxImageBytes: 12 * 1024 * 1024,
      ollama: { host: 'http://127.0.0.1:11434', model: 'llama3.2:1b' },
      ...ai,
      ollama: { host: 'http://127.0.0.1:11434', model: 'llama3.2:1b', ...(ai.ollama || {}) },
    },
  };
  return {
    get(key) {
      return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), data);
    },
  };
}

// ---- loopback policy (pure core) -------------------------------------------

test('isLoopbackHost recognizes local addresses and rejects remote ones', () => {
  for (const host of [
    'http://127.0.0.1:11434',
    '127.0.0.1',
    'localhost:11434',
    'http://[::1]:11434',
    'http://127.5.6.7',
    '0.0.0.0',
  ]) {
    assert.equal(isLoopbackHost(host), true, `loopback: ${host}`);
  }
  for (const host of [
    'http://10.0.0.5:11434',
    'http://192.168.1.20',
    'https://ollama.example.com',
    'http://8.8.8.8',
    'http://ollama.internal',
  ]) {
    assert.equal(isLoopbackHost(host), false, `remote: ${host}`);
  }
});

test('validateOllamaHost blocks remote hosts unless explicitly allowed', () => {
  assert.equal(validateOllamaHost('http://127.0.0.1:11434').ok, true);
  const blocked = validateOllamaHost('http://10.0.0.5:11434');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /remote/i);
  assert.equal(validateOllamaHost('http://10.0.0.5:11434', { allowRemote: true }).ok, true);
  assert.equal(validateOllamaHost('').ok, false);
  assert.equal(validateOllamaHost('ftp://127.0.0.1').ok, false);
});

// ---- host policy enforced by the service -----------------------------------

test('AI connection test refuses a remote host without the opt-in', async (t) => {
  const root = makeTmpDir('ai-remote-block');
  t.after(() => rmrf(root));
  let called = false;
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings({ ollama: { host: 'http://10.0.0.5:11434', model: 'llama3.2:1b' } }),
    dataDir: root,
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  const result = await service.testAiConnection();
  assert.equal(result.ok, false);
  assert.match(result.reason, /remote/i);
  assert.equal(called, false, 'must not contact a blocked host at all');
});

test('AI connection test allows a remote host with the opt-in', async (t) => {
  const root = makeTmpDir('ai-remote-allow');
  t.after(() => rmrf(root));
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings({
      allowRemoteHost: true,
      ollama: { host: 'http://10.0.0.5:11434', model: 'llama3.2:1b' },
    }),
    dataDir: root,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/tags') return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:1b' }] }) };
      if (pathname === '/api/show') return { ok: true, json: async () => ({ capabilities: ['vision'] }) };
      throw new Error(`unexpected ${pathname}`);
    },
  });
  const result = await service.testAiConnection();
  assert.equal(result.ok, true);
  assert.equal(result.host, 'http://10.0.0.5:11434');
});

// ---- request timeout / cancellation ----------------------------------------

test('a hung endpoint times out instead of hanging forever', async (t) => {
  const root = makeTmpDir('ai-timeout');
  t.after(() => rmrf(root));
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings({ timeoutMs: 40 }),
    dataDir: root,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      // Never resolves on its own; only the abort signal ends it.
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  const result = await service.testAiConnection();
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out|timeout/i);
});

test('cancelInflight aborts an outstanding request', async (t) => {
  const root = makeTmpDir('ai-cancel');
  t.after(() => rmrf(root));
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: makeSettings({ timeoutMs: 60000 }),
    dataDir: root,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  const pending = service.testAiConnection();
  // Give the request a tick to register in the inflight set.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(service.inflight.size, 1);
  service.cancelInflight();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.reason, /cancel/i);
});

// ---- typed-text capture is off by default ----------------------------------

function makeCaptureService(settingsOverrides = {}) {
  const settingsData = { 'capture.mode': 'fullscreen', ...settingsOverrides };
  return new CaptureService({
    store: {},
    settings: { get: (k) => (k in settingsData ? settingsData[k] : null) },
    getWindow: () => null,
    notify: () => {},
    screenApi: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getAllDisplays: () => [] },
  });
}

test('raw typed text is ignored unless explicitly enabled', () => {
  const off = makeCaptureService();
  off.onKeyboardEvent('CHAR', 'h'.charCodeAt(0), Date.now());
  off.onKeyboardEvent('CHAR', 'i'.charCodeAt(0), Date.now());
  assert.equal(off.snapshotKeyContext().recentTyped, '', 'typed text must not be buffered by default');

  const on = makeCaptureService({ 'capture.captureTypedText': true });
  on.onKeyboardEvent('CHAR', 'h'.charCodeAt(0), Date.now());
  on.onKeyboardEvent('CHAR', 'i'.charCodeAt(0), Date.now());
  assert.equal(on.snapshotKeyContext().recentTyped, 'hi');
});

test('shortcut detection still works with typed text disabled', () => {
  const off = makeCaptureService();
  off.onKeyboardEvent('KEY', 'Ctrl+T', Date.now());
  assert.equal(off.snapshotKeyContext().recentShortcut, 'Ctrl+T');
});

// ---- source-level guards ----------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');

test('the Windows keyboard hook only emits characters when opted in', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/capture.js'), 'utf8');
  // The CHAR emission must be guarded by the opt-in flag threaded into C#.
  assert.match(src, /CaptureTypedText = \$\{captureTypedText\}/);
  assert.match(src, /else if \(CaptureTypedText\) \{/);
});
