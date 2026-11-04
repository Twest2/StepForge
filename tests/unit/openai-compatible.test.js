'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { baseUrl, AiKeyStore } = require('../../app/openai-compatible');
const { TextIntelService } = require('../../app/text-intel');
const { GuideStore } = require('../../core/store');
const { makeTmpDir, rmrf } = require('./helpers');

/**
 * The OpenAI-compatible AI provider (app/openai-compatible.js): server URLs,
 * the encrypted API key, and chat requests through TextIntelService against
 * real local HTTP servers.
 */

function service(t, ai, fetchImpl = fetch) {
  const dir = makeTmpDir('openai');
  t.after(() => rmrf(dir));
  return new TextIntelService({ dataDir: dir, settings: { get: (key) => (key === 'ai' ? ai : undefined) }, fetchImpl, windowContextProvider: {} });
}

/** A stand-in for Electron safeStorage: reversible, but never plain text on disk. */
const keyring = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).map((b) => b ^ 91),
  decryptString: (buf) => Buffer.from(buf.map((b) => b ^ 91)).toString(),
});

/** A compatible server on 127.0.0.1 that records requests and answers with `reply`. */
async function chatServer(t, reply = '{"title":"Ready"}') {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, key: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

test('server URLs keep their API path, and a server on another computer needs the opt-in', () => {
  assert.equal(baseUrl('http://localhost:8000/proxy/v1/'), 'http://localhost:8000/proxy/v1');
  assert.throws(() => baseUrl('https://llm.internal/v1'), /another computer/);
  assert.equal(baseUrl('https://llm.internal/v1', true), 'https://llm.internal/v1');
  for (const value of ['file:///tmp/a', 'http://user:key@localhost/v1', 'http://localhost/v1?token=key', 'http://localhost/v1#x', 'not a url']) {
    assert.throws(() => baseUrl(value), undefined, value);
  }
});

test('the API key is encrypted, tied to its server URL, and can be removed', (t) => {
  const dir = makeTmpDir('ai-key');
  t.after(() => rmrf(dir));
  const keys = new AiKeyStore(dir, keyring());
  assert.equal(keys.has('http://localhost/v1'), false);
  keys.set('http://localhost/v1', 'fixture-secret');
  assert.ok(!fs.readFileSync(keys.file).includes(Buffer.from('fixture-secret')), 'never plain text on disk');
  assert.equal(keys.get('http://localhost/v1/'), 'fixture-secret');
  assert.equal(keys.has('http://localhost/v1/'), true);
  // Another URL gets no key, so editing the URL can't send it elsewhere.
  assert.equal(keys.get('http://localhost/other'), '');
  assert.equal(keys.has('http://localhost/other'), false);

  keys.set('http://localhost/v1', '');
  assert.equal(keys.has('http://localhost/v1'), false);
  assert.equal(keys.get('http://localhost/v1'), '');
});

test('has() never decrypts, and a locked keyring refuses to save or use a key', (t) => {
  const dir = makeTmpDir('ai-key');
  t.after(() => rmrf(dir));
  const keys = new AiKeyStore(dir, keyring());
  keys.set('http://localhost/v1', 'fixture-secret');
  keys.storage = { isEncryptionAvailable: () => false, decryptString: () => { throw new Error('decrypt called'); } };
  assert.equal(keys.has('http://localhost/v1'), true);
  assert.equal(keys.get('http://localhost/keyless'), '', 'a server without a saved key still works');
  assert.throws(() => keys.get('http://localhost/v1'), /keyring/);
  assert.throws(() => new AiKeyStore(dir, { isEncryptionAvailable: () => false }).set('http://localhost/v1', 'secret'), /encrypt/);
  // Electron's plain-text fallback doesn't count as encryption.
  const plain = new AiKeyStore(dir, { ...keyring(), getSelectedStorageBackend: () => 'basic_text' });
  assert.throws(() => plain.set('http://localhost/v1', 'secret'), /encrypt/);
});

test('Test connection sends a real chat request, with or without a key', async (t) => {
  const server = await chatServer(t);
  const ai = { enabled: true, provider: 'openai', openai: { baseUrl: `${server.url}/gateway/v1`, model: 'company/custom-model' } };
  const svc = service(t, ai);
  const result = await svc.testAiConnection();
  assert.equal(result.ok, true);
  assert.equal(server.requests[0].path, '/gateway/v1/chat/completions');
  assert.equal(server.requests[0].key, undefined);
  assert.equal(server.requests[0].body.model, 'company/custom-model');
  assert.equal(server.requests[0].body.stream, false);
  // A key typed in Settings but not saved yet is tried as is.
  assert.equal((await svc.testAiConnection({ openai: { apiKey: 'test-token' } })).ok, true);
  assert.equal(server.requests[1].key, 'Bearer test-token');
});

test('the saved key is sent to its server, and writing a step goes through the provider', async (t) => {
  const server = await chatServer(t);
  const url = `${server.url}/v1`;
  const ai = { enabled: true, provider: 'openai', openai: { baseUrl: url, model: 'custom' } };
  const svc = service(t, ai);
  svc.aiKeys = new AiKeyStore(makeTmpDir('ai-key'), keyring());
  svc.aiKeys.set(url, 'saved-token');
  assert.equal((await svc.testAiConnection()).ok, true);
  assert.equal(server.requests[0].key, 'Bearer saved-token');

  const ready = svc.readyAiConfig();
  assert.equal(await svc.callOllama({ ...ready, prompt: 'Write JSON', systemPrompt: 'Only JSON', images: ['cG5n'] }), '{"title":"Ready"}');
  assert.equal(server.requests.at(-1).body.messages[1].content[1].image_url.url, 'data:image/png;base64,cG5n');
  assert.equal(await svc.modelSupportsVision(ready), false);
  ai.openai.vision = true;
  assert.equal(await svc.modelSupportsVision(ready), true);

  const dir = makeTmpDir('compatible-generation');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Account setup' });
  const step = store.addStep(guide.guideId, { title: 'Review account' });
  svc.store = store;
  const generated = await svc.generateStepPatch({ guideId: guide.guideId, stepId: step.stepId, target: 'title' });
  assert.equal(generated.ok, true);
  assert.equal(store.getStep(guide.guideId, step.stepId).title, 'Ready');
});

test('errors say what to fix and never echo the key', async (t) => {
  const ai = { provider: 'openai', openai: { baseUrl: 'http://localhost/v1', model: 'custom' } };
  const cases = [
    [{ ok: false, status: 401 }, /API key/],
    [{ ok: false, status: 404 }, /\/chat\/completions/],
    [{ ok: false, status: 500 }, /500/],
    [{ ok: true, status: 200, json: async () => ({ choices: [] }) }, /message text/],
    [{ ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } }, /JSON/],
  ];
  for (const [response, reason] of cases) {
    const result = await service(t, ai, async () => response).testAiConnection({ openai: { apiKey: 'secret' } });
    assert.equal(result.ok, false);
    assert.match(result.reason, reason);
    assert.ok(!result.reason.includes('secret'));
  }
  const noModel = await service(t, { provider: 'openai', openai: { baseUrl: 'http://localhost/v1', model: '' } }).testAiConnection();
  assert.match(noModel.reason, /model name/);
});

