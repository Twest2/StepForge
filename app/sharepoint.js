'use strict';

const crypto = require('node:crypto');
const { PublishAccount, fillImages, json, unlessGone } = require('./publish-account');
const { resolveCloudApps, ONEDRIVE_CLIENT_PATTERN } = require('./cloud-apps');
const { slugify } = require('../core/util');
const { t } = require('../core/ui-text');

/*
 * SharePoint Online site pages through Microsoft Graph, with the same app
 * registration as OneDrive sync, asking for Sites.ReadWrite.All. Work or
 * school accounts only; some organizations require an administrator to
 * approve the app first. The site is chosen when connecting. A guide
 * becomes a published site page with one text web part; its screenshots go
 * to the site's Site Assets library under StepForge/<page>.
 */

const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access Sites.ReadWrite.All User.Read';

/** A site address as Graph's site path: contoso.sharepoint.com:/sites/Team, or the host for the root site. */
function sitePath(input) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(String(input).trim()) ? String(input).trim() : `https://${String(input).trim()}`); } catch { url = null; }
  if (!url || !/\.sharepoint\.(com|us|de|cn)$/i.test(url.hostname)) throw new Error(t('Enter your SharePoint site’s address, such as contoso.sharepoint.com/sites/Team.'));
  // Only the site part of an address copied from a page or library.
  const site = /^\/(sites|teams)\/[^/]+/i.exec(url.pathname)?.[0] || '';
  return site ? `${url.hostname}:${site}` : url.hostname;
}

const layout = (innerHtml) => ({ horizontalSections: [{ id: '1', layout: 'oneColumn', emphasis: 'none',
  columns: [{ id: '1', width: 12, webparts: [{ '@odata.type': '#microsoft.graph.textWebPart', innerHtml }] }] }] });

class SharePoint extends PublishAccount {
  constructor({ clientId = resolveCloudApps().onedriveClientId, ...options }) {
    super({ id: 'sharepoint', label: 'SharePoint', key: clientId, ...options });
  }

  get available() { return ONEDRIVE_CLIENT_PATTERN.test(this.key || ''); }
  get tokenUrl() { return `${AUTHORITY}/token`; }
  refreshParams(refreshToken) { return { client_id: this.key, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE }; }

  describeError(status, body) {
    if (status === 403) return t('SharePoint refused access. Check that you can edit pages on this site; your organization may also need to approve StepForge.');
    return super.describeError(status, body);
  }

  graph(target, options) { return this.authorized(`${GRAPH}/${target}`, options); }

  async connect({ address = '' } = {}) {
    if (!this.available) throw new Error(t('SharePoint sign-in is unavailable in this build of StepForge.'));
    const where = sitePath(address);
    this.requireEncryption();
    const { code, verifier, redirectUri } = await this.browserSignIn({
      authorizeUrl: ({ redirectUri, state, challenge }) => `${AUTHORITY}/authorize?${new URLSearchParams({
        client_id: this.key, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: SCOPE,
        state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })}`,
    });
    const tokens = this.tokens(await this.tokenRequest(this.tokenUrl, { client_id: this.key, grant_type: 'authorization_code', code,
      redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPE }));
    return this.signInWith(tokens, async () => {
      const site = await this.graph(`sites/${where}?$select=id,displayName,webUrl`);
      return { siteId: site.id, site: site.webUrl, account: site.displayName || new URL(site.webUrl).host };
    });
  }

  /** Site Assets, where SharePoint keeps a site's images; the site's documents if it has none. */
  async assetsDrive(siteId) {
    const drives = (await this.graph(`sites/${siteId}/drives?$select=id,webUrl`))?.value || [];
    return drives.find((d) => /\/SiteAssets\/?$/i.test(d.webUrl || ''))?.id || (await this.graph(`sites/${siteId}/drive?$select=id`)).id;
  }

  async publish({ guideId, title, page, onProgress = () => {} }) {
    const { siteId, site } = this.requireAccount();
    const known = this.publishedFor(guideId);
    const name = known?.name || `${slugify(title, 'guide')}-${crypto.randomBytes(3).toString('hex')}`;
    const drive = page.images.length ? await this.assetsDrive(siteId) : null;
    const urls = await this.uploadImages(page.images, async (image) => {
      const item = await this.graph(`drives/${drive}/root:/StepForge/${encodeURIComponent(name)}/${encodeURIComponent(image.name)}:/content`,
        { method: 'PUT', headers: { 'Content-Type': image.type }, body: image.data, timeout: 300000 });
      return item.webUrl;
    }, onProgress);
    onProgress({ stage: 'page' });
    const canvasLayout = layout(fillImages(page.html, urls));
    let sitePage = known ? await unlessGone(this.graph(`sites/${siteId}/pages/${known.id}/microsoft.graph.sitePage?$select=id,webUrl`)) : null;
    const updated = Boolean(sitePage);
    if (sitePage) {
      await this.graph(`sites/${siteId}/pages/${sitePage.id}/microsoft.graph.sitePage`, json('PATCH', { '@odata.type': '#microsoft.graph.sitePage', title, canvasLayout }));
    } else {
      sitePage = await this.graph(`sites/${siteId}/pages`, json('POST', { '@odata.type': '#microsoft.graph.sitePage', name: `${name}.aspx`, title,
        pageLayout: 'article', showComments: true, showRecommendedPages: false, canvasLayout }));
    }
    await this.graph(`sites/${siteId}/pages/${sitePage.id}/microsoft.graph.sitePage/publish`, { method: 'POST' });
    const url = new URL(sitePage.webUrl, `${site.replace(/\/+$/, '')}/`).href;
    return this.published(guideId, { id: sitePage.id, name, title, url }, { updated });
  }
}

module.exports = { SharePoint, sitePath, SCOPE };
