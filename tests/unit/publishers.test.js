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
const { MarkdownFolder } = require('../../app/markdown-folder');
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

test('Notion: screenshots go through file uploads, a new subpage gets the blocks, and publishing again clears and refills it', async (t) => {
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
  assert.ok(site.calls.some((c) => c.method === 'DELETE' && /old-1/.test(c.url)), 'the old content is removed');
  assert.equal(appended.length, page.blocks.length);
});

test('GitLab Pages: the first publish makes the project and its CI file; another guide with the same name asks first', async (t) => {
  const { directory } = fixture(t);
  const files = new Set();
  const commits = [];
  const project = { id: 3, default_branch: 'main', web_url: 'https://gitlab.com/casey/stepforge-guides' };
  let created = false;
  const site = server([
    ['GET', /\/api\/v4\/user$/, () => ({ username: 'casey' })],
    ['GET', /projects\/casey%2Fstepforge-guides$/, () => (created ? project : missing())],
    ['GET', /projects\/3$/, () => project],
    ['POST', /projects$/, (m, init) => { assert.deepEqual([bodyOf(init).visibility, bodyOf(init).path], ['public', 'stepforge-guides']); created = true; return project; }],
    ['HEAD', /repository\/files\/([^?]+)/, (m) => (files.has(decodeURIComponent(m[1])) ? new Response(null, { status: 200 }) : new Response(null, { status: 404 }))],
    ['POST', /repository\/commits$/, (m, init) => { const sent = bodyOf(init); commits.push(sent); for (const a of sent.actions) files.add(a.file_path); return { id: 'c1' }; }],
    ['GET', /projects\/3\/pages$/, () => ({ url: 'https://casey.gitlab.io/stepforge-guides' })],
  ]);
  const gitlab = new GitLabPages({ directory, safeStorage: safeStorage(), fetchImpl: site.fetch });
  assert.equal((await gitlab.connect({ address: '', token: 'glpat-x' })).account, '@casey');
  assert.equal(site.calls[0].url, 'https://gitlab.com/api/v4/user');
  const page = { html: '<!DOCTYPE html><title>Backups</title>' };
  const first = await gitlab.publish({ guideId: 'g1', title: 'Backups', page });
  assert.equal(first.url, 'https://casey.gitlab.io/stepforge-guides/backups/');
  assert.deepEqual(commits[0].actions.map((a) => [a.action, a.file_path]), [['create', 'public/backups/index.html'], ['create', '.gitlab-ci.yml']]);
  assert.equal(Buffer.from(commits[0].actions[0].content, 'base64').toString(), page.html);
  const again = await gitlab.publish({ guideId: 'g1', title: 'Backups', page });
  assert.deepEqual(commits[1].actions.map((a) => a.action), ['update']);
  assert.equal(again.updated, true);
  assert.deepEqual(await gitlab.publish({ guideId: 'g2', title: 'Backups', page }), { conflict: { path: 'public/backups/index.html', title: 'backups' } });
  assert.equal((await gitlab.publish({ guideId: 'g2', title: 'Backups', page, replace: true })).url, first.url);
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

test('Markdown folder: the Markdown and its screenshots go into the chosen folder, and a file not from this guide is replaced only when asked', async (t) => {
  const { root, ast, directory } = fixture(t);
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  const folder = new MarkdownFolder({ directory, chooseFolder: async () => vault });
  assert.equal((await folder.connect({ flavor: 'obsidian' })).account, vault);
  assert.deepEqual(folder.markdownOptions(), { target: 'github', toc: false, includeImages: true, imageMaxWidth: 0 });
  const exported = runExport('markdown', ast, path.join(root, 'md'), folder.markdownOptions());
  const name = path.basename(exported.file);
  const first = await folder.publish({ guideId: 'g1', title: 'Backups', page: { file: exported.file } });
  assert.equal(first.path, path.join(vault, name));
  assert.equal(first.updated, false);
  const images = fs.readdirSync(path.join(vault, `steps-${path.basename(name, '.md')}`));
  assert.equal(images.filter((f) => f.endsWith('.png')).length, 2);
  assert.match(fs.readFileSync(first.path, 'utf8'), /> \[!/, 'callouts are written the way Obsidian shows them');
  assert.equal((await folder.publish({ guideId: 'g1', title: 'Backups', page: { file: exported.file } })).updated, true);
  assert.deepEqual(await folder.publish({ guideId: 'g2', title: 'Backups', page: { file: exported.file } }), { conflict: { path: first.path, title: name } });
  assert.equal((await folder.publish({ guideId: 'g2', title: 'Backups', page: { file: exported.file }, replace: true })).path, first.path);
  assert.equal(folder.disconnect().connected, false);
});

test('Markdown folder: every Markdown export target and option can be chosen, Docusaurus included', async (t) => {
  const { root, ast, directory } = fixture(t);
  const docs = path.join(root, 'docs');
  fs.mkdirSync(docs);
  const folder = new MarkdownFolder({ directory, chooseFolder: async () => docs });
  await folder.connect({ flavor: 'docusaurus', toc: 'yes', images: 'yes' });
  assert.deepEqual(folder.markdownOptions(), { target: 'docusaurus', toc: true, includeImages: true, imageMaxWidth: 0 });
  assert.equal(folder.status().site, 'Docusaurus');
  const exported = runExport('markdown', ast, path.join(root, 'md'), folder.markdownOptions());
  const published = await folder.publish({ guideId: 'g1', title: 'Backups', page: { file: exported.file } });
  const markdown = fs.readFileSync(published.path, 'utf8');
  assert.match(markdown, /^---\ntitle:/, 'Docusaurus front matter');
  assert.match(markdown, /:::/, 'Docusaurus admonitions');
  assert.match(markdown, /\]\(\.\/steps-/, 'images beside the page');
  await folder.connect({ flavor: 'azure', imageMaxWidth: '600', images: 'no' });
  assert.deepEqual(folder.markdownOptions(), { target: 'azure', toc: false, includeImages: false, imageMaxWidth: 600 });
  await assert.rejects(folder.connect({ flavor: 'azure', imageMaxWidth: 'wide' }), /screenshot width/);
  await assert.rejects(folder.connect({ flavor: 'confluence' }), /what the folder is for/);
});
