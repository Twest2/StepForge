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
const { isLoopbackHost } = require('../core/text-intel');

/**
 * The server's base URL as StepForge uses it, without a trailing slash. A
 * path such as /v1 or /gateway/v1 is kept. Throws for anything but a plain
 * http(s) URL, and for a server off this computer unless `allowRemote`.
 */
function baseUrl(value, allowRemote = false) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('Enter the server URL, for example http://localhost:8000/v1.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an http:// or https:// server URL without a user name, password, query or #fragment.');
  }
  if (!allowRemote && !isLoopbackHost(url.href)) {
    throw new Error('This server is on another computer. Turn on Allow a server on another computer first.');
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
      throw new Error('The saved API key can’t be read. Enter it again in Settings → AI.');
    }
  }

  /** True when a key is saved for this server URL. Doesn't decrypt it. */
  has(url) {
    try {
      return this.saved()?.endpoint === baseUrl(url, true);
    } catch {
      return false;
    }
  }

  /** Save `key` for this server URL, replacing any saved key; an empty key removes it. */
  set(url, key) {
    const endpoint = baseUrl(url, true);
    if (typeof key !== 'string' || /[\r\n]/.test(key)) throw new Error('Enter the API key on one line.');
    if (!key) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    if (!this.available()) throw new Error('StepForge can’t encrypt the key because the system keyring is locked or missing. Unlock it and try again.');
    atomicWriteFileSync(this.file, JSON.stringify({ endpoint, secret: this.storage.encryptString(key).toString('base64') }));
  }

  /** The key saved for this server URL, or '' when there is none. */
  get(url) {
    const saved = this.saved();
    if (!saved || saved.endpoint !== baseUrl(url, true)) return '';
    if (!this.available()) throw new Error('Unlock the system keyring so StepForge can use the saved API key.');
    try {
      return this.storage.decryptString(Buffer.from(saved.secret, 'base64'));
    } catch {
      throw new Error('The saved API key can’t be read. Enter it again in Settings → AI.');
    }
  }
}

/** One chat request; resolves with the reply text. `images` are base64 PNGs. */
async function chat(service, { host, model, prompt, systemPrompt, images = [], guideId = null, apiKey = '' }) {
  if (apiKey && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey))) throw new Error('Enter the API key on one line.');
  const content = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }))]
    : prompt;
  const response = await service.withConcurrency(() => service.fetchJson(new URL(`${baseUrl(host, true)}/chat/completions`), {
    method: 'POST',
    guideId,
    parseBody: true,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: { model, stream: false, temperature: 0.2, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }] },
  }));
  if (response.status === 401 || response.status === 403) throw new Error(`The server refused the request (${response.status}). Check the API key.`);
  if (response.status === 404) throw new Error('The server has no /chat/completions endpoint at this URL. Check that the URL ends in /v1 (or your server’s API path).');
  if (!response.ok) throw new Error(`The server answered with an error (${response.status}).`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The server’s reply isn’t OpenAI-compatible JSON.');
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('The server’s reply has no message text (choices[0].message.content).');
  return text;
}

module.exports = { baseUrl, AiKeyStore, chat };
