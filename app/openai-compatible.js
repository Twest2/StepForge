'use strict';

/**
 * The OpenAI-compatible AI provider: any server with an OpenAI-style
 * /chat/completions API (vLLM, LM Studio, LocalAI, LiteLLM and others).
 * Requests go through TextIntelService.fetchJson, so they share Ollama's
 * deadline, cancellation and concurrency limits.
 */

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const { t } = require('../core/ui-text');

/**
 * The server's base URL as StepForge uses it, without a trailing slash. A
 * path such as /v1 or /gateway/v1 is kept. Throws for anything but a plain
 * http(s) URL.
 */
function baseUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error(t('Enter the server URL, for example http://localhost:8000/v1.'));
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an http:// or https:// server URL without a user name, password, query or #fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * The API key for one server, encrypted with the operating system's keyring
 * (Electron safeStorage). It is never sent to the window, and it is only
 * used for the server URL it was saved for, so changing the URL can't send
 * it somewhere else.
 */
class AiKeyStore {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'openai-api-key.credentials');
    this.storage = safeStorage;
  }

  /** Whether keys can be encrypted: a real keyring, not Electron's plain-text fallback. */
  available() {
    return Boolean(this.storage?.isEncryptionAvailable()) && this.storage.getSelectedStorageBackend?.() !== 'basic_text';
  }

  saved() {
    if (!fs.existsSync(this.file)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error(t('The saved API key can’t be read. Enter it again in Settings → AI.'));
    }
  }

  /** True when a key is saved for this server URL. Doesn't decrypt it. */
  has(url) {
    try {
      return this.saved()?.endpoint === baseUrl(url);
    } catch {
      return false;
    }
  }

  /** Save `key` for this server URL, replacing any saved key; an empty key removes it. */
  set(url, key) {
    const endpoint = baseUrl(url);
    if (typeof key !== 'string' || /[\r\n]/.test(key)) throw new Error(t('Enter the API key on one line.'));
    if (!key) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    if (!this.available()) throw new Error(t('StepForge can’t encrypt the key because the system keyring is locked or missing. Unlock it and try again.'));
    atomicWriteFileSync(this.file, JSON.stringify({ endpoint, secret: this.storage.encryptString(key).toString('base64') }));
  }

  /** The key saved for this server URL, or '' when there is none. */
  get(url) {
    const saved = this.saved();
    if (!saved || saved.endpoint !== baseUrl(url)) return '';
    if (!this.available()) throw new Error(t('Unlock the system keyring so StepForge can use the saved API key.'));
    try {
      return this.storage.decryptString(Buffer.from(saved.secret, 'base64'));
    } catch {
      throw new Error(t('The saved API key can’t be read. Enter it again in Settings → AI.'));
    }
  }
}

/**
 * Why a request to the server failed, so Settings can say what to fix.
 * `kind` is one of:
 *   network      the server can't be reached (`detail` has the system's reason)
 *   redirect     the server answered with a redirect, which is never followed
 *   auth         401: the API key was refused
 *   forbidden    403: refused, often a key without access to that model
 *   endpoint     404: nothing at this URL answers chat requests
 *   model        the server has no model by that name
 *   temperature  the model refuses the temperature that was sent
 *   rate-limit   429
 *   server       any other error status
 *   reply        a 200 reply StepForge can't read
 * `serverMessage` is the server's own explanation, if it gave one, with any
 * API key removed. `url` is the address the request went to.
 */
class AiServerError extends Error {
  constructor(message, { kind, status = null, serverMessage = '', detail = '', url = '' } = {}) {
    super(message);
    this.name = 'AiServerError';
    this.kind = kind;
    this.status = status;
    this.serverMessage = serverMessage;
    this.detail = detail;
    this.url = url;
  }
}

const MAX_SERVER_MESSAGE = 600;

/** `text` without the API key, should a server echo it back. */
const withoutKey = (text, apiKey) => (apiKey ? String(text).split(apiKey).join('••••') : String(text));

/**
 * The explanation in an error reply: OpenAI's { error: { message } },
 * FastAPI and LiteLLM's { detail }, or { message }, or short plain text (not
 * an HTML error page). Markdown emphasis is removed and the text is shortened.
 */
function serverMessage(text, apiKey = '') {
  let message = '';
  try {
    const body = JSON.parse(text);
    const detail = body?.detail;
    message = [
      body?.error?.message,
      typeof body?.error === 'string' ? body.error : '',
      typeof detail === 'string' ? detail : '',
      Array.isArray(detail) ? detail.map((item) => item?.msg).filter((msg) => typeof msg === 'string').join('; ') : '',
      body?.message,
    ].find((value) => typeof value === 'string' && value.trim()) || '';
  } catch {
    if (!/^\s*</.test(text)) message = String(text || '');
  }
  message = withoutKey(message, apiKey)
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  return message.length > MAX_SERVER_MESSAGE ? `${message.slice(0, MAX_SERVER_MESSAGE - 1)}…` : message;
}

