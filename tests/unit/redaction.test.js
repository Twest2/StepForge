'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const red = require('../../core/redaction');
const { RedactionService, bitmapToPpm } = require('../../app/redaction');
const { TextIntelService } = require('../../app/text-intel');
const { GuideStore } = require('../../core/store');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');
const { decodePng } = require('../../core/png');

// Built from pieces so secret scanners don't mistake this made-up key for a real one.
const FAKE_STRIPE_KEY = ['sk', 'live', '51Hx9aZ2kQ7vB3nR8tYc4mWp'].join('_');
const FAKE_GITHUB_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const kinds = (text, options) => red.findInText(text, options).map((f) => [f.kind, f.text]);

test('finds the common kinds of private details', () => {
  assert.deepEqual(kinds('Signed in as casey.jones@contoso.com'), [['email', 'casey.jones@contoso.com']]);
  assert.deepEqual(kinds('Call (555) 867-5309 or +1 555.867.5309'), [['phone', '(555) 867-5309'], ['phone', '+1 555.867.5309']]);
  assert.deepEqual(kinds('Card 4111 1111 1111 1111'), [['card', '4111 1111 1111 1111']]);
  assert.deepEqual(kinds('SSN 123-45-6789, read as 12345-6789'), [['ssn', '123-45-6789'], ['ssn', '12345-6789']]);
  assert.deepEqual(kinds('Server 10.20.30.40'), [['ip', '10.20.30.40']]);
  assert.deepEqual(kinds('Use the server at 10.20.30.40.'), [['ip', '10.20.30.40']], 'at the end of a sentence');
  assert.deepEqual(kinds('Password: hunter2 then Login'), [['secret', 'hunter2']]);
  assert.deepEqual(kinds(`API key = ${FAKE_STRIPE_KEY}`), [['secret', FAKE_STRIPE_KEY]]);
  assert.deepEqual(kinds('AWS AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNNEXAMPLE'), [['secret', 'AKIAIOSFODNN7EXAMPLE'], ['secret', 'AKIAIOSFODNNEXAMPLE']]);
  assert.deepEqual(kinds(`token ${FAKE_GITHUB_TOKEN}`), [['secret', FAKE_GITHUB_TOKEN]]);
  assert.deepEqual(kinds('https://x.com/reset?token=8f3a9c2e71bd4f05&x=1'), [['url', 'token=8f3a9c2e71bd4f05']]);
  assert.deepEqual(kinds('https://admin:s3cret@db.internal/'), [['url', 'https://admin:s3cret@']]);
  assert.deepEqual(kinds('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), [['secret', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']]);
  assert.deepEqual(kinds('session 9f8e7d6c5b4a39281706f5e4d3c2b1a0ff'), [['secret', '9f8e7d6c5b4a39281706f5e4d3c2b1a0ff']]);
});

test('leaves ordinary numbers, dates, versions and words alone', () => {
  for (const text of ['Version 2.14.3', 'Updated 2026-09-30', 'Order #48213 shipped on 09/30/2026 for $1,299.00',
    'Card ending 1111', '4111 1111 1111 1112', 'Click Save changes', 'Page 12 of 340', 'Build 20260930.1',
    'Supercalifragilisticexpialidocious', 'C:\\Users\\casey\\Documents\\Reports2026Quarterly']) {
    assert.deepEqual(kinds(text), [], text);
  }
});

test('extra words are hidden wherever they appear, without case', () => {
  assert.deepEqual(kinds('Owner: Casey Jones (casey jones)', { terms: ['Casey Jones'] }), [['custom', 'Casey Jones'], ['custom', 'casey jones']]);
  assert.deepEqual(kinds('Project FALCON-7', { terms: ['falcon-7', 'x'] }), [['custom', 'FALCON-7']]);
});

test('findings in recognized lines get the box around their words, or part of a word', () => {
  const word = (text, x0, x1) => ({ text, bbox: { x0, y0: 10, x1, y1: 30 } });
  const [email, secret] = red.findInLines([
    { words: [word('Signed', 0, 60), word('in', 70, 90), word('casey@contoso.com', 100, 300)] },
    { words: [word('Password:hunter2', 0, 160)] },
  ]);
  assert.deepEqual([email.kind, email.box], ['email', { x0: 100, y0: 10, x1: 300, y1: 30 }]);
  assert.equal(secret.kind, 'secret');
  assert.ok(secret.box.x0 >= 90 && secret.box.x1 === 160, 'only the password part of the word is covered');
});

