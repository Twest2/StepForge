'use strict';

const { PublishAccount, multipart, json, unlessGone } = require('./publish-account');
const { t } = require('../core/ui-text');

/*
 * Notion through its public API, with an internal integration's secret
 * (notion.so/profile/integrations). Notion only lets an integration see
 * pages someone has shared with it (a page's ••• → Connections), so those
 * are the pages a guide can go under. A guide becomes a subpage built from
 * Notion blocks (exporters/notion.js), with its screenshots sent through
 * Notion's file uploads. Publishing again replaces the page's content and
 * keeps its address.
 */

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const BATCH = 100; // blocks Notion takes in one request

const pageTitle = (page) => Object.values(page?.properties || {}).find((p) => p?.type === 'title')?.title?.map((r) => r.plain_text).join('') || '';

class Notion extends PublishAccount {
  constructor(options) {
    super({ id: 'notion', label: 'Notion', ...options });
  }

  async authHeaders() {
    return { Authorization: `Bearer ${this.requireAccount().token}`, 'Notion-Version': VERSION, Accept: 'application/json' };
  }

  api(target, options) { return this.authorized(`${API}/${target}`, options); }

  async connect({ token = '' } = {}) {
    if (!token.trim()) throw new Error(t('Paste the integration’s secret.'));
    return this.signInWith({ site: 'notion.so', token: token.trim() }, async () => {
      const me = await this.api('users/me');
      return { account: me?.bot?.workspace_name || me?.name || 'Notion' };
    });
  }

  async targets() {
    const pages = [];
    let cursor;
    for (let round = 0; round < 10; round += 1) {
      const data = await this.api('search', json('POST', { filter: { property: 'object', value: 'page' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
      pages.push(...(data?.results || []).filter((p) => !p.archived && !p.in_trash));
      if (!data?.has_more) break;
      cursor = data.next_cursor;
    }
    return pages.map((p) => ({ id: p.id, name: pageTitle(p) || t('Untitled page') })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async uploadImage(base64, index) {
    const name = `step-${String(index + 1).padStart(3, '0')}.png`;
    const upload = await this.api('file_uploads', json('POST', { filename: name, content_type: 'image/png' }));
    const { body, headers } = multipart({}, { field: 'file', name, type: 'image/png', data: Buffer.from(base64, 'base64') });
    await this.api(`file_uploads/${upload.id}/send`, { method: 'POST', body, headers, timeout: 300000 });
    return upload.id;
  }

  async clear(pageId) {
    for (let round = 0; round < 100; round += 1) {
      const children = (await this.api(`blocks/${pageId}/children?page_size=100`))?.results || [];
      if (!children.length) return;
      for (const child of children) await this.api(`blocks/${child.id}`, { method: 'DELETE' });
    }
  }

  async publish({ guideId, title, target, page, onProgress = () => {} }) {
    if (!target) throw new Error(t('Choose the Notion page to publish under.'));
    const images = page.images.map((base64, index) => ({ name: String(index), data: Buffer.from(base64, 'base64'), base64 }));
    const ids = await this.uploadImages(images, (image) => this.uploadImage(image.base64, Number(image.name)), onProgress);
    const blocks = page.blocks.map((b) => (b.type === 'image' && Number.isInteger(b.image?.stepforgeImage)
      ? { ...b, image: { type: 'file_upload', file_upload: { id: ids[b.image.stepforgeImage] }, caption: b.image.caption } } : b));
    onProgress({ stage: 'page' });
    const properties = { title: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] } };
    const known = this.publishedFor(guideId);
    let notionPage = known ? await unlessGone(this.api(`pages/${known.id}`)) : null;
    if (notionPage?.archived || notionPage?.in_trash) notionPage = null;
    const updated = Boolean(notionPage);
    if (notionPage) {
      await this.api(`pages/${notionPage.id}`, json('PATCH', { properties }));
      await this.clear(notionPage.id);
    } else {
      notionPage = await this.api('pages', json('POST', { parent: { page_id: target }, properties }));
    }
    for (let i = 0; i < blocks.length; i += BATCH) {
      await this.api(`blocks/${notionPage.id}/children`, json('PATCH', { children: blocks.slice(i, i + BATCH) }));
    }
    return this.published(guideId, { id: notionPage.id, title, target: known && updated ? known.target : target, url: notionPage.url }, { updated });
  }
}

module.exports = { Notion, pageTitle };
