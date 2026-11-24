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
// Notion takes at most 100 blocks in one list, and 1000 in one request
// counting nested ones (a table's rows).
const BATCH = 100;
const REQUEST_BLOCKS = 900;
const GAP_MS = 340; // Notion allows about 3 requests a second

const pageTitle = (page) => Object.values(page?.properties || {}).find((p) => p?.type === 'title')?.title?.map((r) => r.plain_text).join('') || '';

class Notion extends PublishAccount {
  constructor(options) {
    super({ id: 'notion', label: 'Notion', ...options });
  }

  async authHeaders() {
    return { Authorization: `Bearer ${this.requireAccount().token}`, 'Notion-Version': VERSION, Accept: 'application/json' };
  }

  async api(target, options) {
    const gap = (this.lastCall || 0) + GAP_MS - Date.now();
    if (gap > 0) await this.wait(gap);
    this.lastCall = Date.now();
    return this.authorized(`${API}/${target}`, options);
  }

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

  /** The ids of a page's blocks, every page of them. */
  async childIds(pageId) {
    const ids = [];
    let cursor = null;
    do {
      const data = await this.api(`blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      ids.push(...(data?.results || []).map((block) => block.id));
      cursor = data?.has_more ? data.next_cursor : null;
    } while (cursor);
    return ids;
  }

  /**
   * Add blocks to a page in batches Notion accepts. A table with more rows
   * than one list takes is made with the first 100 and gets the rest after.
   */
  async append(parentId, blocks) {
    const extra = new Map();
    const sized = blocks.map((block) => {
      const rows = block.type === 'table' ? block.table.children : null;
      if (!rows || rows.length <= BATCH) return block;
      const first = { ...block, table: { ...block.table, children: rows.slice(0, BATCH) } };
      extra.set(first, rows.slice(BATCH));
      return first;
    });
    for (let i = 0; i < sized.length;) {
      const batch = [];
      let weight = 0;
      while (i < sized.length && batch.length < BATCH) {
        const size = 1 + (sized[i].table?.children?.length || 0);
        if (batch.length && weight + size > REQUEST_BLOCKS) break;
        batch.push(sized[i]);
        weight += size;
        i += 1;
      }
      const made = (await this.api(`blocks/${parentId}/children`, json('PATCH', { children: batch })))?.results || [];
      for (const [index, block] of batch.entries()) {
        const rest = extra.get(block);
        if (!rest) continue;
        if (!made[index]?.id) throw new Error(t('Notion didn’t return the table it made, so its other rows couldn’t be added.'));
        for (let r = 0; r < rest.length; r += BATCH) {
          await this.api(`blocks/${made[index].id}/children`, json('PATCH', { children: rest.slice(r, r + BATCH) }));
        }
      }
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
      // The new content goes in before the old comes out, so a publish that
      // stops partway never leaves the page empty.
      const old = await this.childIds(notionPage.id);
      await this.api(`pages/${notionPage.id}`, json('PATCH', { properties }));
      await this.append(notionPage.id, blocks);
      for (const id of old) await this.api(`blocks/${id}`, { method: 'DELETE' });
    } else {
      notionPage = await this.api('pages', json('POST', { parent: { page_id: target }, properties }));
      await this.append(notionPage.id, blocks);
    }
    return this.published(guideId, { id: notionPage.id, title, target: known && updated ? known.target : target, url: notionPage.url }, { updated });
  }
}

module.exports = { Notion, pageTitle };