test('blurs are padded, strong, skip what is already hidden, and remember "not private"', () => {
  const size = { width: 1000, height: 500 };
  const finding = { kind: 'email', text: 'casey@contoso.com', box: { x0: 100, y0: 100, x1: 300, y1: 120 } };
  const blur = red.blurFor(finding, size);
  assert.ok(blur.x < 0.1 && blur.x + blur.w > 0.3 && blur.y < 0.2 && blur.y + blur.h > 0.24, 'covers the text with room to spare');
  assert.ok(blur.radius >= 10, 'strong enough to flatten the text');
  assert.equal(blur.redact.kind, 'email');
  assert.equal(red.newBlurs({ annotations: [] }, [finding], size).length, 1);
  assert.equal(red.newBlurs({ annotations: [{ type: 'blur', x: 0, y: 0, w: 1, h: 1 }] }, [finding], size).length, 0, 'already under a blur');
  assert.equal(red.newBlurs({ annotations: [], redaction: { dismissed: [blur.redact.key] } }, [finding], size).length, 0, 'the user said it is not private');
  assert.doesNotMatch(blur.redact.key, /casey|contoso/, 'the key does not store the text');
});

test('review text is masked, and hiding step text keeps its formatting', () => {
  assert.equal(red.maskText('email', 'casey@contoso.com'), 'c•••@contoso.com');
  assert.equal(red.maskText('card', '4111 1111 1111 1111'), '•••11');
  assert.equal(red.maskText('secret', 'sk_live_abc'), 'sk_•••');
  const step = { title: 'Email casey@contoso.com', descriptionHtml: '<p>Use <b>10.0.0.5</b> and pass: hunter2</p>' };
  assert.deepEqual(red.findInStepText(step).map((f) => [f.field, f.kind]), [['title', 'email'], ['description', 'ip'], ['description', 'secret']]);
  assert.equal(red.findInStepText({ title: '', descriptionHtml: '<p>Use the server at 10.20.30.40.</p>' }).length, 1);
  assert.deepEqual(red.hideInStepText(step), { title: 'Email [hidden]', descriptionHtml: '<p>Use <b>[hidden]</b> and pass: [hidden]</p>' });
});

function guideWithScreenshot(t) {
  const root = makeTmpDir('redaction');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Admin portal' });
  const step = store.addStep(guide.guideId, { title: 'Open settings' }, TINY_PNG, { width: 1000, height: 460 });
  return { store, guideId: guide.guideId, stepId: step.stepId };
}

function service(store, lines, terms = []) {
  const calls = { reads: 0 };
  const settings = { get: (key) => (key === 'redaction' ? { terms } : undefined) };
  const redactor = new RedactionService({ store, settings,
    readLines: async () => { calls.reads += 1; return lines; },
    loadImage: async () => ({ width: 1000, height: 460, encode: (scale) => { calls.scale = scale; return Buffer.from('png'); } }) });
  return { redactor, calls };
}

test('checking a guide adds blurs once, reads screenshots at twice the size, and only checks again when something changed', async (t) => {
  const { store, guideId, stepId } = guideWithScreenshot(t);
  // Word boxes are in the enlarged (2×) image.
  const lines = [{ words: [{ text: 'casey@contoso.com', bbox: { x0: 200, y0: 40, x1: 600, y1: 70 } }] }];
  const { redactor, calls } = service(store, lines);
  const progress = [];
  const result = await redactor.checkGuide(guideId, { onProgress: (p) => progress.push(p) });
  assert.equal(calls.scale, 2);
  assert.deepEqual([result.checked, result.added, result.blurs.length], [1, 1, 1]);
  assert.deepEqual(progress, [{ done: 0, total: 1 }, { done: 1, total: 1 }]);
  const [blur] = store.getStep(guideId, stepId).annotations;
  assert.equal(blur.type, 'blur');
  assert.equal(blur.redact.kind, 'email');
  assert.ok(Math.abs(blur.x - 0.09) < 0.02 && blur.x + blur.w > 0.3, 'boxes are scaled back to the screenshot');

  assert.equal((await redactor.checkGuide(guideId)).checked, 0, 'nothing changed, nothing is read again');
  assert.equal(calls.reads, 1);

  const review = redactor.keepVisible({ guideId, stepId, annotationId: blur.id });
  assert.equal(review.annotations.length, 0);
  assert.equal((await redactor.checkGuide(guideId, { force: true })).added, 0, '"not private" is remembered');
});

