'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { baseUrl, AiKeyStore, suggestModel, serverMessage } = require('../../app/openai-compatible');
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

/**
 * A compatible server on 127.0.0.1 that records chat requests and answers
 * with `reply`. `models` is its /models list (null: it has none). `answer`
 * can replace the chat reply: (request) => { status, body } or undefined.
 */
async function chatServer(t, reply = '{"title":"Ready"}', { models = null, answer = null } = {}) {
  const requests = [];
  const listed = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      listed.push({ path: req.url, key: req.headers.authorization });
      if (!models) { res.statusCode = 404; res.end('{"error":{"message":"Not found"}}'); return; }
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    const request = { path: req.url, key: req.headers.authorization, body: JSON.parse(body) };
    requests.push(request);
    const custom = answer && answer(request);
    if (custom) { res.statusCode = custom.status; res.end(custom.body); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, listed, url: `http://127.0.0.1:${server.address().port}` };
}

/** A fetch stand-in that answers every request with this status and body. */
const answering = (status, body) => async () => new Response(body, { status });

test('server URLs keep their API path, on this computer or another', () => {
  assert.equal(baseUrl('http://localhost:8000/proxy/v1/'), 'http://localhost:8000/proxy/v1');
  assert.equal(baseUrl('https://llm.internal/v1'), 'https://llm.internal/v1');
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
    [401, '', /API key/],
    [404, '', /\/chat\/completions/],
    [500, '', /500/],
    [200, JSON.stringify({ choices: [] }), /message text/],
    [200, 'not JSON', /JSON/],
  ];
  for (const [status, body, reason] of cases) {
    const result = await service(t, ai, answering(status, body)).testAiConnection({ openai: { apiKey: 'secret' } });
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

test('the temperature is sent as set, or left out for the model default, by both providers', async (t) => {
  const server = await chatServer(t);
  const ai = { enabled: true, provider: 'openai', openai: { baseUrl: `${server.url}/v1`, model: 'custom' } };
  const svc = service(t, ai);
  await svc.callOllama({ ...svc.readyAiConfig(), prompt: 'p', systemPrompt: 's' });
  assert.equal(server.requests.at(-1).body.temperature, 0.2, 'missing setting: the default');
  ai.temperature = 0.7;
  await svc.callOllama({ ...svc.readyAiConfig(), prompt: 'p', systemPrompt: 's' });
  assert.equal(server.requests.at(-1).body.temperature, 0.7);
  ai.temperature = null;
  await svc.callOllama({ ...svc.readyAiConfig(), prompt: 'p', systemPrompt: 's' });
  assert.ok(!('temperature' in server.requests.at(-1).body), 'model default: no temperature at all');
  // Test connection tries the unsaved choice in Settings.
  ai.temperature = 0.2;
  assert.equal((await svc.testAiConnection({ temperature: null })).ok, true);
  assert.ok(!('temperature' in server.requests.at(-1).body));
  assert.equal((await svc.testAiConnection({ temperature: 1.5 })).ok, true);
  assert.equal(server.requests.at(-1).body.temperature, 1.5);

  const sent = [];
  const ollama = service(t, { enabled: true, provider: 'ollama', temperature: null, ollama: { host: 'http://127.0.0.1:11434', model: 'llama3.2' } }, async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 });
  });
  await ollama.callOllama({ ...ollama.readyAiConfig(), prompt: 'p', systemPrompt: 's' });
  assert.ok(!('options' in sent[0]), 'Ollama gets no temperature for the model default');
  ollama.settings = { get: (key) => (key === 'ai' ? { enabled: true, provider: 'ollama', temperature: 1, ollama: { host: 'http://127.0.0.1:11434', model: 'llama3.2' } } : undefined) };
  await ollama.callOllama({ ...ollama.readyAiConfig(), prompt: 'p', systemPrompt: 's' });
  assert.deepEqual(sent[1].options, { temperature: 1 });
});

