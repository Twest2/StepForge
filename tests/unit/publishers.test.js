'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { pageFromHtml, fillImages } = require('../../app/publish-account');
const { BookStack } = require('../../app/bookstack');
const { Zendesk, normalizeSubdomain } = require('../../app/zendesk');
const { Notion } = require('../../app/notion');
const { GitLabPages } = require('../../app/gitlab-pages');
const { SharePoint, sitePath } = require('../../app/sharepoint');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

function safeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(text) { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, c.update(text), c.final()]); },
    decryptString(bytes) { const c = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([c.update(bytes.subarray(16)), c.final()]).toString(); },
  };
}

/** A fake service: routes are [method, pattern, (match, init, url) => body | Response]; every call is recorded. */
function server(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, init });
    for (const [m, pattern, handler] of routes) {
      const match = m === method && pattern.exec(url);
      if (!match) continue;
      const result = await handler(match, init, url);
      return result instanceof Response ? result : new Response(JSON.stringify(result ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: `no route for ${method} ${url}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}
const missing = () => new Response('{"message":"404 Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
const bodyOf = (init) => JSON.parse(init.body);

function fixture(t) {
  const root = makeTmpDir('publishers');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const ast = buildRenderAst(store, guide.guideId);
  const html = runExport('clipboard', ast, path.join(root, 'out')).html;
  return { root, store, guide, ast, page: pageFromHtml(html), directory: makeTmpDir('publishers-settings') };
}

test('the clipboard HTML becomes a page: screenshots taken out in order, the title heading dropped, then filled with addresses', (t) => {
  const { page } = fixture(t);
  assert.equal(page.images.length, 2);
  assert.deepEqual(page.images.map((i) => i.name), ['step-001.png', 'step-002.png']);
  assert.ok(page.images.every((i) => i.data.subarray(1, 4).toString() === 'PNG'));
  assert.doesNotMatch(page.html, /<h1|data:image/);
  const filled = fillImages(page.html, ['https://x.example/1.png', 'https://x.example/"2.png']);
  assert.match(filled, /src="https:\/\/x\.example\/1\.png"/);
  assert.match(filled, /src="https:\/\/x\.example\/&quot;2\.png"/);
  assert.doesNotMatch(filled, /stepforge-image/);
});

test('the Notion export is headings, callouts, code, a table and image blocks pointing at its screenshots', (t) => {
  const { ast } = fixture(t);
  const { blocks, images } = runExport('notion', ast, '/unused');
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes('heading_2') && types.includes('heading_3') && types.includes('callout') && types.includes('code') && types.includes('table'));
  assert.equal(blocks.find((b) => b.type === 'heading_2').heading_2.rich_text[0].text.content, '1. Open AcmeSync settings');
  assert.equal(blocks.find((b) => b.type === 'code').code.language, 'plain text', 'cron is not a Notion language');
  const table = blocks.find((b) => b.type === 'table').table;
  assert.equal(table.table_width, 2);
  assert.equal(table.children.length, 3);
  const pictures = blocks.filter((b) => b.type === 'image');
  assert.deepEqual(pictures.map((b) => b.image.stepforgeImage), [0, 1]);
  assert.equal(images.length, 2);
  assert.equal(Buffer.from(images[0], 'base64').subarray(1, 4).toString(), 'PNG');
});

test('BookStack: connects with a token, makes the page, uploads to its gallery, and updates the same page next time', async (t) => {
  const { page, directory } = fixture(t);
  let uploads = 0;
  let saved = null;
  const site = server([
    ['GET', /\/api\/books\?count=1$/, () => ({ data: [] })],
    ['GET', /\/api\/books\?/, () => ({ data: [{ id: 1, name: 'Handbook' }] })],
    ['GET', /\/api\/chapters\?/, () => ({ data: [{ id: 4, book_id: 1, name: 'Backups' }] })],
    ['POST', /\/api\/pages$/, (m, init) => { assert.equal(bodyOf(init).chapter_id, 4); return { id: 7 }; }],
    ['GET', /\/api\/pages\/7$/, () => ({ id: 7 })],
    ['POST', /\/api\/image-gallery$/, (m, init) => {
      assert.match(init.headers['Content-Type'], /^multipart\/form-data/);
      assert.match(init.body.toString('latin1'), /name="uploaded_to"\r\n\r\n7\r\n/);
      return { url: `https://docs.example.com/uploads/${++uploads}.png` };
    }],
    ['PUT', /\/api\/pages\/7$/, (m, init) => { saved = bodyOf(init); return { id: 7 }; }],
  ]);
  const bookstack = new BookStack({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  const status = await bookstack.connect({ address: 'docs.example.com', tokenId: 'id', tokenSecret: 'secret' });
  assert.deepEqual([status.connected, status.account], [true, 'docs.example.com']);
  assert.equal(site.calls[0].init.headers.Authorization, 'Token id:secret');
  assert.deepEqual(await bookstack.targets(), [{ id: 'book:1', name: 'Handbook' }, { id: 'chapter:4', name: 'Handbook › Backups' }]);

  const first = await bookstack.publish({ guideId: 'g1', title: 'Backups', target: 'chapter:4', page });
  assert.deepEqual([first.url, first.updated], ['https://docs.example.com/link/7', false]);
  assert.match(saved.html, /src="https:\/\/docs\.example\.com\/uploads\/1\.png"/);
  const second = await bookstack.publish({ guideId: 'g1', title: 'Backups', target: 'chapter:4', page });
  assert.equal(second.updated, true);
  assert.equal(site.calls.filter((c) => c.method === 'POST' && /\/api\/pages$/.test(c.url)).length, 1, 'one page made');
  await assert.rejects(bookstack.publish({ guideId: 'g1', title: 'Backups', target: 'nowhere', page }), /book or chapter/);
  // Reopening keeps the sign-in, and disconnecting forgets it.
  assert.equal(new BookStack({ directory, safeStorage: bookstack.safeStorage, fetchImpl: site.fetch }).status().connected, true);
  assert.equal((await bookstack.disconnect()).connected, false);
});

