'use strict';

const { PublishAccount, json, unlessGone } = require('./publish-account');
const { normalizeServer } = require('./webdav');
const site = require('../core/pages-site');
const { t } = require('../core/ui-text');

/*
 * GitLab Pages, on gitlab.com or a self-managed GitLab, with a personal
 * access token that has the api scope. Guides are shared the way GitHub
 * Pages sharing does it (core/pages-site.js): each at an unguessable
 * address, g/<random>/, for 1, 7 or 30 days, on a site whose front page
 * never lists them, in pages that ask search engines not to index them.
 *
 * The first publish makes a project, stepforge-guides, in the user's
 * namespace. Its Pages site is public; its repository, pipelines and job
 * logs are for project members only, so nobody else can browse the guides,
 * removed ones included, in its history. Its default branch holds:
 *
 *   stepforge.json             the manifest (core/pages-site.js)
 *   index.html                 the front page
 *   guides/<slug>/index.html   each guide (the interactive HTML export)
 *   guides/<slug>/expires      when it expires, in seconds since 1970
 *   .gitlab-ci.yml             builds the site from guides that haven't expired
 *
 * A pipeline schedule rebuilds the site every hour, so a guide comes down
 * when it expires even while StepForge is closed. Building needs CI runners
 * (on gitlab.com, a verified account).
 */

const PROJECT = 'stepforge-guides';
const MANIFEST = 'stepforge.json';
const CI_FILE = '.gitlab-ci.yml';
const SETUP = 2; // the project settings below; older StepForge projects are brought up to them
const SCHEDULE = 'StepForge: remove expired guides';
const CI = `# Managed by StepForge (stepforge-pages v2). StepForge may replace this file.
# Builds the GitLab Pages site from the guides that haven't expired. A
# pipeline schedule runs it every hour, so expired guides come down.
pages:
  stage: deploy
  image: alpine:3.20
  script:
    - rm -rf public && mkdir public && cp index.html public/index.html
    - |
      now=$(date +%s)
      for dir in guides/*/; do
        [ -f "\${dir}index.html" ] || continue
        expires=$(cat "\${dir}expires" 2>/dev/null || echo 0)
        case "$expires" in ''|*[!0-9]*) continue ;; esac
        [ "$expires" -gt "$now" ] || continue
        slug=$(basename "$dir")
        mkdir -p "public/g/$slug" && cp "\${dir}index.html" "public/g/$slug/index.html"
      done
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
`;
// Public Pages; everything else in the project for its members only.
const PROJECT_SETTINGS = { visibility: 'public', pages_access_level: 'public', repository_access_level: 'private',
  builds_access_level: 'private', public_jobs: false, issues_access_level: 'disabled', wiki_access_level: 'disabled',
  snippets_access_level: 'disabled', merge_requests_access_level: 'disabled', forking_access_level: 'disabled' };

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const expiresFile = (entry) => `${Math.floor(Date.parse(entry.expiresAt) / 1000)}\n`;

class GitLabPages extends PublishAccount {
  /** `language()` is the interface language, for the site's front page. */
  constructor({ language = () => 'en', ...options }) {
    super({ id: 'gitlab', label: 'GitLab Pages', ...options });
    this.language = language;
  }

  async authHeaders() {
    return { 'PRIVATE-TOKEN': this.requireAccount().token, Accept: 'application/json' };
  }

  api(target, options) { return this.authorized(`${this.requireAccount().site}/api/v4/${target}`, options); }

  async connect({ address = '', token = '' } = {}) {
    const origin = normalizeServer(address.trim() || 'gitlab.com').origin;
    if (!token.trim()) throw new Error(t('Paste a personal access token with the api scope.'));
    return this.signInWith({ site: origin, token: token.trim() }, async () => {
      const user = await this.api('user');
      return { account: `@${user.username}`, username: user.username };
    });
  }