test('a model that refuses the temperature is named as the cause, with the server’s own words', async (t) => {
  // What a LiteLLM gateway in front of Azure OpenAI answers for a reasoning model.
  const detail = '🚫 **Invalid Request Error**\n\nlitellm.BadRequestError: AzureException BadRequestError - Unsupported value: \'temperature\' does not support 0.2 with this model. Only the default (1) value is supported.. Received Model Group=gpt-5.6-terra\nAvailable Model Group Fallbacks=None\n\n*Error Code: 400*';
  const server = await chatServer(t, '{"title":"Ready"}', {
    models: ['protected.gpt-5.6-terra'],
    answer: (request) => ('temperature' in request.body ? { status: 400, body: JSON.stringify({ detail }) } : undefined),
  });
  const ai = { enabled: true, provider: 'openai', openai: { baseUrl: `${server.url}/openai`, model: 'protected.gpt-5.6-terra' } };
  const svc = service(t, ai);
  const result = await svc.testAiConnection({ openai: { apiKey: 'fixture-key' } });
  assert.equal(result.ok, false);
  assert.equal(result.diagnosis.kind, 'temperature');
  assert.equal(result.diagnosis.status, 400);
  assert.equal(result.diagnosis.temperature, 0.2);
  assert.equal(result.diagnosis.url, `${server.url}/openai/chat/completions`);
  assert.match(result.reason, /doesn’t accept a temperature of 0\.2.*Model default/);
  assert.match(result.diagnosis.serverMessage, /^🚫 Invalid Request Error litellm\.BadRequestError: .*Only the default \(1\) value is supported\..* Error Code: 400$/);
  assert.equal((await svc.testAiConnection({ temperature: null })).ok, true, 'Model default fixes it');

  // Writing a step says the same, so the toast tells the user what to change.
  ai.apiKey = undefined;
  await assert.rejects(svc.callOllama({ ...svc.readyAiConfig(), prompt: 'p', systemPrompt: 's' }), /Set Temperature to Model default in Settings → AI/);
});