test('new words to hide cause a fresh check, and step text can be reviewed and hidden', async (t) => {
  const { store, guideId, stepId } = guideWithScreenshot(t);
  const lines = [{ words: [{ text: 'Owner', bbox: { x0: 0, y0: 0, x1: 80, y1: 30 } }, { text: 'Falcon', bbox: { x0: 90, y0: 0, x1: 180, y1: 30 } }] }];
  const first = service(store, lines);
  assert.equal((await first.redactor.checkGuide(guideId)).added, 0);
  const second = service(store, lines, ['falcon']);
  assert.equal((await second.redactor.checkGuide(guideId)).added, 1);

  const step = store.getStep(guideId, stepId);
  step.title = 'Log in as casey@contoso.com';
  store.saveStep(guideId, step);
  const review = second.redactor.review(guideId);
  assert.deepEqual(review.text.map((item) => [item.field, item.preview]), [['title', 'c•••@contoso.com']]);
  second.redactor.hideText({ guideId, stepId });
  assert.equal(store.getStep(guideId, stepId).title, 'Log in as [hidden]');
  assert.equal(second.redactor.review(guideId).text.length, 0);
});

test('a guide’s screenshots are read several at a time, and the first error stops the rest', async (t) => {
  const root = makeTmpDir('redaction-parallel');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Many screens' });
  for (let i = 0; i < 7; i += 1) store.addStep(guide.guideId, { title: `Step ${i + 1}` }, TINY_PNG, { width: 1000, height: 460 });
  const lines = [{ words: [{ text: 'casey@contoso.com', bbox: { x0: 200, y0: 40, x1: 600, y1: 70 } }] }];
  let reading = 0;
  let most = 0;
  let reads = 0;
  let failOn = 0;
  // Each read waits until three are in flight (or no more are coming), so
  // the count doesn't depend on timer resolution.
  let hold = true;
  let release = () => {};
  const redactor = new RedactionService({ store, settings: { get: () => ({ terms: [] }) }, concurrency: 3,
    readLines: async () => {
      reads += 1;
      if (reads === failOn) throw new Error('unreadable');
      reading += 1;
      most = Math.max(most, reading);
      if (hold && reading < 3 && reads < 7) {
        await new Promise((resolve) => { const others = release; release = () => { others(); resolve(); }; });
      } else {
        const others = release;
        release = () => {};
        others();
      }
      reading -= 1;
      return lines;
    },
    loadImage: async () => ({ width: 1000, height: 460, encode: () => Buffer.from('ppm') }) });
  const progress = [];
  const result = await redactor.checkGuide(guide.guideId, { onProgress: (p) => progress.push(p.done) });
  assert.equal(most, 3);
  assert.deepEqual([result.checked, result.added], [7, 7]);
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5, 6, 7]);

  reads = 0;
  failOn = 2;
  hold = false;
  await assert.rejects(redactor.checkGuide(guide.guideId, { force: true }), /unreadable/);
  assert.ok(reads < 7, 'nothing more is read after an error');
});

test('a raw screenshot bitmap becomes a PPM text recognition can read', () => {
  // 2×2 BGRA with each row padded by 4 bytes.
  const bgra = Buffer.from([
    0, 0, 255, 255, 0, 255, 0, 255, 9, 9, 9, 9,
    255, 0, 0, 255, 10, 20, 30, 255, 9, 9, 9, 9,
  ]);
  const ppm = bitmapToPpm(bgra, 2, 2);
  const header = 'P6\n2 2\n255\n';
  assert.equal(ppm.subarray(0, header.length).toString('ascii'), header);
  assert.deepEqual([...ppm.subarray(header.length)], [255, 0, 0, 0, 255, 0, 0, 0, 255, 30, 20, 10]);
  assert.throws(() => bitmapToPpm(Buffer.alloc(10), 2, 2), /couldn’t be read/);
});

test('a transparent bitmap is laid over white, as a viewer shows it', () => {
  // Premultiplied BGRA: fully transparent, half-transparent red, half-transparent black, opaque grey.
  const bgra = Buffer.from([0, 0, 0, 0, 0, 0, 128, 128, 0, 0, 0, 128, 90, 90, 90, 255]);
  const ppm = bitmapToPpm(bgra, 4, 1);
  const header = 'P6\n4 1\n255\n';
  assert.deepEqual([...ppm.subarray(header.length)], [255, 255, 255, 255, 127, 127, 127, 127, 127, 90, 90, 90]);
});

