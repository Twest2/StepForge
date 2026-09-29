'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { GitHubPages } = require('../../app/github-pages');
const site = require('../../core/pages-site');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

const CLIENT_ID = 'Iv23liTestClient';
const APP_SLUG = 'stepforge-test';
const DAY = 24 * 60 * 60 * 1000;

/**
 * An in-memory GitHub: the device flow, installations, the Contents, Pages
 * and Git Data APIs, backed by real blob/tree/commit/ref objects so tests
 * can inspect the branch GitHub would serve.
 */
function fakeGitHub({ empty = true, allowWorkflows = true, allowPages = true, privateRepo = false, tokenExpiresIn = null } = {}) {
  const hash = (value) => crypto.createHash('sha1').update(value).digest('hex');
  const gh = {
    token: null,
    refreshToken: null,
    polls: 0,
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    refs: new Map(),
    contents: new Map(),
    pages: null,
    empty,
    requests: [],
    installed: ['octo/stepforge-guides'],
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => json({ message: 'Not Found' }, 404);
  const issue = () => {
    gh.token = `token-${crypto.randomBytes(4).toString('hex')}`;
    gh.refreshToken = `refresh-${crypto.randomBytes(4).toString('hex')}`;
    return { access_token: gh.token, token_type: 'bearer', ...(tokenExpiresIn ? { expires_in: tokenExpiresIn, refresh_token: gh.refreshToken, refresh_token_expires_in: 15897600 } : {}) };
  };

  gh.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const method = options.method || 'GET';
    gh.requests.push(`${method} ${u.pathname}`);
    assert.equal(options.redirect, 'error');
    if (u.origin === 'https://github.com') {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('client_id'), CLIENT_ID);
      assert.equal(params.get('client_secret'), null, 'the device flow never sends a client secret');
      if (u.pathname === '/login/device/code') {
        return json({ device_code: 'device-123', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      if (u.pathname === '/login/oauth/access_token' && params.get('grant_type') === 'refresh_token') {
        return params.get('refresh_token') === gh.refreshToken ? json(issue()) : json({ error: 'bad_refresh_token' });
      }
      if (u.pathname === '/login/oauth/access_token') {
        assert.equal(params.get('device_code'), 'device-123');
        gh.polls += 1;
        if (gh.polls === 1) return json({ error: 'authorization_pending' });
        if (gh.polls === 2) return json({ error: 'slow_down', interval: 10 });
        if (gh.deny) return json({ error: 'access_denied' });
        return json(issue());
      }
      return notFound();
    }
    assert.equal(u.origin, 'https://api.github.com');
    if (options.headers?.Authorization !== `Bearer ${gh.token}`) return json({ message: 'Bad credentials' }, 401);
    const body = options.body ? JSON.parse(options.body) : null;
    const p = u.pathname;
    if (p === '/user') return json({ login: 'octo' });
    if (p === '/user/installations') return json({ installations: [{ id: 7, app_slug: APP_SLUG }, { id: 8, app_slug: 'someone-else' }] });
    if (p === '/user/installations/7/repositories') return json({ repositories: gh.installed.map((full_name) => ({ full_name, private: privateRepo })) });
    if (p === '/user/installations/8/repositories') return json({ repositories: [{ full_name: 'octo/unrelated', private: false }] });

    const repo = /^\/repos\/octo\/stepforge-guides(\/.*)?$/.exec(p);
    if (!repo || !gh.installed.includes('octo/stepforge-guides')) return notFound();
    const rest = repo[1] || '';
    if (!rest) return json({ full_name: 'octo/stepforge-guides', private: privateRepo, default_branch: 'main' });
    if (rest === '/branches/main') return gh.empty ? notFound() : json({ name: 'main' });
    const content = /^\/contents\/(.+)$/.exec(rest);
    if (content) {
      const file = decodeURIComponent(content[1]);
      if (method === 'GET') return gh.contents.has(file) ? json(gh.contents.get(file)) : notFound();
      if (file.startsWith('.github/workflows/') && !allowWorkflows) {
        return json({ message: 'Resource not accessible by integration' }, 403);
      }
      const existing = gh.contents.get(file);
      if (existing && body.sha !== existing.sha) return json({ message: 'sha mismatch' }, 409);
      gh.contents.set(file, { content: body.content, sha: hash(body.content) });
      gh.empty = false;
      return json({ content: { path: file } }, existing ? 200 : 201);
    }
    if (rest === '/pages') {
      if (!allowPages) return json({ message: 'Resource not accessible by integration' }, 403);
      if (method === 'GET') return gh.pages ? json(gh.pages) : notFound();
      assert.deepEqual(body.source, { branch: 'gh-pages', path: '/' });
      if (method === 'POST') {
        if (!gh.refs.has('gh-pages')) return json({ message: 'branch does not exist' }, 422);
        gh.pages = { source: body.source, html_url: 'https://octo.github.io/stepforge-guides/' };
        return json(gh.pages, 201);
      }
      gh.pages.source = body.source;
      return new Response(null, { status: 204 });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      assert.equal(body.encoding, 'base64');
      const bytes = Buffer.from(body.content, 'base64');
      const sha = hash(bytes);
      gh.blobs.set(sha, bytes);
      return json({ sha }, 201);
    }
    const blob = /^\/git\/blobs\/(\w+)$/.exec(rest);
    if (blob) return gh.blobs.has(blob[1]) ? new Response(gh.blobs.get(blob[1])) : notFound();
    if (rest === '/git/trees' && method === 'POST') {
      assert.equal(body.base_tree, undefined, 'the site tree is always built from scratch');
      for (const entry of body.tree) assert.ok(gh.blobs.has(entry.sha), `tree entry ${entry.path} points at a missing blob`);
      const sha = hash(JSON.stringify(body.tree));
      gh.trees.set(sha, body.tree.map((entry) => ({ path: entry.path, type: 'blob', sha: entry.sha })));
      return json({ sha }, 201);
    }
    const tree = /^\/git\/trees\/(\w+)$/.exec(rest);
    if (tree) return json({ tree: gh.trees.get(tree[1]) });
    if (rest === '/git/commits' && method === 'POST') {
      const sha = hash(JSON.stringify(body) + crypto.randomBytes(4).toString('hex'));
      gh.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha }, 201);
    }
    const commit = /^\/git\/commits\/(\w+)$/.exec(rest);
    if (commit) return json({ tree: { sha: gh.commits.get(commit[1]).tree } });
    if (rest === '/git/ref/heads/gh-pages') return gh.refs.has('gh-pages') ? json({ object: { sha: gh.refs.get('gh-pages') } }) : notFound();
    if (rest === '/git/refs' && method === 'POST') {
      assert.equal(body.ref, 'refs/heads/gh-pages');
      gh.refs.set('gh-pages', body.sha);
      return json({}, 201);
    }
    if (rest === '/git/refs/heads/gh-pages' && method === 'PATCH') {
      assert.equal(body.force, true);
      gh.refs.set('gh-pages', body.sha);
      return json({});
    }
    return notFound();
  };

  /** The files on the Pages branch, as GitHub Pages would build them. */
  gh.branch = () => {
    const head = gh.commits.get(gh.refs.get('gh-pages'));
    const files = new Map(gh.trees.get(head.tree).map((entry) => [entry.path, gh.blobs.get(entry.sha).toString('utf8')]));
    return { head, files, manifest: JSON.parse(files.get(site.MANIFEST_PATH)) };
  };
  return gh;
}