test('Zendesk: an anonymous sign-in is refused; a new article is a draft with inline attachments', async (t) => {
  const { page, directory } = fixture(t);
  assert.equal(normalizeSubdomain('https://Acme.zendesk.com/hc/en-us'), 'https://acme.zendesk.com');
  assert.throws(() => normalizeSubdomain('not a name'), /subdomain/);
  let me = { user: { id: null } };
  let translation = null;
  const article = { id: 11, html_url: 'https://acme.zendesk.com/hc/en-us/articles/11', source_locale: 'en-us', section_id: 5, draft: true };
  const site = server([
    ['GET', /users\/me\.json$/, () => me],
    ['GET', /sections\/5\.json$/, () => ({ section: { id: 5, locale: 'en-us' } })],
    ['GET', /permission_groups\.json$/, () => ({ permission_groups: [{ id: 9 }] })],
    ['POST', /sections\/5\/articles\.json$/, (m, init) => {
      const { article: sent, notify_subscribers: notify } = bodyOf(init);
      assert.deepEqual([sent.draft, sent.permission_group_id, sent.locale, notify], [true, 9, 'en-us', false]);
      return { article };
    }],
    ['GET', /articles\/11\.json$/, () => ({ article })],
    ['POST', /articles\/11\/attachments\.json$/, () => ({ article_attachment: { content_url: 'https://acme.zendesk.com/hc/article_attachments/1/step.png' } })],
    ['PUT', /articles\/11\/translations\/en-us\.json$/, (m, init) => { translation = bodyOf(init).translation; return { translation: { draft: true } }; }],
  ]);
  const zendesk = new Zendesk({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  await assert.rejects(zendesk.connect({ address: 'acme', email: 'casey@example.com', token: 'tok' }), /didn’t accept/);
  assert.equal(zendesk.status().connected, false);
  me = { user: { id: 1, email: 'casey@example.com' } };
  await zendesk.connect({ address: 'acme', email: 'casey@example.com', token: 'tok' });
  assert.equal(site.calls.at(-1).init.headers.Authorization, `Basic ${Buffer.from('casey@example.com/token:tok').toString('base64')}`);
  const first = await zendesk.publish({ guideId: 'g1', title: 'Backups', target: '5', page });
  assert.deepEqual([first.url, first.draft, first.updated], [article.html_url, true, false]);
  assert.equal(translation.title, 'Backups');
  assert.match(translation.body, /article_attachments\/1\/step\.png/);
  assert.equal((await zendesk.publish({ guideId: 'g1', title: 'Backups', target: '5', page })).updated, true);
});

test('Notion: screenshots go through file uploads, a new subpage gets the blocks, and publishing again adds the new content before removing the old', async (t) => {
  const { ast, directory } = fixture(t);
  const page = runExport('notion', ast, '/unused');
  let appended = [];
  let children = [{ id: 'old-1' }];
  let uploads = 0;
  const site = server([
    ['GET', /\/users\/me$/, () => ({ bot: { workspace_name: 'Team space' } })],
    ['POST', /\/file_uploads$/, () => ({ id: `fu${++uploads}` })],
    ['POST', /\/file_uploads\/fu\d+\/send$/, () => ({ status: 'uploaded' })],
    ['POST', /\/pages$/, (m, init) => { assert.equal(bodyOf(init).parent.page_id, 'parent-1'); return { id: 'p1', url: 'https://www.notion.so/p1' }; }],
    ['GET', /\/pages\/p1$/, () => ({ id: 'p1', url: 'https://www.notion.so/p1' })],
    ['PATCH', /\/pages\/p1$/, () => ({ id: 'p1' })],
    ['GET', /\/blocks\/p1\/children/, () => { const results = children; children = []; return { results }; }],
    ['DELETE', /\/blocks\/old-1$/, () => ({})],
    ['PATCH', /\/blocks\/p1\/children$/, (m, init) => { appended.push(...bodyOf(init).children); return {}; }],
  ]);
  const notion = new Notion({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  const waits = [];
  notion.wait = async (ms) => { waits.push(ms); };
  assert.equal((await notion.connect({ token: 'ntn_secret' })).account, 'Team space');
  assert.equal(site.calls[0].init.headers['Notion-Version'], '2022-06-28');
  const first = await notion.publish({ guideId: 'g1', title: 'Backups', target: 'parent-1', page });
  assert.equal(first.url, 'https://www.notion.so/p1');
  const images = appended.filter((b) => b.type === 'image');
  assert.deepEqual(images.map((b) => b.image.file_upload.id), ['fu1', 'fu2']);
  assert.ok(images.every((b) => b.image.stepforgeImage === undefined));
  appended = [];
  const second = await notion.publish({ guideId: 'g1', title: 'Backups', target: 'parent-1', page });
  assert.equal(second.updated, true);
  const deleted = site.calls.findIndex((c) => c.method === 'DELETE' && /old-1/.test(c.url));
  const added = site.calls.findIndex((c, i) => i > site.calls.findIndex((x) => x.method === 'PATCH' && /pages\/p1$/.test(x.url)) && c.method === 'PATCH' && /children$/.test(c.url));
  assert.ok(deleted > added && added > 0, 'the old content is removed only after the new is in');
  assert.equal(appended.length, page.blocks.length);
  assert.ok(waits.length > 0 && waits.every((ms) => ms <= 340), 'requests are spaced to Notion’s rate');
});

test('Notion: a busy answer is retried after the time Notion asks for, and a long table goes up 100 rows at a time', async (t) => {
  const { directory } = fixture(t);
  let busy = 2;
  const lists = [];
  const site = server([
    ['GET', /\/users\/me$/, () => ({ bot: { workspace_name: 'Team space' } })],
    ['POST', /\/pages$/, () => (busy-- > 0
      ? new Response('{"message":"rate limited"}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } })
      : { id: 'p1', url: 'https://www.notion.so/p1' })],
    ['PATCH', /\/blocks\/(p1|table-1)\/children$/, (m, init) => {
      const { children } = bodyOf(init);
      lists.push([m[1], children.length, children[0].type]);
      return { results: children.map((b, i) => ({ id: b.type === 'table' ? 'table-1' : `b${i}` })) };
    }],
  ]);
  const notion = new Notion({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  const waits = [];
  notion.wait = async (ms) => { waits.push(ms); };
  await notion.connect({ token: 'ntn_secret' });
  const rows = Array.from({ length: 251 }, (_, i) => ({ object: 'block', type: 'table_row', table_row: { cells: [[{ type: 'text', text: { content: String(i) } }]] } }));
  const blocks = [{ object: 'block', type: 'table', table: { table_width: 1, has_column_header: true, has_row_header: false, children: rows } },
    ...Array.from({ length: 150 }, () => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }))];
  await notion.publish({ guideId: 'g1', title: 'Big table', target: 'parent-1', page: { blocks, images: [] } });
  assert.deepEqual(waits.filter((ms) => ms === 2000), [2000, 2000], 'waited as asked, twice');
  // The table and the first 99 paragraphs, then the table's other rows, then the rest.
  assert.deepEqual(lists, [['p1', 100, 'table'], ['table-1', 100, 'table_row'], ['table-1', 51, 'table_row'], ['p1', 51, 'paragraph']]);
  const first = JSON.parse(site.calls.find((c) => c.method === 'PATCH').init.body).children[0];
  assert.equal(first.table.children.length, 100);
});

/** A GitLab with one project whose branch is kept in memory, commit by commit. */
function gitlabServer({ existing = null } = {}) {
  const files = new Map(Object.entries(existing || {}));
  const project = { id: 3, default_branch: 'main', web_url: 'https://gitlab.com/casey/stepforge-guides' };
  const state = { created: Boolean(existing), settings: [], schedules: [], commits: [], files, pipeline: [] };
  const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
  const site = server([
    ['GET', /\/api\/v4\/user$/, () => ({ username: 'casey' })],
    ['GET', /projects\/casey%2Fstepforge-guides$/, () => (state.created ? project : missing())],
    ['GET', /projects\/3$/, () => project],
    ['POST', /\/api\/v4\/projects$/, (m, init) => { state.created = true; state.settings.push(bodyOf(init)); return project; }],
    ['PUT', /projects\/3$/, (m, init) => { state.settings.push(bodyOf(init)); return project; }],
    ['GET', /projects\/3\/repository\/tree\?/, () => (files.size ? [...files.keys()].map((p) => ({ path: p, type: 'blob' })) : missing())],
    ['GET', /projects\/3\/repository\/files\/stepforge\.json\/raw/, () => (files.has('stepforge.json') ? text(files.get('stepforge.json')) : missing())],
    ['POST', /repository\/commits$/, (m, init) => {
      const sent = bodyOf(init);
      for (const action of sent.actions) {
        if (action.action === 'create' && files.has(action.file_path)) return new Response('{"message":"exists"}', { status: 400 });
        if (action.action !== 'create' && !files.has(action.file_path)) return new Response('{"message":"missing"}', { status: 400 });
        if (action.action === 'delete') files.delete(action.file_path);
        else files.set(action.file_path, Buffer.from(action.content, 'base64').toString());
      }
      state.commits.push(sent);
      return { id: `c${state.commits.length}` };
    }],
    ['GET', /pipeline_schedules\?/, () => state.schedules],
    ['POST', /pipeline_schedules$/, (m, init) => { state.schedules.push(bodyOf(init)); return {}; }],
    ['GET', /projects\/3\/pipelines\?sha=/, () => [{ status: state.pipeline.shift() || 'success', web_url: 'https://gitlab.com/casey/stepforge-guides/-/pipelines/9' }]],
    ['GET', /projects\/3\/pages$/, () => ({ url: 'https://casey.gitlab.io/stepforge-guides' })],
    ['HEAD', /^https:\/\/casey\.gitlab\.io\/stepforge-guides\/g\/[a-f0-9]{24}\/\?stepforge=\d+$/, () => new Response(null, { status: 200 })],
  ]);
  return { site, state, files };
}
const DAY = 24 * 60 * 60 * 1000;
const guidePage = { html: '<!DOCTYPE html><html><head><title>Backups</title></head><body><h1>Backups</h1></body></html>' };

test('GitLab Pages shares like GitHub Pages: unguessable links, a site that lists nothing, members-only files, and an expiry', async (t) => {
  const { directory } = fixture(t);
  const { site, state, files } = gitlabServer();
  const gitlab = new GitLabPages({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch, language: () => 'fr' });
  gitlab.wait = async () => {};
  assert.equal((await gitlab.connect({ address: '', token: 'glpat-x' })).account, '@casey');

  const stages = [];
  const first = await gitlab.publish({ guideId: 'g1', title: 'Backups', page: guidePage, days: 7, onProgress: ({ stage }) => stages.push(stage) });
  const slug = first.slug;
  assert.match(slug, /^[a-f0-9]{24}$/, 'an unguessable address, not the title');
  assert.equal(first.url, `https://casey.gitlab.io/stepforge-guides/g/${slug}/`);
  assert.deepEqual([first.live, first.updated, stages.at(-1)], [true, false, 'live']);
  assert.ok(Math.abs(Date.parse(first.expiresAt) - (Date.now() + 7 * DAY)) < 60000);
  // The project's Pages are public; its files, history and pipelines are for members only.
  assert.deepEqual(JSON.parse(JSON.stringify(state.settings[0])), {
    name: 'StepForge guides', path: 'stepforge-guides', description: 'Guides published from StepForge.', visibility: 'public',
    pages_access_level: 'public', repository_access_level: 'private', builds_access_level: 'private', public_jobs: false,
    issues_access_level: 'disabled', wiki_access_level: 'disabled', snippets_access_level: 'disabled',
    merge_requests_access_level: 'disabled', forking_access_level: 'disabled' });
  const page = files.get(`guides/${slug}/index.html`);
  assert.match(page, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.equal(Number(files.get(`guides/${slug}/expires`)), Math.floor(Date.parse(first.expiresAt) / 1000));
  assert.doesNotMatch(files.get('index.html'), /Backups/, 'the front page never lists guides');
  assert.match(files.get('index.html'), /lang="fr"/);
  assert.deepEqual(state.schedules.map((s) => [s.cron, s.ref]), [['17 * * * *', 'main']], 'an hourly rebuild takes expired guides down');

  // Again: the same link, a new time, one schedule.
  const again = await gitlab.publish({ guideId: 'g1', title: 'Backups', page: guidePage, days: 1 });
  assert.deepEqual([again.slug, again.updated], [slug, true]);
  assert.ok(Date.parse(again.expiresAt) < Date.parse(first.expiresAt));
  assert.equal(state.schedules.length, 1);
  const other = await gitlab.publish({ guideId: 'g2', title: 'Backups', page: guidePage, days: 30 });
  assert.notEqual(other.slug, slug, 'a guide with the same title gets its own link');

  // Listed soonest-to-expire first; extended; removed.
  assert.deepEqual((await gitlab.shared()).map((g) => [g.guideId, g.url]), [['g1', first.url], ['g2', other.url]]);
  assert.equal((await gitlab.sharedFor('g2')).slug, other.slug);
  const extended = await gitlab.extend({ slug, days: 30 });
  assert.equal(extended.at(-1).guideId, 'g1');
  const left = await gitlab.unpublish({ slug: other.slug });
  assert.deepEqual(left.map((g) => g.guideId), ['g1']);
  assert.ok(![...files.keys()].some((p) => p.includes(other.slug)), 'its files are gone from the branch');
  await assert.rejects(gitlab.unpublish({ slug: '../etc' }), /Unknown shared guide/);

  // Expired while StepForge was closed: the sweep after launch takes it out.
  const manifest = JSON.parse(files.get('stepforge.json'));
  manifest.guides[slug].expiresAt = new Date(Date.now() - 1000).toISOString();
  files.set('stepforge.json', JSON.stringify(manifest));
  assert.equal(await gitlab.sweep(), 1);
  assert.deepEqual([...files.keys()].filter((p) => p.startsWith('guides/')), []);
  assert.equal(await gitlab.sweep(), 0, 'nothing more to do');

  // A failed build is reported with where to look.
  state.pipeline = ['failed'];
  await assert.rejects(gitlab.publish({ guideId: 'g3', title: 'Third', page: guidePage }), /couldn’t build the site.*pipelines\/9/);
  // One no runner picks up ends with the link and why it doesn't work yet.
  state.pipeline = Array(1000).fill('pending');
  const waited = await gitlab.waitUntilLive({ id: 3, web_url: 'https://gitlab.com/casey/stepforge-guides' }, 'c1', 'g/x/', { deadline: Date.now() + 50 });
  assert.deepEqual([waited.live, waited.waiting], [false, 'pending']);
});

test('GitLab Pages brings a project from an earlier StepForge up to date: settings, and its readable-address pages removed', async (t) => {
  const { directory } = fixture(t);
  const { site, state, files } = gitlabServer({ existing: { 'public/backups/index.html': '<html></html>', '.gitlab-ci.yml': 'pages: {}', 'README.md': 'mine' } });
  const gitlab = new GitLabPages({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  gitlab.wait = async () => {};
  await gitlab.connect({ address: 'https://gitlab.example.com', token: 'glpat-x' });
  assert.equal(site.calls[0].url, 'https://gitlab.example.com/api/v4/user');
  await gitlab.publish({ guideId: 'g1', title: 'Backups', page: guidePage });
  assert.equal(state.settings[0].repository_access_level, 'private', 'made members-only');
  assert.equal(files.has('public/backups/index.html'), false);
  assert.equal(files.get('README.md'), 'mine', 'files StepForge didn’t make are left alone');
  assert.match(files.get('.gitlab-ci.yml'), /stepforge-pages v2/);
  await gitlab.publish({ guideId: 'g1', title: 'Backups', page: guidePage });
  assert.equal(state.settings.length, 1, 'settings are only set once');
});

test('the GitLab Pages build publishes only guides that haven’t expired, from any shell', (t) => {
  const { CI } = require('../../app/gitlab-pages');
  const dir = makeTmpDir('gitlab-ci');
  t.after(() => rmrf(dir));
  const now = Math.floor(Date.now() / 1000);
  const guide = (slug, expires) => {
    fs.mkdirSync(path.join(dir, 'guides', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'guides', slug, 'index.html'), slug);
    if (expires !== null) fs.writeFileSync(path.join(dir, 'guides', slug, 'expires'), `${expires}\n`);
  };
  fs.writeFileSync(path.join(dir, 'index.html'), 'front');
  fs.mkdirSync(path.join(dir, 'public', 'old'), { recursive: true });
  guide('a'.repeat(24), now + 3600);
  guide('b'.repeat(24), now - 60);
  guide('c'.repeat(24), null);
  guide('d'.repeat(24), 'soon');
  const script = CI.split('\n');
  const first = script.find((line) => line.trim().startsWith('- rm -rf public'));
  const start = script.findIndex((line) => line.trim() === '- |');
  const end = script.findIndex((line) => line.trim() === 'artifacts:');
  const block = script.slice(start + 1, end).map((line) => line.slice(6)).join('\n');
  require('node:child_process').execFileSync('sh', ['-c', `${first.trim().slice(2)}\n${block}`], { cwd: dir });
  const built = (p) => fs.existsSync(path.join(dir, 'public', p));
  assert.deepEqual([built('index.html'), built(`g/${'a'.repeat(24)}/index.html`), built(`g/${'b'.repeat(24)}`),
    built(`g/${'c'.repeat(24)}`), built(`g/${'d'.repeat(24)}`), built('old')], [true, true, false, false, false, false]);
});

test('SharePoint: a site address becomes a Graph site path; pages go up with their images in Site Assets and are published', async (t) => {
  const { page, directory } = fixture(t);
  assert.equal(sitePath('https://contoso.sharepoint.com/sites/Team/SitePages/Home.aspx'), 'contoso.sharepoint.com:/sites/Team');
  assert.equal(sitePath('contoso.sharepoint.com'), 'contoso.sharepoint.com');
  assert.throws(() => sitePath('example.com/sites/Team'), /SharePoint site/);
  let created = null;
  const site = server([
    ['GET', /sites\/s1\/drives/, () => ({ value: [{ id: 'docs', webUrl: 'https://contoso.sharepoint.com/sites/Team/Shared Documents' },
      { id: 'assets', webUrl: 'https://contoso.sharepoint.com/sites/Team/SiteAssets' }] })],
    ['PUT', /drives\/assets\/root:\/StepForge\/[^/]+\/(step-\d+\.png):\/content$/, (m) => ({ webUrl: `https://contoso.sharepoint.com/sites/Team/SiteAssets/StepForge/x/${m[1]}` })],
    ['POST', /sites\/s1\/pages$/, (m, init) => { created = bodyOf(init); return { id: 'pg1', webUrl: 'SitePages/backups.aspx' }; }],
    ['POST', /pages\/pg1\/microsoft\.graph\.sitePage\/publish$/, () => new Response(null, { status: 204 })],
  ]);
  const sharepoint = new SharePoint({ clientId: '00000000-0000-0000-0000-000000000001', directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  sharepoint.credentials = { key: sharepoint.key, access_token: 'at', refresh_token: 'rt', expiresAt: Date.now() + 3600000,
    siteId: 's1', site: 'https://contoso.sharepoint.com/sites/Team', account: 'Team' };
  const result = await sharepoint.publish({ guideId: 'g1', title: 'Backups', page });
  assert.equal(result.url, 'https://contoso.sharepoint.com/sites/Team/SitePages/backups.aspx');
  const part = created.canvasLayout.horizontalSections[0].columns[0].webparts[0];
  assert.equal(part['@odata.type'], '#microsoft.graph.textWebPart');
  assert.match(part.innerHtml, /SiteAssets\/StepForge\/x\/step-001\.png/);
  assert.match(created.name, /^backups-[0-9a-f]{6}\.aspx$/);
  assert.ok(site.calls.every((c) => c.init.headers?.Authorization === 'Bearer at'));
});