test('a screenshot with dark text on a transparent background: every private detail is found', { timeout: 120000 }, async (t) => {
  let intel;
  try { intel = new TextIntelService({ store: null, settings: { get: () => ({}) }, dataDir: makeTmpDir('ocr-alpha'), windowContextProvider: {} }); }
  catch (err) { t.skip(`text recognition unavailable: ${err.message}`); return; }
  t.after(() => intel.shutdown());
  // The fixture as black text whose darkness is all in the alpha channel,
  // the way Electron hands over a transparent PNG (premultiplied BGRA).
  const { width, height, data } = decodePng(fs.readFileSync(path.join(__dirname, '../fixtures/private-details-2x.png')));
  const bgra = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const luma = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    bgra[i * 4 + 3] = 255 - luma;
  }
  const lines = await intel.readLines(bitmapToPpm(bgra, width, height));
  const kinds = red.findInLines(lines, { terms: [] }).map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['card', 'email', 'ip', 'phone', 'secret', 'secret', 'ssn', 'url']);
});

test('a busy screen: text is found all over the page, not read as one block', { timeout: 120000 }, async (t) => {
  let intel;
  try { intel = new TextIntelService({ store: null, settings: { get: () => ({}) }, dataDir: makeTmpDir('ocr-busy'), windowContextProvider: {} }); }
  catch (err) { t.skip(`text recognition unavailable: ${err.message}`); return; }
  t.after(() => intel.shutdown());
  // A header bar, a side menu and a bordered table. Read as one block of
  // text, as Tesseract does by default, none of these details were found.
  const lines = await intel.readLines(fs.readFileSync(path.join(__dirname, '../fixtures/busy-admin-screen.png')));
  const found = red.findInLines(lines, { terms: [] });
  const emails = found.filter((f) => f.kind === 'email').map((f) => f.text.replace(/\s+/g, ''));
  for (const name of ['avery.lee', 'jordan.kim', 'sam.ortiz', 'riley.chen', 'morgan.patel', 'quinn.davis', 'taylor.nguyen', 'casey.brooks']) {
    assert.ok(emails.includes(`${name}@contoso.com`), `${name}'s email is found`);
  }
  assert.equal(found.filter((f) => f.kind === 'ip').length, 8);
});

test('a real screenshot: text recognition finds every private detail and nothing else', { timeout: 120000 }, async (t) => {
  let intel;
  try { intel = new TextIntelService({ store: null, settings: { get: () => ({}) }, dataDir: makeTmpDir('ocr'), windowContextProvider: {} }); }
  catch (err) { t.skip(`text recognition unavailable: ${err.message}`); return; }
  t.after(() => intel.shutdown());
  const { store, guideId, stepId } = guideWithScreenshot(t);
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/private-details-2x.png'));
  const redactor = new RedactionService({ store, settings: { get: () => ({ terms: [] }) },
    readLines: (png) => intel.readLines(png),
    loadImage: async () => ({ width: 1000, height: 460, encode: (scale) => { assert.equal(scale, 2); return fixture; } }) });
  const result = await redactor.checkGuide(guideId);
  assert.deepEqual(result.blurs.map((b) => b.kind).sort(), ['card', 'email', 'ip', 'phone', 'secret', 'secret', 'ssn', 'url']);
  const blurs = store.getStep(guideId, stepId).annotations;
  // The email is in the header bar at the top; nothing is blurred in the order line near the bottom.
  assert.ok(blurs.some((b) => b.redact.kind === 'email' && b.y < 0.08));
  assert.ok(blurs.every((b) => b.y < 0.66), 'the order number, date and price are left alone');
});

test('a check that finds nothing does not mark the guide as edited; one that adds a blur does', async (t) => {
  const { store, guideId } = guideWithScreenshot(t);
  // updatedAt has one-second resolution, so start from an old one.
  store.saveGuide({ ...store.getGuide(guideId), updatedAt: '2026-01-01T00:00:00Z' }, { touch: false });
  const before = store.getGuide(guideId);
  const quiet = service(store, [{ words: [{ text: 'Settings', bbox: { x0: 0, y0: 0, x1: 80, y1: 30 } }] }]);
  assert.equal((await quiet.redactor.checkGuide(guideId)).added, 0);
  const after = store.getGuide(guideId);
  assert.equal(after.updatedAt, before.updatedAt, 'only bookkeeping changed');
  assert.ok(after.revision > before.revision, 'the revision still moves');

  const found = service(store, [{ words: [{ text: 'casey@contoso.com', bbox: { x0: 200, y0: 40, x1: 600, y1: 70 } }] }]);
  assert.equal((await found.redactor.checkGuide(guideId, { force: true })).added, 1);
  assert.notEqual(store.getGuide(guideId).updatedAt, before.updatedAt, 'a new blur is a real change');
});