function setup(t, { gh = fakeGitHub(), clock = { now: Date.parse('2026-09-29T12:00:00Z') }, ...options } = {}) {
  const directory = makeTmpDir('github-pages');
  t.after(() => rmrf(directory));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString(); },
  };
  const opened = [];
  const statuses = [];
  const make = () => new GitHubPages({
    directory, safeStorage, clientId: CLIENT_ID, appSlug: APP_SLUG, fetchImpl: gh.fetch,
    now: () => clock.now, wait: async () => {}, openExternal: async (url) => { opened.push(url); },
    onStatus: (status) => statuses.push(status), ...options,
  });
  const pages = make();
  t.after(() => pages.cancel());
  return { pages, gh, clock, directory, safeStorage, opened, statuses, make };
}

function exportedGuide(t) {
  const dir = makeTmpDir('github-pages-guide');
  t.after(() => rmrf(dir));
  const { store, guide } = buildFixtureGuide(dir);
  const result = runExport('html-rich', buildRenderAst(store, guide.guideId), `${dir}/out`);
  return { guideId: guide.guideId, title: 'Configure AcmeSync backups', html: fs.readFileSync(result.file, 'utf8') };
}

async function connected(t, options) {
  const ctx = setup(t, options);
  await ctx.pages.connect();
  return ctx;
}