  /** The guides project, made the first time and kept to PROJECT_SETTINGS. */
  async project() {
    const account = this.requireAccount();
    let project = account.projectId ? await unlessGone(this.api(`projects/${account.projectId}`)) : null;
    project ||= await unlessGone(this.api(`projects/${encodeURIComponent(`${account.username}/${PROJECT}`)}`));
    if (!project) {
      project = await this.api('projects', json('POST', { name: 'StepForge guides', path: PROJECT,
        description: t('Guides published from StepForge.'), ...PROJECT_SETTINGS }));
    } else if (account.setup !== SETUP || account.projectId !== project.id) {
      project = await this.api(`projects/${project.id}`, json('PUT', PROJECT_SETTINGS));
    }
    if (account.projectId !== project.id || account.setup !== SETUP) {
      Object.assign(account, { projectId: project.id, setup: SETUP });
      this.save();
    }
    return project;
  }

  /** Every file on the branch; none for a new, empty project. */
  async files(project, branch) {
    const found = new Set();
    for (let page = 1; page <= 100; page += 1) {
      const list = await unlessGone(this.api(`projects/${project.id}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`));
      for (const item of list || []) if (item.type === 'blob') found.add(item.path);
      if (!list || list.length < 100) break;
    }
    return found;
  }

  async manifest(project, branch, files) {
    if (!files.has(MANIFEST)) return site.emptyManifest();
    const text = await this.api(`projects/${project.id}/repository/files/${MANIFEST}/raw?ref=${encodeURIComponent(branch)}`, { text: true });
    return site.parseManifest(text);
  }

  /**
   * Write the site for `manifest` in one commit: the guides in `pages`
   * ({ slug: html }), every guide's expiry, and the site's own files. Guides
   * no longer in the manifest, and files from older StepForge layouts, are
   * deleted. Resolves with the commit.
   */
  async commit(project, branch, files, manifest, pages, message) {
    const want = new Map([[MANIFEST, site.serializeManifest(manifest)], ['index.html', site.rootIndex(this.language())], [CI_FILE, CI]]);
    for (const [slug, entry] of Object.entries(manifest.guides)) want.set(`guides/${slug}/expires`, expiresFile(entry));
    for (const [slug, html] of Object.entries(pages)) want.set(`guides/${slug}/index.html`, html);
    const live = new Set(Object.keys(manifest.guides));
    const actions = [...want].map(([path, content]) => ({ action: files.has(path) ? 'update' : 'create', file_path: path, content: base64(content), encoding: 'base64' }));
    for (const path of files) {
      if (want.has(path)) continue;
      const guide = /^guides\/([^/]+)\//.exec(path)?.[1];
      if ((guide && !live.has(guide)) || path.startsWith('public/')) actions.push({ action: 'delete', file_path: path });
    }
    return this.api(`projects/${project.id}/repository/commits`, json('POST', { branch, commit_message: message, actions }));
  }

  /** Rebuild the site every hour, so expired guides come down while StepForge is closed. */
  async schedule(project, branch) {
    const schedules = await this.api(`projects/${project.id}/pipeline_schedules?per_page=100`);
    if ((schedules || []).some((s) => s.description === SCHEDULE)) return;
    await this.api(`projects/${project.id}/pipeline_schedules`, json('POST', { description: SCHEDULE, ref: branch, cron: '17 * * * *', cron_timezone: 'UTC', active: true }));
  }

  /** The Pages site's address, ending in "/", once GitLab has one. */
  async siteUrl(project) {
    const pages = await this.api(`projects/${project.id}/pages`).catch(() => null);
    if (!pages?.url) return null;
    const url = pages.url.endsWith('/') ? pages.url : `${pages.url}/`;
    if (this.credentials && this.credentials.pagesUrl !== url) { this.credentials.pagesUrl = url; this.save(); }
    return url;
  }

  linkFor(slug) {
    const base = this.credentials?.pagesUrl;
    return base ? site.guideUrl(base, slug) : '';
  }

  /** Read the site, change it with core/pages-site.js's planSite, and write it back. */
  async change(plan, { pages = () => ({}), message }) {
    const project = await this.project();
    const branch = project.default_branch || 'main';
    const files = await this.files(project, branch);
    const before = await this.manifest(project, branch, files);
    const next = site.planSite(before, { now: Date.now(), ...plan });
    const commit = await this.commit(project, branch, files, next.manifest, pages(next.slug), message);
    await this.schedule(project, branch);
    return { project, before, next, commit };
  }

