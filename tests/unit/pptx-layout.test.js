'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { exportPptx } = require('../../exporters/pptx');
const metrics = require('../../exporters/text-metrics');
const { unzipSync } = require('../../core/zip');
const { encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { makeTmpDir, rmrf } = require('./helpers');

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

const LONG = 'Open the Admin Portal and sign in with your administrator account. In the left sidebar, choose Users, then search for the person whose password you are resetting. '
  + 'Check the account name and email carefully before you continue, because the reset signs the user out of every device and sends them a one-time link that expires after 24 hours. '
  + 'If the account is locked, unlock it first from the Security tab.';

function shot(w, h) {
  const img = raster.createImage(w, h, [245, 247, 250, 255]);
  raster.fillRect(img, 0, 0, w, 40, [0, 104, 255, 255]);
  return { png: encodePng(img), size: { width: w, height: h } };
}

/** A guide that used to break the layout: long titles and text, callouts everywhere, code, tables, a tall screenshot. */
function crowdedGuide(t) {
  const root = makeTmpDir('pptx-layout');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Reset a password in Admin Portal' });
  const add = (spec, img) => store.addStep(guide.guideId, spec, img?.png, img?.size);
  add({ title: 'Open the Users page', descriptionHtml: '<p>Select <b>Users</b> in the sidebar.</p>' }, shot(1280, 760));
  add({
    title: 'Find the account you are resetting and check that the email address matches the ticket before continuing',
    descriptionHtml: `<p>${LONG}</p><p>Second paragraph: note the ticket number in the reset reason box.</p>`,
  }, shot(1280, 760));
  add({
    title: 'Reset the password',
    descriptionHtml: '<p>Choose <b>Reset password</b> and confirm.</p>',
    textBlocks: [
      { position: 'before-title', level: 'warn', title: 'Admins only', descriptionHtml: '<p>You need the User Administrator role for this step.</p>' },
      { position: 'after-title', level: 'info', title: '', descriptionHtml: '<p>The user gets an email with a one-time link.</p>' },
      { position: 'after-description', level: 'success', title: 'Shortcut', descriptionHtml: '<p>Press Ctrl+R on the account page to open the reset dialog directly.</p>' },
      { position: 'after-image', level: 'error', title: 'Do not reset service accounts', descriptionHtml: '<p>Service accounts break integrations when their password changes.</p>' },
    ],
  }, shot(1280, 760));
  add({
    title: 'Run the audit script',
    descriptionHtml: '<p>Confirm the reset was logged.</p>',
    codeBlocks: [{ id: 'c1', language: 'bash', code: 'adminctl audit --user jdoe --since 1h\nadminctl sessions --user jdoe --revoke-all' }],
    tableBlocks: [{ id: 't1', rows: [['Field', 'Expected'], ['Action', 'password.reset'], ['Result', 'success']] }],
  }, shot(1280, 760));
  add({ title: 'Approve the prompt', descriptionHtml: '<p>Choose <b>Yes</b>.</p>' }, shot(520, 760));
  add({
    title: 'If the reset email never arrives',
    descriptionHtml: `<p>${LONG}</p><p>${LONG}</p><p>${LONG}</p><ul><li>Check the spam folder.</li><li>Resend the link.</li></ul>`,
    textBlocks: [
      { position: 'after-description', level: 'warn', title: 'Mail delays', descriptionHtml: `<p>${LONG}</p>` },
      { position: 'after-image', level: 'info', title: 'Escalate', descriptionHtml: '<p>After 30 minutes, open a ticket with the messaging team.</p>' },
    ],
  }, shot(1280, 760));
  add({ kind: 'empty', title: 'Tell the user', descriptionHtml: '<p>Reply on the ticket.</p>' });
  return { root, ast: buildRenderAst(store, guide.guideId) };
}

function deck(ast, dir, options) {
  const { file, slideCount } = exportPptx(ast, dir, options);
  const z = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data.toString('utf8')]));
  const slides = Array.from({ length: slideCount }, (_, i) => z.get(`ppt/slides/slide${i + 1}.xml`));
  return { z, slides };
}

