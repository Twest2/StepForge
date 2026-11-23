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
    await this.api(`projects/${project.id}/repository/commits`, json('POST', { branch, commit_message: `Publish “${title}” from StepForge`, actions }));
    const pages = await this.api(`projects/${project.id}/pages`).catch(() => null);
    const url = pages?.url ? `${pages.url.replace(/\/+$/, '')}/${slug}/` : `${project.web_url}/pages`;
    return this.published(guideId, { id: project.id, slug, title, url }, { updated: exists,
      note: t('GitLab builds the site after each publish. It can take a minute or two to appear.') });
  }
}

module.exports = { GitLabPages, CI };