test('device sign-in shows a code, waits for approval and stores only an encrypted token', async (t) => {
  const { pages, gh, directory, opened, statuses, safeStorage } = setup(t);
  assert.equal(pages.status().connected, false);
  const status = await pages.connect();
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.ok(statuses.some((s) => s.pending?.userCode === 'WDJB-MJHT'), 'the code is shown while waiting');
  assert.equal(gh.polls, 3, 'keeps polling through authorization_pending and slow_down');
  assert.equal(status.connected, true);
  assert.equal(status.login, 'octo');
  assert.equal(status.pending, null);
  assert.doesNotMatch(JSON.stringify(status), /token/i, 'status never carries the token');

  const stored = fs.readFileSync(`${directory}/github.credentials`);
  assert.ok(!stored.includes(Buffer.from(gh.token)), 'token is not stored in plain text');
  assert.equal(JSON.parse(safeStorage.decryptString(stored)).access_token, gh.token);
});

test('declined or cancelled sign-in leaves nothing stored', async (t) => {
  const gh = fakeGitHub();
  gh.deny = true;
  const { pages, directory } = setup(t, { gh });
  await assert.rejects(pages.connect(), /cancelled on github.com/);
  assert.equal(pages.status().connected, false);
  assert.equal(fs.existsSync(`${directory}/github.credentials`), false);

  let release;
  const ctx = setup(t, { wait: () => new Promise((resolve) => { release = resolve; }) });
  const signingIn = ctx.pages.connect();
  await new Promise((resolve) => setImmediate(resolve));
  ctx.pages.cancel();
  await assert.rejects(signingIn, /cancelled/);
  assert.equal(ctx.pages.status().connected, false);
  release();
});

test('a new empty repository gets a README, the clean-up workflow, a Pages branch and Pages turned on', async (t) => {
  const { pages, gh } = await connected(t);
  assert.deepEqual((await pages.repositories()).map((repo) => repo.fullName), ['octo/stepforge-guides'],
    'only repositories the StepForge App is installed on are offered');
  const status = await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.equal(status.repo, 'octo/stepforge-guides');
  assert.equal(status.pagesReady, true);
  assert.equal(status.autoExpire, true);
  assert.equal(status.setupNote, '');
  assert.equal(status.siteUrl, 'https://octo.github.io/stepforge-guides/');
  assert.equal(Buffer.from(gh.contents.get(site.README_PATH).content, 'base64').toString(), site.README);
  assert.equal(Buffer.from(gh.contents.get(site.WORKFLOW_PATH).content, 'base64').toString(), site.WORKFLOW);
  const { head, files, manifest } = gh.branch();
  assert.deepEqual(head.parents, []);
  assert.deepEqual([...files.keys()].sort(), [site.MANIFEST_PATH, site.ROOT_INDEX_PATH]);
  assert.deepEqual(manifest.guides, {});

  // Running setup again changes nothing that is already right.
  const commitsBefore = gh.commits.size;
  await pages.setup();
  assert.equal(gh.commits.size, commitsBefore);
});

