'use strict';

const { PublishAccount, fillImages, multipart, json, unlessGone } = require('./publish-account');
const { t } = require('../core/ui-text');

/*
 * Zendesk Guide (the help center) through its REST API, signed in with an
 * agent's email address and an API token (Admin Center → Apps and
 * integrations → Zendesk API). A guide becomes an article in a section,
 * saved as a draft the first time so someone can review it before
 * customers see it; publishing again keeps whatever state it's in.
 * Screenshots are uploaded as the article's inline attachments.
 */

/** "acme", "acme.zendesk.com" or a copied address, as https://acme.zendesk.com. */
function normalizeSubdomain(input) {
  const text = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  const name = text.endsWith('.zendesk.com') ? text.slice(0, -'.zendesk.com'.length) : text;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(t('Enter your Zendesk subdomain, such as acme for acme.zendesk.com.'));
  return `https://${name}.zendesk.com`;
}

class Zendesk extends PublishAccount {
  constructor(options) {
    super({ id: 'zendesk', label: 'Zendesk', ...options });
  }

  async authHeaders() {
    const { email, token } = this.requireAccount();
    return { Authorization: `Basic ${Buffer.from(`${email}/token:${token}`, 'utf8').toString('base64')}`, Accept: 'application/json' };
  }

  api(target, options) { return this.authorized(`${this.requireAccount().site}/api/v2/${target}`, options); }

  async connect({ address = '', email = '', token = '' } = {}) {
    const site = normalizeSubdomain(address);
    if (!email.trim() || !token.trim()) throw new Error(t('Enter your email address and an API token.'));
    return this.signInWith({ site, email: email.trim(), token: token.trim() }, async () => {
      const me = (await this.api('users/me.json'))?.user;
      // Wrong details sign in as an anonymous user rather than failing.
      if (!me?.id) throw new Error(t('Zendesk didn’t accept that email address and API token.'));
      return { account: me.email || email.trim() };
    });
  }

  async targets() {
    const sections = [];
    let next = 'help_center/sections.json?per_page=100';
    for (let page = 0; next && page < 20; page += 1) {
      const data = await this.api(next);
      sections.push(...(data?.sections || []));
      next = data?.next_page ? data.next_page.replace(/^.*?\/api\/v2\//, '') : null;
    }
    return sections.map((s) => ({ id: String(s.id), name: s.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async publish({ guideId, title, target, page, onProgress = () => {} }) {
    if (!/^\d+$/.test(String(target || ''))) throw new Error(t('Choose a section for the article.'));
    const known = this.publishedFor(guideId);
    let article = known ? (await unlessGone(this.api(`help_center/articles/${known.id}.json`)))?.article : null;
    const updated = Boolean(article);
    if (!article) {
      const [section, groups] = await Promise.all([this.api(`help_center/sections/${target}.json`), this.api('guide/permission_groups.json')]);
      const group = groups?.permission_groups?.[0];
      if (!group) throw new Error(t('Zendesk has no permission group to give the article. Create one in Guide Admin first.'));
      article = (await this.api(`help_center/sections/${target}/articles.json`, json('POST', {
        article: { title, body: '<p></p>', locale: section.section.locale, permission_group_id: group.id, user_segment_id: null, draft: true },
        notify_subscribers: false,
      }))).article;
    } else if (String(article.section_id) !== String(target)) {
      await this.api(`help_center/articles/${article.id}.json`, json('PUT', { article: { section_id: Number(target) } }));
    }
    const urls = await this.uploadImages(page.images, async (image) => {
      const { body, headers } = multipart({ inline: 'true' }, { field: 'file', ...image });
      return (await this.api(`help_center/articles/${article.id}/attachments.json`, { method: 'POST', body, headers, timeout: 300000 })).article_attachment.content_url;
    }, onProgress);
    onProgress({ stage: 'page' });
    const locale = article.source_locale || article.locale;
    const saved = (await this.api(`help_center/articles/${article.id}/translations/${encodeURIComponent(locale)}.json`,
      json('PUT', { translation: { title, body: fillImages(page.html, urls) } }))).translation;
    return this.published(guideId, { id: article.id, title, target, url: article.html_url }, { updated, draft: Boolean(saved?.draft ?? article.draft) });
  }
}

module.exports = { Zendesk, normalizeSubdomain };
