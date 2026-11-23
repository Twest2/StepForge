'use strict';

const { PublishAccount, fillImages, multipart, json, unlessGone } = require('./publish-account');
const { normalizeServer } = require('./webdav');
const { t } = require('../core/ui-text');

/*
 * BookStack through its REST API, with an API token (Profile → Access &
 * Security → API Tokens; the user's role needs "Access system API").
 * A guide becomes a page in a book or chapter. Screenshots go to the
 * page's image gallery, so they're deleted with the page.
 */

const parseTarget = (target) => {
  const match = /^(book|chapter):(\d+)$/.exec(String(target || ''));
  if (!match) throw new Error(t('Choose a book or chapter for the page.'));
  return match[1] === 'chapter' ? { chapter_id: Number(match[2]) } : { book_id: Number(match[2]) };
};

class BookStack extends PublishAccount {
  constructor(options) {
    super({ id: 'bookstack', label: 'BookStack', ...options });
  }

  async authHeaders() {
    const { tokenId, tokenSecret } = this.requireAccount();
    return { Authorization: `Token ${tokenId}:${tokenSecret}`, Accept: 'application/json' };
  }

  api(target, options) { return this.authorized(`${this.requireAccount().site}/api/${target}`, options); }

  async connect({ address = '', tokenId = '', tokenSecret = '' } = {}) {
    const site = normalizeServer(address).href.replace(/\/+$/, '');
    if (!tokenId.trim() || !tokenSecret.trim()) throw new Error(t('Enter the token ID and the token secret.'));
    return this.signInWith({ site, tokenId: tokenId.trim(), tokenSecret: tokenSecret.trim() }, async () => {
      await this.api('books?count=1');
      return { account: new URL(site).host };
    });
  }

  async targets() {
    const [books, chapters] = await Promise.all([this.api('books?count=500&sort=+name'), this.api('chapters?count=500&sort=+name')]);
    const bookName = new Map((books?.data || []).map((b) => [b.id, b.name]));
    return [...(books?.data || []).map((b) => ({ id: `book:${b.id}`, name: b.name })),
      ...(chapters?.data || []).map((c) => ({ id: `chapter:${c.id}`, name: `${bookName.get(c.book_id) || ''} › ${c.name}` }))]
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async publish({ guideId, title, target, page, onProgress = () => {} }) {
    const place = parseTarget(target);
    const known = this.publishedFor(guideId);
    let pageId = known ? (await unlessGone(this.api(`pages/${known.id}`)))?.id : null;
    const updated = Boolean(pageId);
    // Gallery images belong to a page, so a new page is made first.
    if (!pageId) pageId = (await this.api('pages', json('POST', { ...place, name: title, html: '<p></p>' }))).id;
    const urls = await this.uploadImages(page.images, async (image) => {
      const { body, headers } = multipart({ type: 'gallery', uploaded_to: pageId, name: image.name }, { field: 'image', ...image });
      return (await this.api('image-gallery', { method: 'POST', body, headers, timeout: 300000 })).url;
    }, onProgress);
    onProgress({ stage: 'page' });
    await this.api(`pages/${pageId}`, json('PUT', { ...place, name: title, html: fillImages(page.html, urls) }));
    // /link/<id> always leads to the page, wherever it's moved.
    return this.published(guideId, { id: pageId, title, target, url: `${this.credentials.site}/link/${pageId}` }, { updated });
  }
}

module.exports = { BookStack };