/** The positioned blocks on a slide: { name, x, y, w, h }. Callout bars and text sit inside their callout. */
function blocks(xml) {
  const out = [];
  const re = /<p:cNvPr id="\d+" name="([^"]+)"[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g;
  for (const m of xml.matchAll(re)) {
    const [, name, x, y, w, h] = m;
    out.push({ name, x: +x, y: +y, w: +w, h: +h });
  }
  return out.filter((b) => !['Callout bar', 'Callout text', 'Accent'].includes(b.name));
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** All the text on a slide: a paragraph's runs joined as written, paragraphs with spaces. */
const slideText = (xml) => [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).join(' ').replace(/&apos;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

/** The step slides whose title starts with `title` (the first, then any "(continued)"). */
const stepSlides = (slides, title) => slides.filter((xml) => xml.includes('name="Step number"') && new RegExp(`<p:ph type="title"/>[\\s\\S]*?<a:t>${title}`).test(xml));

for (const position of ['auto', 'right', 'left', 'below', 'full']) {
  test(`PPTX layout (${position}): nothing on a step slide overlaps or leaves the slide`, (t) => {
    const { root, ast } = crowdedGuide(t);
    const { slides } = deck(ast, path.join(root, position), { screenshotPosition: position });
    for (const [i, xml] of slides.entries()) {
      const list = blocks(xml);
      for (const b of list) {
        assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= SLIDE_W && b.y + b.h <= SLIDE_H - 300000, `slide ${i + 1}: ${b.name} inside the slide, above the bottom margin`);
        assert.ok(b.w > 0 && b.h > 0, `slide ${i + 1}: ${b.name} has a size`);
      }
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          assert.ok(!overlaps(list[a], list[b]), `slide ${i + 1}: ${list[a].name} and ${list[b].name} overlap`);
        }
      }
    }
  });
}

test('PPTX layout: no text is cut; long steps carry on to "(continued)" slides', (t) => {
  const { root, ast } = crowdedGuide(t);
  const { slides } = deck(ast, path.join(root, 'out'));
  const all = slides.map(slideText).join(' ');
  for (const step of ast.steps) {
    // List items are real bullets on the slide, not "•" in the text.
    for (const para of step.descriptionText.split('\n')) assert.ok(all.includes(para.replace(/^• /, '').trim()), `"${para.slice(0, 40)}…" is on a slide`);
  }
  assert.ok(all.includes('Do not reset service accounts') && all.includes('Service accounts break integrations'));
  const long = stepSlides(slides, 'If the reset email never arrives');
  assert.ok(long.length >= 2, 'the long step spans slides');
  assert.ok(slideText(long[1]).includes('If the reset email never arrives (continued)'));
  assert.ok(!long[1].includes('name="Screenshot"'), 'the screenshot is on the first slide only');
});

test('PPTX layout: code blocks and tables are on the slide', (t) => {
  const { root, ast } = crowdedGuide(t);
  const { slides } = deck(ast, path.join(root, 'out'));
  const [slide] = stepSlides(slides, 'Run the audit script');
  assert.match(slide, /name="Code"/);
  assert.ok(slideText(slide).includes('adminctl sessions --user jdoe --revoke-all'));
  assert.match(slide, /<a:tbl>/);
  assert.ok(slideText(slide).includes('password.reset'));
});

test('PPTX layout: step titles are title placeholders beside a number badge', (t) => {
  const { root, ast } = crowdedGuide(t);
  const { slides, z } = deck(ast, path.join(root, 'out'));
  const [slide] = stepSlides(slides, 'Open the Users page');
  assert.match(slide, /name="Title"\/><p:cNvSpPr><a:spLocks noGrp="1"\/><\/p:cNvSpPr><p:nvPr><p:ph type="title"\/>[\s\S]*<a:t>Open the Users page<\/a:t>/);
  assert.match(slide, /name="Step number"[\s\S]*?<a:t>1<\/a:t>/);
  assert.match(z.get('ppt/slideLayouts/slideLayout1.xml'), /<p:ph type="title"\/>/);
});