  /**
   * Share one guide for `days` days. Publishing a guide again keeps its
   * link and starts its time again. Resolves once the page loads, or with
   * a note saying why it doesn't yet.
   */
  async publish({ guideId, title, page, days = site.DEFAULT_EXPIRY_DAYS, onProgress = () => {} }) {
    const html = site.prepareGuideHtml(page.html);
    if (Buffer.byteLength(html) > site.MAX_GUIDE_BYTES) throw new Error(t('This guide is larger than 50 MB. Publish fewer steps or smaller screenshots.'));
    onProgress({ stage: 'page' });
    const { project, before, next, commit } = await this.change({ publish: { guideId, title, days } },
      { pages: (slug) => ({ [slug]: html }), message: `Publish “${title}” from StepForge` });
    const slug = next.slug;
    // Hand over the link only once it works: GitLab builds the site, then
    // Pages keeps serving the last deployment for up to a minute.
    onProgress({ stage: 'live' });
    const { url, live, waiting } = await this.waitUntilLive(project, commit.id, `g/${slug}/`);
    const entry = next.manifest.guides[slug];
    return this.published(guideId, { id: project.id, slug, title, url }, {
      updated: Boolean(before.guides[slug]) && !site.isExpired(before.guides[slug]), live, expiresAt: entry.expiresAt,
      ...(live ? {} : { note: ['created', 'pending', 'waiting_for_resource'].includes(waiting)
        ? t('GitLab hasn’t started building the site. It needs a CI runner; on gitlab.com, that means a verified account. The link works once the pipeline has run.')
        : t('GitLab is still building the site. The link works once it’s done.') }),
    });
  }

  /** The guides shared now: { slug, guideId, title, publishedAt, expiresAt, url }, soonest to expire first. */
  async shared() {
    const project = await this.project();
    const branch = project.default_branch || 'main';
    const manifest = await this.manifest(project, branch, await this.files(project, branch));
    if (!this.credentials.pagesUrl) await this.siteUrl(project);
    return Object.entries(manifest.guides).filter(([, entry]) => !site.isExpired(entry))
      .map(([slug, entry]) => ({ slug, ...entry, url: this.linkFor(slug) || `${project.web_url}/pages` }))
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  /** The guide's current share, or null: what the publish dialog says about it. */
  async sharedFor(guideId) {
    return (await this.shared()).find((guide) => guide.guideId === guideId) || null;
  }

  /** Stop sharing a guide; GitLab takes its page down when the site is rebuilt. */
  async unpublish({ slug }) {
    if (!site.isSlug(slug)) throw new Error(t('Unknown shared guide.'));
    await this.change({ remove: slug }, { message: 'Remove a guide shared from StepForge' });
    return this.shared();
  }

  async extend({ slug, days }) {
    if (!site.isSlug(slug)) throw new Error(t('Unknown shared guide.'));
    await this.change({ extend: { slug, days } }, { message: 'Extend a guide shared from StepForge' });
    return this.shared();
  }

  /** Take expired guides out of the project; used after launch while connected. */
  async sweep() {
    if (!this.credentials?.projectId) return 0;
    const project = await this.project();
    const branch = project.default_branch || 'main';
    const manifest = await this.manifest(project, branch, await this.files(project, branch));
    const expired = Object.values(manifest.guides).filter((entry) => site.isExpired(entry)).length;
    if (expired) await this.change({}, { message: 'Remove expired StepForge guides' });
    return expired;
  }

  /**
   * Wait until the pipeline for commit `sha` has deployed the site and
   * `path` on it loads. Resolves with { url, live }, and `waiting` (the
   * pipeline's status) when the deadline passes first. A failed pipeline is
   * an error, with a link to it.
   */
  async waitUntilLive(project, sha, path, { deadline = Date.now() + 10 * 60000 } = {}) {
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
      url ||= await this.siteUrl(project).then((base) => (base ? `${base}${path}` : null));
      if (!url) continue;
      // Without the token: this is the public site, not the API.
      const response = await this.request(`${url}?stepforge=${Date.now()}`, { method: 'HEAD', raw: true, redirect: 'manual', timeout: 15000 }).catch(() => null);
      if (response && response.status < 400) return { url, live: true };
    }
    return { url: url || `${project.web_url}/pages`, live: false, waiting };
  }
}

module.exports = { GitLabPages, CI, PROJECT_SETTINGS, MANIFEST };