const MODEL_PROBLEM = /\bmodels?\b[^.]*\b(?:not (?:be )?found|does ?n[o’']t exist|does not exist|unknown|invalid|no such|not available|unavailable|not supported|unsupported|not allowed|no access|access denied)\b|\b(?:unknown|invalid|unsupported) model\b|\bno (?:such )?model\b/i;

/** The kind of failure (see AiServerError) for an error status and the server's message. */
function classify(status, message) {
  if (status >= 400 && status < 500 && /\btemperature\b/i.test(message)) return 'temperature';
  if (status !== 401 && MODEL_PROBLEM.test(message)) return 'model';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'endpoint';
  if (status === 429) return 'rate-limit';
  return 'server';
}

/** What to tell the user for each kind of failure. */
function failureText(kind, { status, model, temperature, url, serverMessage: said = '' }) {
  switch (kind) {
    case 'auth':
      return t('The server didn’t accept the API key ({status}). Check the key, or remove it if the server doesn’t need one.', { status });
    case 'forbidden':
      return t('The server refused the request ({status}). The API key may not have access to this model, or the model name may be wrong.', { status });
    case 'endpoint':
      return t('Nothing at {url} answers chat requests ({status}). Check the server URL: it’s the address before /chat/completions.', { url, status });
    case 'model':
      return t('The server has no model named “{model}”. Check the model name.', { model });
    case 'temperature':
      return t('This model doesn’t accept a temperature of {temperature}. Set Temperature to Model default in Settings → AI.', { temperature });
    case 'rate-limit':
      return t('The server is limiting requests ({status}). Wait a moment and try again.', { status });
    default: {
      const text = t('The server answered with an error ({status}).', { status });
      return said ? `${text} ${said.length > 200 ? `${said.slice(0, 199)}…` : said}` : text;
    }
  }
}

/** A fetch that never got an answer: a redirect, or the server being out of reach. */
function networkFailure(err, url, host) {
  const cause = err?.cause;
  const detail = [cause?.code, cause?.message || err?.message].filter(Boolean).join(': ');
  if (/redirect/i.test(detail)) {
    return new AiServerError(t('The server redirected the request. Enter the address it redirects to: StepForge doesn’t follow redirects, so your API key is never sent elsewhere.'), { kind: 'redirect', detail, url });
  }
  return new AiServerError(t('Can’t reach the server at {host}. Check the server URL and your network connection.', { host }), { kind: 'network', detail, url });
}

/**
 * The reply text in a /chat/completions answer: one JSON object, or the
 * event stream ("data: {…}" lines) that some servers send even when asked not
 * to stream.
 */
function replyText(body) {
  try {
    const content = JSON.parse(body)?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    throw new AiServerError(t('The server’s reply has no message text (choices[0].message.content).'), { kind: 'reply' });
  } catch (err) {
    if (err instanceof AiServerError) throw err;
  }
  const events = String(body).split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (!events.length) throw new AiServerError(t('The server’s reply isn’t OpenAI-compatible JSON.'), { kind: 'reply' });
  let text = '';
  for (const event of events) {
    if (event === '[DONE]') continue;
    try {
      const choice = JSON.parse(event)?.choices?.[0];
      const part = choice?.delta?.content ?? choice?.message?.content;
      if (typeof part === 'string') text += part;
    } catch { /* skip a line that isn't JSON */ }
  }
  if (!text.trim()) throw new AiServerError(t('The server’s reply has no message text (choices[0].message.content).'), { kind: 'reply' });
  return text;
}

/**
 * One chat request; resolves with the reply text. `images` are base64 PNGs.
 * `temperature` null leaves it out, so the model uses its own default.
 * Fails with an AiServerError that says what went wrong.
 */
async function chat(service, { host, model, prompt, systemPrompt, images = [], guideId = null, apiKey = '', temperature = null }) {
  if (apiKey && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey))) throw new Error(t('Enter the API key on one line.'));
  const content = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }))]
    : prompt;
  const url = `${baseUrl(host)}/chat/completions`;
  const body = { model, stream: false, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }] };
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;
  let response;
  try {
    response = await service.withConcurrency(() => service.fetchJson(new URL(url), {
      method: 'POST',
      guideId,
      parseBody: true,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body,
    }));
  } catch (err) {
    if (err?.code === 'STEPFORGE_AI_ABORTED') throw err;
    throw networkFailure(err, url, baseUrl(host));
  }
  const text = await response.text();
  if (!response.ok) {
    const said = serverMessage(text, apiKey);
    const kind = classify(response.status, said);
    throw new AiServerError(failureText(kind, { status: response.status, model, temperature, url, serverMessage: said }), {
      kind, status: response.status, serverMessage: said, url,
    });
  }
  try {
    return replyText(text);
  } catch (err) {
    err.status = response.status;
    err.url = url;
    throw err;
  }
}

/**
 * The model ids the server lists at /models, or null when it has no list
 * (or can't be asked). Many OpenAI-compatible servers have one; some don't.
 */
async function listModels(service, { host, apiKey = '' }) {
  try {
    const response = await service.fetchJson(new URL(`${baseUrl(host)}/models`), {
      parseBody: true,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!response.ok) return null;
    const data = JSON.parse(await response.text())?.data;
    if (!Array.isArray(data)) return null;
    return [...new Set(data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.trim()))].slice(0, 1000);
  } catch {
    return null;
  }
}

/**
 * The listed model that `model` most likely means, or null: the same name in
 * other letter case, a name that ends with it ("protected.gpt-4.1" for
 * "gpt-4.1"), or the same letters and digits ("Claude Sonnet 4.6" for
 * "claude-sonnet-4.6").
 */
function suggestModel(model, models) {
  const wanted = String(model || '').trim().toLowerCase();
  if (!wanted || !Array.isArray(models)) return null;
  const plain = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const shortest = (names) => names.sort((a, b) => a.length - b.length)[0] || null;
  return models.find((name) => name.toLowerCase() === wanted)
    || shortest(models.filter((name) => name.toLowerCase().endsWith(wanted)))
    || models.find((name) => plain(name) === plain(wanted) && plain(wanted))
    || shortest(models.filter((name) => plain(wanted).length >= 3 && plain(name).endsWith(plain(wanted))))
    || null;
}

module.exports = { baseUrl, AiKeyStore, AiServerError, chat, listModels, suggestModel, serverMessage };