test('PPTX layout: the screenshot goes where the position option says', (t) => {
  const { root, ast } = crowdedGuide(t);
  const find = (slides, title) => blocks(stepSlides(slides, title)[0]);
  const at = (list, name) => list.find((b) => b.name === name);
  const right = find(deck(ast, path.join(root, 'r'), { screenshotPosition: 'right' }).slides, 'Reset the password');
  assert.ok(at(right, 'Screenshot').x > at(right, 'Text').x);
  const left = find(deck(ast, path.join(root, 'l'), { screenshotPosition: 'left' }).slides, 'Reset the password');
  assert.ok(at(left, 'Screenshot').x < at(left, 'Text').x);
  const below = find(deck(ast, path.join(root, 'b'), { screenshotPosition: 'below' }).slides, 'Reset the password');
  assert.ok(at(below, 'Screenshot').y > at(below, 'Text').y);
  const full = find(deck(ast, path.join(root, 'f'), { screenshotPosition: 'full' }).slides, 'Reset the password');
  assert.ok(!full.some((b) => b.name === 'Text' || b.name === 'Callout'), 'only the title and screenshot');
  // Automatic: a short description goes above a wide screenshot, a long one beside it.
  const auto = deck(ast, path.join(root, 'a')).slides;
  const short = find(auto, 'Open the Users page');
  assert.ok(at(short, 'Screenshot').y > at(short, 'Text').y + at(short, 'Text').h);
  const tall = find(auto, 'Find the account you are resetting');
  assert.ok(at(tall, 'Screenshot').x > at(tall, 'Text').x + at(tall, 'Text').w);
});

test('PPTX layout: speaker notes hold each step’s full text, and can be left out', (t) => {
  const { root, ast } = crowdedGuide(t);
  const { z, slides } = deck(ast, path.join(root, 'notes'));
  const n = slides.indexOf(stepSlides(slides, 'If the reset email never arrives')[0]) + 1;
  const rels = z.get(`ppt/slides/_rels/slide${n}.xml.rels`);
  const target = rels.match(/Type="[^"]+\/notesSlide" Target="\.\.\/notesSlides\/([^"]+)"/)[1];
  const notes = slideText(z.get(`ppt/notesSlides/${target}`));
  assert.ok(notes.includes(LONG) && notes.includes('Mail delays'));
  assert.match(z.get('ppt/presentation.xml'), /<p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst>/);
  assert.match(z.get('[Content_Types].xml'), /notesSlide\+xml/);
  for (const [name, xml] of z) {
    if (!name.endsWith('.rels')) continue;
    const base = path.posix.dirname(path.posix.dirname(name));
    // Web links point outside the package.
    for (const m of xml.matchAll(/Target="([^"]+)"(?! TargetMode="External")/g)) assert.ok(z.has(path.posix.normalize(path.posix.join(base, m[1]))), `${name} → ${m[1]}`);
  }

  const none = deck(ast, path.join(root, 'none'), { speakerNotes: false }).z;
  assert.ok(![...none.keys()].some((k) => k.startsWith('ppt/notes')));
  assert.ok(!none.get('ppt/presentation.xml').includes('notesMaster'));
  // A whole-slide screenshot keeps its text in the notes even then.
  const full = deck(ast, path.join(root, 'full'), { speakerNotes: false, screenshotPosition: 'full' }).z;
  assert.ok([...full.keys()].some((k) => k.startsWith('ppt/notesSlides/')));
});

test('text metrics: wrapping, long words, CJK and one-line fitting', () => {
  const m = metrics.fontMetrics({ size: 16, font: 'Calibri' });
  const narrow = 914400 * 2;
  const lines = metrics.wrapParagraph(LONG, narrow, m);
  assert.ok(lines.length > 5);
  assert.equal(lines.join(' '), LONG, 'wrapping keeps every word');
  assert.ok(lines.every((line) => m.width(line) <= narrow / metrics.EMU_PER_PT));
  const word = metrics.wrapParagraph('x'.repeat(200), narrow, m);
  assert.ok(word.length > 1 && word.join('') === 'x'.repeat(200), 'a long word breaks between letters');
  const cjk = metrics.wrapParagraph('重置密码前请确认账户名称和电子邮件地址与工单一致'.repeat(3), narrow, m);
  assert.ok(cjk.length > 1, 'text without spaces wraps');
  assert.equal(metrics.wrapText('a\n\nb', narrow, m).length, 3);
  assert.ok(metrics.textHeight('one\ntwo', narrow, m) > metrics.textHeight('one', narrow, m));
  const wide = metrics.fontMetrics({ size: 16, font: 'Montserrat', bold: true });
  assert.ok(wide.width('Reset the password') > m.width('Reset the password'));
  const cut = metrics.fitOneLine(LONG, narrow, m);
  assert.ok(cut.endsWith('…') && m.width(cut) <= narrow / metrics.EMU_PER_PT);
  assert.equal(metrics.fitOneLine('Short', narrow, m), 'Short');
});