test('a model name the server does not list is explained, with the listed name it probably means', async (t) => {
  // The gateway refuses (403) a model it doesn't know, which looks like a key problem.
  const models = ['protected.gpt-5.6-terra', 'protected.gpt-4.1', 'protected.Claude Sonnet 4.6'];
  const server = await chatServer(t, '{"title":"Ready"}', {
    models,
    answer: (request) => (models.includes(request.body.model) ? undefined : { status: 403, body: '{"detail":"403: Forbidden"}' }),
  });
  const ai = { enabled: true, provider: 'openai', temperature: null, openai: { baseUrl: `${server.url}/openai`, model: 'gpt-5.6-terra' } };
  const svc = service(t, ai);
  const result = await svc.testAiConnection({ openai: { apiKey: 'fixture-key' } });
  assert.equal(result.ok, false);
  assert.equal(result.diagnosis.kind, 'model');
  assert.equal(result.diagnosis.status, 403);
  assert.equal(result.diagnosis.suggestion, 'protected.gpt-5.6-terra');
  assert.deepEqual(result.diagnosis.models, models);
  assert.equal(result.reason, 'The server has no model named “gpt-5.6-terra”. Did you mean “protected.gpt-5.6-terra”?');
  assert.equal(server.listed[0].key, 'Bearer fixture-key', 'the model list is asked for with the same key');

  const nothingClose = await svc.testAiConnection({ openai: { model: 'llama-70b', apiKey: 'fixture-key' } });
  assert.equal(nothingClose.diagnosis.suggestion, null);
  assert.match(nothingClose.reason, /Choose one of the models it lists/);

  const ok = await svc.testAiConnection({ openai: { model: 'protected.gpt-4.1', apiKey: 'fixture-key' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models, models, 'a working connection lists the server’s models for the Model box');
});

test('each kind of failure is told apart, and the key is never asked to list models after a 401', async (t) => {
  const server = await chatServer(t, '{"title":"Ready"}', {
    models: ['custom'],
    answer: (request) => {
      if (request.key === 'Bearer wrong') return { status: 401, body: '{"error":{"message":"Incorrect API key provided: wrong."}}' };
      if (request.body.model === 'busy') return { status: 429, body: '{"error":{"message":"Rate limit reached"}}' };
      if (request.body.model === 'broken') return { status: 502, body: '<html><body>Bad gateway</body></html>' };
      return undefined;
    },
  });
  const test = (openai) => service(t, { provider: 'openai', temperature: null, openai: { baseUrl: `${server.url}/v1`, model: 'custom', ...openai } }).testAiConnection({ openai });

  const auth = await test({ apiKey: 'wrong' });
  assert.equal(auth.diagnosis.kind, 'auth');
  assert.match(auth.reason, /didn’t accept the API key \(401\)/);
  assert.equal(auth.diagnosis.serverMessage, 'Incorrect API key provided: ••••.', 'the key the server echoed is hidden');
  assert.equal(server.listed.length, 0);

  const busy = await test({ model: 'busy' });
  assert.equal(busy.diagnosis.kind, 'rate-limit');
  const broken = await test({ model: 'broken' });
  assert.equal(broken.diagnosis.kind, 'model', 'not listed, so the model name is the likely cause');
  assert.equal(broken.diagnosis.serverMessage, '', 'an HTML error page is not shown as the server’s message');

  const wrongPath = await service(t, { provider: 'openai', temperature: null, openai: { baseUrl: `${server.url}/v1`, model: 'custom' } }, answering(404, '<html>Not Found</html>')).testAiConnection();
  assert.equal(wrongPath.diagnosis.kind, 'endpoint');
  assert.match(wrongPath.reason, /address before \/chat\/completions/);

  // A port nothing listens on any more.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const down = await service(t, { provider: 'openai', openai: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'custom' } }).testAiConnection();
  assert.equal(down.diagnosis.kind, 'network');
  assert.match(down.reason, /Can’t reach the server at http:\/\/127\.0\.0\.1:\d+\/v1/);
  assert.match(down.diagnosis.detail, /ECONNREFUSED/);
});

test('a reply streamed as server-sent events is read, even though StepForge asks for one JSON reply', async (t) => {
  // Two interleaved streams, as one gateway sends them: only one carries text.
  const events = [
    { id: '', choices: [] },
    { id: 'a', choices: [{ index: 0, delta: { content: '' } }] },
    { id: 'b', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { id: 'b', choices: [{ index: 0, delta: { content: '{"title":' } }] },
    { id: 'a', choices: [{ index: 0, delta: { content: '' } }] },
    { id: 'b', choices: [{ index: 0, delta: { content: '"Ready"}' } }] },
    { id: 'b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  const svc = service(t, { enabled: true, provider: 'openai', openai: { baseUrl: 'http://localhost/v1', model: 'custom' } }, answering(200, body));
  assert.equal(await svc.callOllama({ ...svc.readyAiConfig(), prompt: 'p', systemPrompt: 's' }), '{"title":"Ready"}');
  const empty = service(t, { provider: 'openai', openai: { baseUrl: 'http://localhost/v1', model: 'custom' } }, answering(200, 'data: [DONE]\n\n'));
  assert.match((await empty.testAiConnection()).reason, /no message text/);
});

test('the listed model a typed name probably means', () => {
  const models = ['protected.gpt-4.1', 'protected.gpt-4.1-mini', 'protected.Claude Sonnet 4.6', 'protected.Claude-Sonnet-5', 'GPT-4o'];
  assert.equal(suggestModel('gpt-4.1', models), 'protected.gpt-4.1', 'the shortest name ending with it');
  assert.equal(suggestModel('gpt-4o', models), 'GPT-4o', 'another letter case');
  assert.equal(suggestModel('claude-sonnet-4.6', models), 'protected.Claude Sonnet 4.6', 'spaces for hyphens');
  assert.equal(suggestModel('Claude Sonnet 5', models), 'protected.Claude-Sonnet-5');
  assert.equal(suggestModel('llama', models), null);
  assert.equal(suggestModel('', models), null);
  assert.equal(suggestModel('4', models), null, 'too short to guess from');
});

test('the server’s message comes from any common error shape, cleaned and shortened', () => {
  assert.equal(serverMessage('{"error":{"message":"Model not found"}}'), 'Model not found');
  assert.equal(serverMessage('{"error":"Unauthorized"}'), 'Unauthorized');
  assert.equal(serverMessage('{"detail":[{"msg":"field required"},{"msg":"value too large"}]}'), 'field required; value too large');
  assert.equal(serverMessage('{"message":"Rate limited"}'), 'Rate limited');
  assert.equal(serverMessage('plain text reason'), 'plain text reason');
  assert.equal(serverMessage('<!doctype html><title>502</title>'), '');
  assert.equal(serverMessage('{"detail":"Your key sk-123 is **invalid**"}', 'sk-123'), 'Your key •••• is invalid');
  assert.equal(serverMessage(JSON.stringify({ detail: 'x'.repeat(2000) })).length, 600);
});
