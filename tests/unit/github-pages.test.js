'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GitHubPages, resolveAppConfig } = require('../../app/github-pages');
const { configureGitHubApp } = require('../../scripts/configure-github-app');
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
function fakeGitHub({ empty = true, allowWorkflows = true, allowPages = true, privateRepo = false, tokenExpiresIn = null,
  files = {}, existingPages = null, foreignPagesBranch = false } = {}) {
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
    // How many more times Git data requests answer 409 after the first commit.
    emptyLag: 0,
    liveChecks: 0,
    liveAfter: 0,
    offline: 0,
    streamed: 0,
    revoked: false,
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
    if (gh.offline) { gh.offline -= 1; throw new TypeError('fetch failed'); }
    // The published site itself: 404 until GitHub Pages has built it.
    if (u.origin === 'https://octo.github.io') {
      assert.equal(method, 'HEAD');
      gh.liveChecks += 1;
      return new Response(null, { status: gh.liveChecks > gh.liveAfter ? 200 : 404 });
    }
    assert.equal(options.redirect, 'error');
    let bodyText = options.body;
    if (options.body instanceof ReadableStream) {
      // A streamed upload must say how big it is up front.
      bodyText = await new Response(options.body).text();
      assert.equal(options.headers['Content-Length'], String(Buffer.byteLength(bodyText)));
      gh.streamed += 1;
    }
    if (u.origin === 'https://github.com') {
      const params = new URLSearchParams(bodyText);
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
    if (gh.revoked || options.headers?.Authorization !== `Bearer ${gh.token}`) return json({ message: 'Bad credentials' }, 401);
    const body = bodyText ? JSON.parse(bodyText) : null;
    const p = u.pathname;
    if (p === '/user') return json({ login: 'octo' });
    if (p === '/user/installations') return json({ installations: [{ id: 7, app_slug: APP_SLUG }, { id: 8, app_slug: 'someone-else' }] });
    if (p === '/user/installations/7/repositories') return json({ repositories: gh.installed.map((full_name) => ({ full_name, private: privateRepo })) });
    if (p === '/user/installations/8/repositories') return json({ repositories: [{ full_name: 'octo/unrelated', private: false }] });

    const repo = /^\/repos\/octo\/stepforge-guides(\/.*)?$/.exec(p);
    if (!repo || !gh.installed.includes('octo/stepforge-guides')) return notFound();
    const rest = repo[1] || '';
    if (!rest) return json({ full_name: 'octo/stepforge-guides', private: privateRepo, default_branch: 'main' });
    // Like GitHub: Git data in a repository with no commits is a 409, and it
    // can stay that way for a moment after the first commit.
    if (rest.startsWith('/git/') && (gh.empty || (gh.emptyLag > 0 && gh.emptyLag--))) return json({ message: 'Git Repository is empty.' }, 409);
    if (rest === '/branches/main') return gh.empty ? notFound() : json({ name: 'main' });
    if (rest === '/contents' && method === 'GET') {
      if (gh.empty) return notFound();
      const names = [...new Set([...gh.contents.keys()].map((file) => file.split('/')[0]))];
      return json(names.map((name) => ({ name, type: gh.contents.has(name) ? 'file' : 'dir' })));
    }
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
        // GitHub can switch Pages on by itself when a gh-pages branch appears.
        if (gh.autoPages) return json({ message: 'GitHub Pages is already enabled.' }, 409);
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

  // Start from an existing repository instead of a brand-new one.
  for (const [file, text] of Object.entries(files)) {
    const encoded = Buffer.from(text).toString('base64');
    gh.contents.set(file, { content: encoded, sha: hash(encoded) });
    gh.empty = false;
  }
  if (existingPages) gh.pages = existingPages;
  if (foreignPagesBranch) {
    const bytes = Buffer.from('<h1>My project site</h1>');
    const blobSha = hash(bytes);
    gh.blobs.set(blobSha, bytes);
    gh.trees.set('f'.repeat(40), [{ path: 'index.html', type: 'blob', sha: blobSha }]);
    gh.commits.set('e'.repeat(40), { tree: 'f'.repeat(40), parents: [] });
    gh.refs.set('gh-pages', 'e'.repeat(40));
  }

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

test('sign-in never waits for the browser, and the code is copied for pasting', async (t) => {
  const copied = [];
  // On some systems opening a URL only returns once the browser closes.
  const { pages } = setup(t, { openExternal: () => new Promise(() => {}), copyText: (text) => copied.push(text) });
  const statuses = [];
  pages.onStatus = (status) => statuses.push(status);
  const status = await pages.connect();
  assert.equal(status.connected, true, 'signs in although the browser call never returned');
  assert.deepEqual(copied, ['WDJB-MJHT']);
  assert.equal(statuses.find((s) => s.pending)?.pending.copied, true);
});

test('starting sign-in again replaces a sign-in that is still waiting', async (t) => {
  const waits = [];
  const { pages, statuses } = setup(t, { wait: () => new Promise((resolve) => { waits.push(resolve); }) });
  const first = pages.connect();
  first.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pages.status().pending?.userCode, 'WDJB-MJHT');

  pages.wait = async () => {};
  const second = await pages.connect();
  assert.equal(second.connected, true);
  await assert.rejects(first, /cancelled/);
  assert.equal(pages.status().connected, true, 'the replaced sign-in does not undo the new one');
  assert.equal(statuses.at(-1).connected, true);
  for (const resolve of waits) resolve();
});

test('cancelling sign-in leaves a publish that is running alone', async (t) => {
  const { pages } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  const publishing = pages.publish({ guideId: 'g', title: 'Guide', html: '<head></head>page', days: 7 });
  pages.cancelSignIn();
  assert.match((await publishing).url, /\/g\/[a-f0-9]{24}\/$/);
});

test('a dropped connection while waiting for approval does not end the sign-in', async (t) => {
  const gh = fakeGitHub();
  const { pages } = setup(t, { gh });
  const polling = pages.connect();
  gh.offline = 1;
  gh.polls = 0;
  const status = await polling;
  assert.equal(status.connected, true);
});

test('no connection at all gives a plain explanation', async (t) => {
  const gh = fakeGitHub();
  gh.offline = 1;
  const { pages } = setup(t, { gh });
  await assert.rejects(pages.connect(), /couldn’t reach GitHub\. Check your internet connection/);
  assert.equal(pages.status().pending, null);
});

test('a revoked sign-in asks to sign in again and keeps the chosen repository', async (t) => {
  const { pages, gh } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  gh.revoked = true;
  await assert.rejects(pages.published(), /Sign in again to keep sharing guides/);
  let status = pages.status();
  assert.equal(status.connected, true);
  assert.equal(status.needsSignIn, true);
  assert.match(status.error, /Sign in again/);
  assert.throws(() => pages.publish({ guideId: 'g', title: 't', html: '<head></head>', days: 7 }), /Sign in again/, 'fails before exporting or uploading');

  gh.revoked = false;
  gh.polls = 0;
  status = await pages.connect();
  assert.equal(status.needsSignIn, false);
  assert.equal(status.error, null);
  assert.equal(status.repo, 'octo/stepforge-guides', 'no need to choose the repository again');
  assert.deepEqual(await pages.published(), []);
});

test('an empty repository that GitHub still reports as empty after the first commit is set up once it catches up', async (t) => {
  const gh = fakeGitHub();
  const { pages } = await connected(t, { gh });
  gh.emptyLag = 2;
  const status = await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.equal(status.pagesReady, true);
  assert.deepEqual(Object.keys(gh.branch().manifest.guides), []);
});

test('Pages that GitHub already turned on for the new branch is picked up', async (t) => {
  const gh = fakeGitHub();
  gh.autoPages = true;
  const { pages } = await connected(t, { gh });
  const status = await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.equal(status.pagesReady, true);
  assert.equal(status.setupNote, '');
});

test('setting up a repository says what it is doing', async (t) => {
  const { pages } = await connected(t);
  const steps = [];
  await pages.selectRepository({ fullName: 'octo/stepforge-guides', onProgress: (p) => steps.push(p.message) });
  assert.deepEqual(steps, [
    'Checking octo/stepforge-guides…', 'Checking the repository…', 'Adding a README…',
    'Adding the clean-up workflow…', 'Creating the site…', 'Turning on GitHub Pages…',
  ]);
});

test('publishing reports upload progress in the guide’s own bytes, then the commit', async (t) => {
  const { pages, gh } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  const html = `<html><head></head><body>${'x'.repeat(900 * 1024)}</body></html>`;
  const events = [];
  const entry = await pages.publish({ guideId: 'big', title: 'Big', html, days: 7, onProgress: (p) => events.push(p) });
  assert.equal(gh.streamed, 1, 'only the guide itself is streamed');
  const uploads = events.filter((p) => p.stage === 'upload');
  const size = Buffer.byteLength(site.prepareGuideHtml(html));
  assert.ok(uploads.length > 2, 'reports several times while uploading');
  assert.deepEqual(uploads.map((p) => p.total), uploads.map(() => size));
  assert.equal(uploads[0].loaded, 0);
  assert.equal(uploads.at(-1).loaded, size);
  assert.ok(uploads.every((p, i) => !i || p.loaded >= uploads[i - 1].loaded), 'never goes backwards');
  assert.deepEqual(events.at(-1), { stage: 'commit' });
  assert.equal(gh.branch().files.get(site.guidePath(entry.slug)), site.prepareGuideHtml(html));
});

test('the link is worked out without contacting GitHub, and StepForge can tell when it is live', async (t) => {
  const { pages, gh } = await connected(t);
  await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  const entry = await pages.publish({ guideId: 'g', title: 'Guide', html: '<head></head>page', days: 7 });
  const before = gh.requests.length;
  assert.equal(pages.linkFor(entry.slug), entry.url);
  assert.equal(pages.linkFor('../../x'), null);
  assert.equal(gh.requests.length, before);

  gh.liveAfter = 3;
  assert.equal(await pages.waitUntilLive(entry.slug), true);
  assert.equal(gh.liveChecks, 4);
  const checked = gh.requests.slice(before).filter((r) => r.startsWith('HEAD '));
  assert.ok(checked.every((r) => r === `HEAD /stepforge-guides/g/${entry.slug}/`));

  gh.liveChecks = 0;
  gh.liveAfter = Infinity;
  assert.equal(await pages.waitUntilLive(entry.slug, { attempts: 5 }), false, 'gives up instead of waiting forever');
  assert.equal(gh.liveChecks, 5);
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

const repoWrites = (gh) => gh.requests.filter((request) => !request.startsWith('GET ') && request.includes('/repos/'));
const fileText = (gh, file) => Buffer.from(gh.contents.get(file).content, 'base64').toString();

test('a new repository GitHub created with a README is used without asking, and its README is kept', async (t) => {
  const { pages, gh } = await connected(t, { gh: fakeGitHub({ files: { 'README.md': '# My guides\n', LICENSE: 'MIT' } }) });
  const status = await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.equal(status.repo, 'octo/stepforge-guides');
  assert.equal(fileText(gh, 'README.md'), '# My guides\n');
  assert.equal(fileText(gh, site.WORKFLOW_PATH), site.WORKFLOW);
});

test('an existing repository is used only after confirmation, and only gains the workflow and a Pages branch', async (t) => {
  const files = { 'README.md': '# Widget\n', 'src/app.js': 'console.log(1);\n' };
  const { pages, gh } = await connected(t, { gh: fakeGitHub({ files }) });

  const asked = await pages.selectRepository({ fullName: 'octo/stepforge-guides' });
  assert.equal(asked.needsConfirmation, true);
  assert.equal(asked.repo, 'octo/stepforge-guides');
  assert.match(asked.changes.join('\n'), /stepforge-expire\.yml to the main branch/);
  assert.match(asked.changes.join('\n'), /gh-pages branch/);
  assert.equal(pages.status().repo, '', 'nothing is chosen until the user confirms');
  assert.deepEqual(repoWrites(gh), [], 'nothing is written before the user confirms');

  const status = await pages.selectRepository({ fullName: 'octo/stepforge-guides', useExisting: true });
  assert.equal(status.repo, 'octo/stepforge-guides');
  assert.equal(status.pagesReady, true);
  assert.equal(fileText(gh, 'README.md'), '# Widget\n', 'the project README is not replaced');
  assert.equal(fileText(gh, 'src/app.js'), 'console.log(1);\n');
  assert.deepEqual([...gh.contents.keys()].sort(), ['README.md', site.WORKFLOW_PATH, 'src/app.js'].sort());
  assert.deepEqual(Object.keys(gh.branch().manifest.guides), []);

  // Coming back to a repository StepForge already set up needs no confirmation.
  pages.clearRepository();
  assert.equal((await pages.selectRepository({ fullName: 'octo/stepforge-guides' })).repo, 'octo/stepforge-guides');
});

test('a repository that already publishes a GitHub Pages site is refused before anything is written', async (t) => {
  const files = { 'README.md': '# Docs\n', 'docs/index.md': 'hi' };
  for (const [existingPages, reason] of [
    [{ source: { branch: 'main', path: '/docs' }, build_type: 'legacy', html_url: 'https://octo.github.io/stepforge-guides/' }, /already publishes a GitHub Pages site from the main branch/],
    [{ source: { branch: 'gh-pages', path: '/' }, build_type: 'workflow', html_url: 'https://octo.github.io/stepforge-guides/' }, /already publishes a GitHub Pages site with GitHub Actions/],
  ]) {
    const { pages, gh } = await connected(t, { gh: fakeGitHub({ files, existingPages }) });
    await assert.rejects(pages.selectRepository({ fullName: 'octo/stepforge-guides', useExisting: true }), reason);
    assert.equal(pages.status().repo, '');
    assert.deepEqual(repoWrites(gh), []);
  }
});

test('a gh-pages branch StepForge did not create is never replaced', async (t) => {
  const { pages, gh } = await connected(t, { gh: fakeGitHub({ files: { 'README.md': '# Site\n' }, foreignPagesBranch: true }) });
  await assert.rejects(pages.selectRepository({ fullName: 'octo/stepforge-guides', useExisting: true }), /gh-pages branch that StepForge didn't create/);
  assert.deepEqual(repoWrites(gh), []);
  assert.equal(gh.refs.get('gh-pages'), 'e'.repeat(40));
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

test('release builds refuse to ship without the StepForge GitHub App, and stamp it when configured', (t) => {
  const dir = makeTmpDir('github-app-config');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'github-app-config.json');
  fs.writeFileSync(file, JSON.stringify({ clientId: '', appSlug: '' }));

  assert.throws(() => configureGitHubApp({ file }), /missing StepForge's GitHub App client ID/);
  assert.throws(() => configureGitHubApp({ file, clientId: 'not-a-client', appSlug: APP_SLUG }), /client ID/);
  assert.throws(() => configureGitHubApp({ file, clientId: CLIENT_ID }), /missing StepForge's GitHub App slug/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { clientId: '', appSlug: '' });

  configureGitHubApp({ file, clientId: ` ${CLIENT_ID} `, appSlug: APP_SLUG });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { clientId: CLIENT_ID, appSlug: APP_SLUG });
  // A registration already committed to the config also satisfies a release.
  configureGitHubApp({ file });

  const app = resolveAppConfig({ committed: JSON.parse(fs.readFileSync(file)), env: {}, localFile: path.join(dir, 'none.json') });
  assert.deepEqual(app, { clientId: CLIENT_ID, appSlug: APP_SLUG, source: 'release' });
  const { pages } = setup(t, { clientId: app.clientId, appSlug: app.appSlug });
  assert.equal(pages.status().available, true);
});