test('a repository the App is not installed on is refused', async (t) => {
  const { pages } = await connected(t);
  await assert.rejects(pages.selectRepository({ fullName: 'octo/unrelated-repo' }), /isn't installed on octo\/unrelated-repo/);
  await assert.rejects(pages.selectRepository({ fullName: '../../etc' }), /Choose a repository/);
  assert.equal(pages.status().repo, '');
});

test('missing Workflows or Pages permissions leave instructions instead of failing', async (t) => {
  const { pages } = await connected(t, { gh: fakeGitHub({ allowWorkflows: false, allowPages: false }) });
  const status = await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.equal(status.autoExpire, false);
  assert.equal(status.pagesReady, false);
  assert.match(status.setupNote, /Workflows permission/);
  assert.match(status.setupNote, /Settings → Pages/);
  assert.equal(status.links.pagesSettings, 'https://github.com/octo/stepforge-guides/settings/pages');
});

test('publishing, republishing and removing always leave a single-commit Pages branch', async (t) => {
  const { pages, gh, clock } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  const guide = exportedGuide(t);

  const first = await pages.publish({ ...guide, days: 7 });
  assert.match(first.url, /^https:\/\/octo\.github\.io\/stepforge-guides\/g\/[a-f0-9]{24}\/$/);
  assert.equal(first.expiresAt, new Date(clock.now + 7 * DAY).toISOString());
  let branch = gh.branch();
  assert.deepEqual(branch.head.parents, [], 'no history is kept on the Pages branch');
  const page = branch.files.get(site.guidePath(first.slug));
  assert.match(page, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(page, /Configure AcmeSync backups/);
  assert.equal(branch.manifest.guides[first.slug].guideId, guide.guideId);
  assert.doesNotMatch(branch.files.get(site.ROOT_INDEX_PATH), new RegExp(first.slug), 'the site root does not link to guides');

  const other = await pages.publish({ guideId: 'guide-b', title: 'Second guide', html: '<html><head></head><body>two</body></html>', days: 1 });
  clock.now += 60 * 1000;
  const again = await pages.publish({ ...guide, html: guide.html.replace('Configure AcmeSync backups', 'Updated title'), days: 30 });
  assert.equal(again.slug, first.slug, 'republishing keeps the same link');
  branch = gh.branch();
  assert.match(branch.files.get(site.guidePath(first.slug)), /Updated title/);
  assert.equal(branch.files.get(site.guidePath(other.slug)).includes('two'), true, 'other guides are kept');

  const remaining = await pages.unpublish({ slug: first.slug });
  assert.deepEqual(remaining.map((entry) => entry.slug), [other.slug]);
  branch = gh.branch();
  assert.deepEqual(branch.head.parents, []);
  assert.equal(branch.files.has(site.guidePath(first.slug)), false);
  assert.deepEqual(Object.keys(branch.manifest.guides), [other.slug]);
});

test('a custom domain GitHub wrote to the Pages branch survives publishing', async (t) => {
  const { pages, gh } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  // What GitHub does when the user sets a custom domain in Settings → Pages.
  const cname = Buffer.from('guides.example.com\n');
  const cnameSha = crypto.createHash('sha1').update(cname).digest('hex');
  gh.blobs.set(cnameSha, cname);
  const head = gh.commits.get(gh.refs.get('gh-pages'));
  const treeSha = crypto.createHash('sha1').update('with-cname').digest('hex');
  gh.trees.set(treeSha, [...gh.trees.get(head.tree), { path: 'CNAME', type: 'blob', sha: cnameSha }]);
  const commitSha = crypto.createHash('sha1').update('cname-commit').digest('hex');
  gh.commits.set(commitSha, { tree: treeSha, parents: [] });
  gh.refs.set('gh-pages', commitSha);

  await pages.publish({ guideId: 'g', title: 'Guide', html: '<head></head>page', days: 7 });
  assert.equal(gh.branch().files.get('CNAME'), 'guides.example.com\n');
});

test('expired guides are removed when StepForge checks the site', async (t) => {
  const { pages, gh, clock } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  const short = await pages.publish({ guideId: 'short', title: 'Short', html: '<head></head>short', days: 1 });
  const long = await pages.publish({ guideId: 'long', title: 'Long', html: '<head></head>long', days: 30 });
  assert.equal(await pages.sweep(), 0);

  clock.now += 2 * DAY;
  assert.equal(await pages.sweep(), 1);
  const { files, manifest } = gh.branch();
  assert.equal(files.has(site.guidePath(short.slug)), false);
  assert.deepEqual(Object.keys(manifest.guides), [long.slug]);
  assert.deepEqual((await pages.published()).map((entry) => entry.slug), [long.slug]);
});

test('publishing refuses bad input before contacting GitHub', async (t) => {
  const { pages, gh } = await connected(t);
  await assert.rejects(async () => pages.publish({ guideId: 'g', title: 't', html: '<head></head>', days: 7 }), /Choose a repository/);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  const before = gh.requests.length;
  assert.throws(() => pages.publish({ guideId: 'g', title: 't', html: '<head></head>', days: 3 }), /1, 7, 30 days/);
  assert.throws(() => pages.publish({ guideId: 'g', title: 't', html: '<head></head>'.padEnd(51 * 1024 * 1024, 'x'), days: 7 }), /larger than 50 MB/);
  assert.throws(() => pages.unpublish({ slug: '../main' }), /Unknown shared guide/);
  assert.equal(gh.requests.length, before);
});

test('an expiring user token is refreshed without a client secret and kept across restarts', async (t) => {
  const { pages, gh, clock, make } = await connected(t, { gh: fakeGitHub({ tokenExpiresIn: 28800 }) });
  const firstToken = gh.token;
  clock.now += 9 * 60 * 60 * 1000;
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.notEqual(gh.token, firstToken);

  const restarted = make();
  assert.equal(restarted.status().connected, true);
  assert.equal(restarted.status().repo, 'octo/stepforge-guides');
  assert.equal((await restarted.published()).length, 0);
});

test('disconnecting forgets the account on this computer', async (t) => {
  const { pages, directory, make } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  pages.disconnect();
  assert.equal(pages.status().connected, false);
  assert.equal(fs.existsSync(`${directory}/github.credentials`), false);
  assert.equal(make().status().connected, false);
});

test('without a GitHub App configured, sign-in is unavailable', async (t) => {
  const { pages } = setup(t, { clientId: '', appSlug: '' });
  assert.equal(pages.status().available, false);
  await assert.rejects(pages.connect(), /unavailable in this build/);
});