test('requests keep cancellation, deadlines and redirect blocking', async (t) => {
  let redirect;
  const ai = { enabled: true, provider: 'openai', timeoutMs: 15, openai: { baseUrl: 'http://localhost/v1', model: 'custom' } };
  const svc = service(t, ai, (_url, opts) => {
    redirect = opts.redirect;
    return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  assert.equal((await svc.testAiConnection()).ok, false);
  assert.equal(redirect, 'error');
  assert.equal(svc.inflight.size, 0);
  ai.timeoutMs = 10000;
  const pending = svc.callOllama({ ...svc.readyAiConfig(), guideId: 'guide', prompt: 'hello', systemPrompt: 'JSON' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  svc.cancelInflight('guide');
  await assert.rejects(pending, /cancelled/);
});

test('a stalled reply times out, and a redirect never forwards the key', async (t) => {
  let redirected = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect/')) { res.writeHead(302, { Location: '/target' }); res.end(); }
    else if (req.url === '/target') { redirected++; res.end('{}'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); } // never finishes
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = `http://127.0.0.1:${server.address().port}`;
  const svc = service(t, { provider: 'openai', timeoutMs: 30, openai: { baseUrl: `${host}/slow/v1`, model: 'test' } });
  const slow = await svc.testAiConnection();
  assert.equal(slow.ok, false);
  assert.match(slow.reason, /timed out/);
  const redirect = await svc.testAiConnection({ openai: { baseUrl: `${host}/redirect/v1`, apiKey: 'fixture-key' } });
  assert.equal(redirect.ok, false);
  assert.equal(redirected, 0);
});
