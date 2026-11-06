'use strict';

// Share → Copy to clipboard, clicked as a person would: the progress window,
// what lands on the operating system clipboard, and that Export still opens.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withApp, readSteps } = require('./lib/fixtures');
const { openLibrary, openGuideCard, eventually } = require('./lib/flows');

const TITLE = 'Reset a password in Admin Portal';

/** One clipboard format as text, read the way a pasting app would. */
const readClipboard = (type) => `(async () => {
  const { clipboard } = process.mainModule.require('electron');
  const item = (await clipboard.read()).find((entry) => entry.types.includes(${JSON.stringify(type)}));
  return item ? await (await item.getType(${JSON.stringify(type)})).text() : '';
})()`;

test('Copy to clipboard shows its progress in a window and copies the filled-in guide with real images', () => withApp('clipboard', {}, async (app, env) => {
  // A global placeholder (Settings) and a guide placeholder, used in a step title.
  fs.mkdirSync(path.join(env.dataDir, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'settings', 'placeholders.json'), JSON.stringify({ Company: 'Globex' }));
  const guideDir = path.join(env.dataDir, 'library', 'guides', 'guide-sample-reset-password');
  const first = readSteps(guideDir)[0];
  fs.writeFileSync(path.join(first.dir, 'step.json'), JSON.stringify({ ...first.step, title: 'Open [[Product]] for [[Company]]' }, null, 2));

  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
  await app.clickText('Share ▾');
  await app.clickText('Copy to clipboard');

  // The window lists the three stages, then says what was copied.
  const stages = await eventually(() => app.evaluate(`(() => {
    const items = [...document.querySelectorAll('#modal-root .gh-stage .gh-stage-label')];
    return items.length ? items.map((item) => item.textContent) : null;
  })()`), 'copy progress window');
  assert.deepEqual(stages, ['Check screenshots for private details', 'Build the copy with its screenshots', 'Put it on the clipboard']);
  await app.waitForVisible('#modal-root button.primary', { timeout: 60000, label: 'Done button' });
  const finished = await app.evaluate(`document.querySelector('#modal-root .gh-publishing strong')?.textContent`);
  assert.equal(finished, `Copied “${TITLE}” to the clipboard.`);

  // What a pasting app gets: HTML with the guide and its images, and plain text.
  const html = await app.main.evaluate(readClipboard('text/html'));
  const doc = await app.evaluate(`(() => {
    const d = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
    return {
      title: d.querySelector('h1')?.textContent,
      steps: [...d.querySelectorAll('h2, h3')].map((h) => h.textContent),
      text: d.body.textContent,
      images: [...d.images].map((img) => img.getAttribute('src')),
    };
  })()`);
  assert.equal(doc.title, TITLE);
  assert.equal(doc.steps[0], '1. Open Admin Portal for Globex', 'guide and global placeholders are filled in');
  assert.ok(!doc.text.includes('[['), 'no placeholder is left unfilled');
  assert.ok(doc.images.length >= 3);
  for (const src of doc.images) {
    const size = await app.main.evaluate(`process.mainModule.require('electron').nativeImage.createFromDataURL(${JSON.stringify(src)}).getSize()`);
    assert.ok(size.width > 100 && size.height > 50, `an embedded screenshot decodes (${src.slice(0, 30)}…)`);
  }
  const text = await app.main.evaluate(readClipboard('text/plain'));
  assert.equal(text.split('\n')[0], TITLE);

  // Done closes the window, and Export opens afterwards.
  await app.click('#modal-root button.primary');
  await app.waitForGone('#modal-root .gh-publishing');
  await app.clickText('Export');
  await app.waitForVisible('.export-dialog', { label: 'Export dialog' });
}));
