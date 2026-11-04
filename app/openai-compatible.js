'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const { isLoopbackHost } = require('../core/text-intel');

function baseUrl(value, allowRemote = false) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a valid OpenAI-compatible base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS base URL without credentials, query parameters or a fragment.');
  if (!allowRemote && !isLoopbackHost(url.href)) throw new Error('Enable Allow remote AI host before connecting to this endpoint.');
  return url.href.replace(/\/+$/, '');
}

class AiKeyStore {
  constructor(directory, safeStorage) { this.file = path.join(directory, 'openai-api-key.credentials');this.storage = safeStorage; }
  available() { return this.storage?.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== 'basic_text'; }
  set(url, key) {
    const endpoint = baseUrl(url, true);
    if (typeof key !== 'string' || /[\r\n]/.test(key)) throw new Error('Enter a single-line API key.');
    if (!key) { fs.rmSync(this.file, { force: true });return; }
    if (!this.available()) throw new Error('OS encryption is unavailable. Unlock the system keyring before saving an API key.');
    atomicWriteFileSync(this.file, JSON.stringify({ endpoint, secret: this.storage.encryptString(key).toString('base64') }));
  }
  get(url) {
    if (!fs.existsSync(this.file)) return '';
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { throw new Error('Could not unlock the saved API key. Enter it again in Settings.'); }
    if (saved.endpoint !== baseUrl(url, true)) return '';
    if (!this.available()) throw new Error('Unlock the system keyring to use the saved API key.');
    try { return this.storage.decryptString(Buffer.from(saved.secret, 'base64')); } catch { throw new Error('Could not unlock the saved API key. Enter it again in Settings.'); }
  }
}

async function chat(service, { host, model, prompt, systemPrompt, images = [], guideId = null, apiKey }) {
  if (apiKey && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey))) throw new Error('Enter a single-line API key.');
  host = baseUrl(host, true);
  const content = images.length ? [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }))] : prompt;
  const response = await service.withConcurrency(() => service.fetchJson(new URL(host + '/chat/completions'), {
    method: 'POST', guideId, parseBody: true, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: { model, stream: false, temperature: 0.2, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }] },
  }));
  if (!response.ok) throw new Error(`OpenAI-compatible request failed (${response.status}).`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('The endpoint did not return a compatible JSON response.'); }
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('The endpoint did not return choices[0].message.content.');
  return text;
}
module.exports = { baseUrl, AiKeyStore, chat };
