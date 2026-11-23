'use strict';

const { PublishAccount, json, unlessGone } = require('./publish-account');
const { normalizeServer } = require('./webdav');
const { slugify } = require('../core/util');
const { t } = require('../core/ui-text');

/*
 * GitLab Pages, on gitlab.com or a self-managed GitLab, with a personal
 * access token that has the api scope. The first publish makes a public
 * project, stepforge-guides, in the user's namespace, with a CI file that
 * serves its public/ folder. Each guide is public/<slug>/index.html (the
 * interactive HTML export); GitLab builds the site after each commit, which
 * takes a minute or two and needs CI runners (on gitlab.com, a verified
 * account).
 */

const PROJECT = 'stepforge-guides';
const CI_FILE = '.gitlab-ci.yml';
const CI = `# Made by StepForge: serves public/ with GitLab Pages.
pages:
  stage: deploy
  script:
    - echo "Publishing guides"
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
`;

class GitLabPages extends PublishAccount {
  constructor(options) {
    super({ id: 'gitlab', label: 'GitLab Pages', ...options });
  }

  async authHeaders() {
    return { 'PRIVATE-TOKEN': this.requireAccount().token, Accept: 'application/json' };
  }

  api(target, options) { return this.authorized(`${this.requireAccount().site}/api/v4/${target}`, options); }

  async connect({ address = '', token = '' } = {}) {
    const site = normalizeServer(address.trim() || 'gitlab.com').origin;
    if (!token.trim()) throw new Error(t('Paste a personal access token with the api scope.'));
    return this.signInWith({ site, token: token.trim() }, async () => {
      const user = await this.api('user');
      return { account: `@${user.username}`, username: user.username };
    });
  }

  /** The guides project, made the first time. */
  async project() {
    const account = this.requireAccount();
    let project = account.projectId ? await unlessGone(this.api(`projects/${account.projectId}`)) : null;
    project ||= await unlessGone(this.api(`projects/${encodeURIComponent(`${account.username}/${PROJECT}`)}`));
    project ||= await this.api('projects', json('POST', { name: 'StepForge guides', path: PROJECT, visibility: 'public',
      pages_access_level: 'public', description: t('Guides published from StepForge.') }));
    if (account.projectId !== project.id) { account.projectId = project.id; this.save(); }
    return project;
  }

  async fileExists(project, branch, file) {
    const response = await this.api(`projects/${project.id}/repository/files/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`, { method: 'HEAD', raw: true });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(this.describeError(response.status, null));
    return true;
  }

  async publish({ guideId, title, page, replace = false, onProgress = () => {} }) {
    onProgress({ stage: 'upload', index: 0, count: 1, loaded: 0, total: page.html.length });
    const project = await this.project();
    const branch = project.default_branch || 'main';
    const known = this.publishedFor(guideId);
    const slug = known?.slug || slugify(title, 'guide');
    const file = `public/${slug}/index.html`;
    const exists = await this.fileExists(project, branch, file);
    if (exists && !known?.slug && !replace) return { conflict: { path: file, title: slug } };
    const actions = [{ action: exists ? 'update' : 'create', file_path: file, content: Buffer.from(page.html, 'utf8').toString('base64'), encoding: 'base64' }];
    if (!await this.fileExists(project, branch, CI_FILE)) actions.push({ action: 'create', file_path: CI_FILE, content: CI });
    onProgress({ stage: 'page' });
    const commit = await this.api(`projects/${project.id}/repository/commits`, json('POST', { branch, commit_message: `Publish “${title}” from StepForge`, actions }));
    // Hand over the link only once it works: GitLab builds the site, then
    // Pages keeps serving the last deployment for up to a minute.
    onProgress({ stage: 'live' });
    const { url, live, waiting } = await this.waitUntilLive(project, commit.id, slug);
    return this.published(guideId, { id: project.id, slug, title, url }, { updated: exists, live,
      ...(live ? {} : { note: ['created', 'pending', 'waiting_for_resource'].includes(waiting)
        ? t('GitLab hasn’t started building the site. It needs a CI runner; on gitlab.com, that means a verified account. The link works once the pipeline has run.')
        : t('GitLab is still building the site. The link works once it’s done.') }) });
  }

  /**
   * Wait until the pipeline for commit `sha` has deployed the site and the
   * guide at `slug` loads. Resolves with { url, live }, and `waiting` (the
   * pipeline's status) when the deadline passes first. A failed pipeline is
   * an error, with a link to it.
   */
  async waitUntilLive(project, sha, slug, { deadline = Date.now() + 10 * 60000 } = {}) {
    let url = null;
    let waiting = 'pending';
    for (let attempt = 0; Date.now() < deadline; attempt += 1) {
      if (attempt) await this.wait(Math.min(2000 + attempt * 1000, 10000));
      const pipeline = (await this.api(`projects/${project.id}/pipelines?sha=${encodeURIComponent(sha)}&per_page=1`))?.[0];
      waiting = pipeline?.status || 'pending';
      if (['failed', 'canceled'].includes(waiting)) {
        throw new Error(t('GitLab couldn’t build the site. See what went wrong in the pipeline: {url}', { url: pipeline.web_url || `${project.web_url}/-/pipelines` }));
      }
      if (waiting !== 'success') continue;
      url ||= await this.api(`projects/${project.id}/pages`).then((pages) => (pages?.url ? `${pages.url.replace(/\/+$/, '')}/${slug}/` : null), () => null);
      if (!url) continue;
      // Without the token: this is the public site, not the API.
      const response = await this.request(`${url}?stepforge=${Date.now()}`, { method: 'HEAD', raw: true, redirect: 'manual', timeout: 15000 }).catch(() => null);
      if (response && response.status < 400) return { url, live: true };
    }
    return { url: url || `${project.web_url}/pages`, live: false, waiting };
  }

}

module.exports = { GitLabPages, CI };
