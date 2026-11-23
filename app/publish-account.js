'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { CloudAccount } = require('./cloud-account');
const { readJsonIfExists, writeJsonSync } = require('../core/util');
const { t } = require('../core/ui-text');

/*
 * What the publishing services (Notion, SharePoint, BookStack, GitLab Pages,
 * Zendesk) have in common, on top of CloudAccount: the sign-in kept in an
 * OS-encrypted file with an OS-user backup, cancellable requests, and which
 * page each guide was published to, so publishing again updates it.
 *
 * Each service supplies connect(fields), targets() (where a page can go:
 * books, sections, parent pages; [] when the account decides that) and
 * publish({ guideId, title, target, replace, page, onProgress }), which
 * resolves with { url, title, updated, draft?, note? } or { conflict }.
 */

const PNG_DATA_URL = /src="data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)"/g;
const IMAGE_MARK = /src="stepforge-image:(\d+)"/g;

/**
 * A page from the clipboard export's HTML: its screenshots taken out as
 * step-001.png and so on (in order) and marked stepforge-image:<index>, and
 * the guide's own heading dropped, since the page has the title.
 */
function pageFromHtml(html) {
  const images = [];
  const body = String(html).replace(/<h1\b[^>]*>[\s\S]*?<\/h1>\n?/, '').replace(PNG_DATA_URL, (whole, kind, base64) => {
    const ext = kind === 'jpeg' ? 'jpg' : 'png';
    images.push({ name: `step-${String(images.length + 1).padStart(3, '0')}.${ext}`, type: `image/${kind}`, data: Buffer.from(base64, 'base64') });
    return `src="stepforge-image:${images.length - 1}"`;
  });
  return { html: body, images };
}

/** The page's HTML with each marked screenshot pointing at its uploaded address. */
function fillImages(html, urls) {
  return html.replace(IMAGE_MARK, (whole, index) => `src="${String(urls[Number(index)] || '').replace(/"/g, '&quot;')}"`);
}

/** A multipart/form-data body: text fields, then one file. */
function multipart(fields, file) {
  const boundary = `stepforge${crypto.randomBytes(12).toString('hex')}`;
  const clean = (text) => String(text).replace(/["\r\n\\]/g, '_');
  const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${clean(name)}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${clean(file.field)}"; filename="${clean(file.name)}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A 404 as null, so a page deleted on the site is published again as a new one. */
const unlessGone = (promise) => promise.catch((err) => { if (err.status === 404 || err.status === 410) return null; throw err; });

class PublishAccount extends CloudAccount {
  constructor({ id, label, key = id, directory, ...options }) {
    super({ id: `publish-${id}`, label, key, directory, ...options });
    this.service = id;
    this.pagesFile = path.join(directory, `publish-${id}-pages.json`);
  }

  backend() { return {}; } // nothing is synced through a publishing account

  status() {
    const c = this.credentials;
    return { connected: Boolean(c), available: this.available, account: c?.account || '', site: c?.site || '', error: this.loadError };
  }

  describeError(status, body) {
    const reason = typeof body === 'string' ? body.slice(0, 200)
      : body?.message || body?.error?.message || body?.description || body?.error_description
        || (typeof body?.error === 'string' ? body.error : '') || (body?.errors ? JSON.stringify(body.errors) : '');
    return t('{service} refused the request ({status}).', { service: this.label, status: `${status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}` });
  }

  /** Try a new sign-in with `check` (resolving with more to keep), and save it only if that works. */
  async signInWith(credentials, check) {
    this.requireEncryption();
    this.cancel();
    this.credentials = { ...credentials, key: this.key };
    try {
      const extra = await check();
      return this.finishSignIn({ ...credentials, ...extra });
    } catch (err) {
      this.credentials = null;
      throw err;
    }
  }

  async disconnect() {
    await super.disconnect();
    return this.status();
  }

  requireAccount() {
    if (!this.credentials) throw new Error(this.loadError || t('Connect {service} in Settings → Accounts → Publishing first.', { service: this.label }));
    return this.credentials;
  }

  async targets() { return []; }

  // Pages published for each guide, by account: { [account key]: { [guideId]: { id, url, title, target, publishedAt, ... } } }
  get accountKey() { return `${this.credentials?.site || ''}|${this.credentials?.account || ''}`; }

  publishedFor(guideId) {
    return this.credentials ? readJsonIfExists(this.pagesFile, {})[this.accountKey]?.[guideId] || null : null;
  }

  /** Remember the guide's page and resolve with what the publish dialog shows. */
  published(guideId, page, extra = {}) {
    const all = readJsonIfExists(this.pagesFile, {});
    const remembered = { ...page, publishedAt: new Date().toISOString() };
    all[this.accountKey] = { ...(all[this.accountKey] || {}), [guideId]: remembered };
    writeJsonSync(this.pagesFile, all);
    return { ...remembered, ...extra };
  }

  /** Upload each image with `upload(image)`, reporting progress; resolves with their addresses in order. */
  async uploadImages(images, upload, onProgress) {
    const total = images.reduce((n, image) => n + image.data.length, 0);
    const urls = [];
    let loaded = 0;
    for (const [index, image] of images.entries()) {
      onProgress({ stage: 'upload', index: index + 1, count: images.length, loaded, total });
      urls.push(await upload(image));
      loaded += image.data.length;
    }
    return urls;
  }
}

module.exports = { PublishAccount, pageFromHtml, fillImages, multipart, json, unlessGone };
