'use strict';

// Library: guides, favourites, folders, Trash. Every step is a real click or
// key press, and each result is checked in the files the app wrote.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, findGuideByTitle, listLibraryGuides, listTrashGuides, readFolders, readJson } = require('./lib/fixtures');
const flows = require('./lib/flows');
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const { GuideStore } = require('../../core/store');
const { encodePng } = require('../../core/png');
const { createImage, fillRect } = require('../../core/raster');

const SAMPLE_ID = 'guide-sample-reset-password';
const SAMPLE_TITLE = 'Reset a password in Admin Portal';

test('creating a guide from the library writes it to disk', () => withApp('library-create', {}, async (app, env) => {
  await flows.openLibrary(app);
  await app.clickText('New guide');
  await flows.answerPrompt(app, 'E2E created guide', 'Create');
  const created = await flows.eventually(() => findGuideByTitle(env.dataDir, 'E2E created guide'), 'new guide on disk');
  assert.equal(listLibraryGuides(env.dataDir).length, 2, 'library now holds the sample and the new guide');
  assert.deepEqual(created.guide.stepsOrder, []);
}));

test('renaming a guide from its card menu updates guide.json', () => withApp('library-rename', {}, async (app, env) => {
  await flows.openLibrary(app);
  await flows.libraryAction(app, SAMPLE_TITLE, 'Rename guide');
  await flows.answerPrompt(app, 'Renamed by e2e');
  const guide = await flows.eventually(() => {
    const entry = listLibraryGuides(env.dataDir).find((g) => g.guide.guideId === SAMPLE_ID);
    return entry && entry.guide.title === 'Renamed by e2e' ? entry.guide : null;
  }, 'renamed title on disk');
  assert.equal(guide.guideId, SAMPLE_ID, 'same guide folder, only the title changed');
}));

test('favouriting and unfavouriting a guide is saved to guide.json', () => withApp('library-favourite', {}, async (app, env) => {
  await flows.openLibrary(app);
  const favouriteOn = () => readJson(path.join(env.dataDir, 'library', 'guides', SAMPLE_ID, 'guide.json')).favorite;
  assert.equal(favouriteOn(), false);

  await app.clickWhere('.fav', "(el) => el.getAttribute('aria-label') === 'Add to favorites'");
  await flows.eventually(() => favouriteOn() === true, 'favorite saved as true');

  await app.clickWhere('.fav', "(el) => el.getAttribute('aria-label') === 'Remove from favorites'");
  await flows.eventually(() => favouriteOn() === false, 'favorite saved as false');
}));

test('a guide moved into a new folder is recorded in folders.json', () => withApp('library-folder', {}, async (app, env) => {
  await flows.openLibrary(app);
  await app.click('.lib-add-folder');
  await flows.answerPrompt(app, 'E2E folder');
  const folder = await flows.eventually(() => readFolders(env.dataDir).folders.find((f) => f.name === 'E2E folder'), 'folder on disk');

  await flows.libraryAction(app, SAMPLE_TITLE, 'Move to E2E folder');
  const membership = await flows.eventually(() => readFolders(env.dataDir).guideFolders[SAMPLE_ID], 'guide placed in folder');
  assert.equal(membership, folder.id);
}));

test('deleting a guide sends it to Trash, restoring brings it back, emptying Trash removes it', () => withApp('library-trash', {}, async (app, env) => {
  const guideDir = path.join(env.dataDir, 'library', 'guides', SAMPLE_ID);
  await flows.openLibrary(app);

  await flows.libraryAction(app, SAMPLE_TITLE, 'Delete guide');
  await flows.confirmDialog(app, 'Delete');
  await flows.eventually(() => !fs.existsSync(guideDir) && listTrashGuides(env.dataDir).length === 1, 'guide moved to trash');

  await app.click('.lib-side-footer button');
  await app.clickText('Restore');
  await flows.eventually(() => fs.existsSync(path.join(guideDir, 'guide.json')) && listTrashGuides(env.dataDir).length === 0, 'guide restored from trash');
  assert.equal(readJson(path.join(guideDir, 'guide.json')).guideId, SAMPLE_ID);

  await app.clickWhere('.nav-item', "(el) => el.textContent.startsWith('All guides')");
  await flows.libraryAction(app, SAMPLE_TITLE, 'Delete guide');
  await flows.confirmDialog(app, 'Delete');
  await flows.eventually(() => listTrashGuides(env.dataDir).length === 1, 'guide in trash again');

  await app.click('.lib-side-footer button');
  await app.clickWhere('button', "(el) => el.textContent.trim() === 'Empty trash'");
  await flows.confirmDialog(app, 'Empty trash');
  await flows.eventually(() => listTrashGuides(env.dataDir).length === 0, 'trash emptied on disk');
  assert.equal(fs.existsSync(guideDir), false, 'the guide folder is gone for good');
}));

test('guide cards show a screenshot of the guide', () => withApp('library-thumbnails', {}, async (app) => {
  await flows.openLibrary(app);
  // The sample's first step, scaled down to 640 pixels wide.
  await flows.eventually(() => app.evaluate("document.querySelector('.guide-card .card-thumb')?.naturalWidth === 640"), 'first step screenshot loaded');
}));

test('library thumbnails hide automatic and newly drawn privacy blurs, even after an unblurred thumbnail was cached', () => withApp('library-thumbnail-privacy', {
  sample: false,
  setup: async (env) => {
    const screenshot = createImage(640, 360, [240, 240, 240, 255]);
    fillRect(screenshot, 128, 100, 64, 64, [240, 0, 0, 255]);
    fillRect(screenshot, 416, 100, 64, 64, [240, 0, 0, 255]);
    const bytes = await sharp(encodePng(screenshot)).webp({ lossless: true }).toBuffer();
    const store = new GuideStore(env.dataDir);
    const guide = store.createGuide({ title: 'Thumbnail privacy test' });
    env.guideId = guide.guideId;
    store.addStep(guide.guideId, {
      title: 'Sample screenshot',
      annotations: [{ type: 'blur', x: 0.64, y: 0.26, w: 0.12, h: 0.22, radius: 8,
        redact: { kind: 'email', key: 'fixture' } }],
    }, bytes, { width: 640, height: 360 });
  },
}, async (app, env) => {
  const thumbnail = () => app.evaluate(`(() => {
    const img = document.querySelector('.card-thumb[data-guide-id="${env.guideId}"]');
    if (!img?.offsetParent || img.naturalWidth !== 640) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return {
      version: img.dataset.version,
      manualRegion: [...ctx.getImageData(160, 130, 1, 1).data],
      detectedRegion: [...ctx.getImageData(448, 130, 1, 1).data],
    };
  })()`);
  await flows.openLibrary(app);
  const before = await flows.eventually(thumbnail, 'first thumbnail loaded');
  assert.ok(before.manualRegion[1] < 30, 'the region that has no blur is red');
  assert.ok(before.detectedRegion[1] > 210, 'the automatic blur hides the red sample pixels');

  await flows.openGuideCard(app, 'Thumbnail privacy test');
  await app.click('button[data-tool="blur"]');
  const bounds = await flows.eventually(() => app.evaluate(`(() => {
    const canvas = document.querySelector('.canvas-wrap canvas');
    const r = canvas?.getBoundingClientRect();
    return r?.width > 200 ? r.toJSON() : null;
  })()`), 'screenshot visible on the canvas');
  await app.drag(
    { x: bounds.x + bounds.width * 0.18, y: bounds.y + bounds.height * 0.24 },
    { x: bounds.x + bounds.width * 0.32, y: bounds.y + bounds.height * 0.49 }
  );
  await app.clickText('Library');
  const after = await flows.eventually(thumbnail, 'thumbnail loaded after saving the blur');
  assert.notEqual(after.version, before.version, 'the blur invalidates the cached thumbnail');
  assert.ok(after.manualRegion[1] > 210, 'the new manual blur hides the red sample pixels');
  assert.ok(after.detectedRegion[1] > 210, 'the automatic blur is still applied');
  assert.equal(await app.evaluate(`window.stepforge.library.thumbnail(${JSON.stringify({ guideId: env.guideId, version: before.version })})`), null,
    'an outdated thumbnail request cannot fetch the image');
}));

test('starting StepForge with a guide file opens it in the editor, not the welcome screen', () => withApp('library-open-file', {
  args: (env) => [path.join(env.root, 'sample', 'sample-guide.sfgz')],
}, async (app, env) => {
  await app.waitForVisible('.step-select, .step-actions', { label: 'the guide editor' });
  assert.equal(await app.evaluate("document.getElementById('welcome-host').childElementCount"), 0, 'the welcome screen was never drawn');
  assert.equal(listLibraryGuides(env.dataDir).length, 2, 'imported as a copy beside the sample');
}));

test('More → Library thumbnail chooses a step screenshot or an image file for the card', () => withApp('library-thumbnail-choice', {}, async (app, env) => {
  const { readSteps, writeTestPng } = require('./lib/fixtures');
  const openSubmenu = (label) => app.clickWhere('[role=menuitem]', `(el) => el.textContent.startsWith(${JSON.stringify(label)})`);
  const guideFile = () => readJson(path.join(findGuideByTitle(env.dataDir, SAMPLE_TITLE).dir, 'guide.json'));
  await flows.openLibrary(app);
  await flows.openGuideCard(app, SAMPLE_TITLE);
  const second = readSteps(findGuideByTitle(env.dataDir, SAMPLE_TITLE).dir).filter((s) => s.step.image)[1].step;

  await app.clickText('More ▾');
  await openSubmenu('Library thumbnail');
  await openSubmenu('Choose a screenshot');
  await app.clickWhere('.ctx-submenu [role=menuitem]', `(el) => el.textContent.startsWith('2 ')`);
  await flows.eventually(() => guideFile().thumbnailStepId === second.stepId, 'chosen step saved');

  await app.main.stubDialogs({ open: [{ filePaths: [writeTestPng(path.join(env.root, 'pick', 'cover.png'))] }] });
  await app.clickText('More ▾');
  await openSubmenu('Library thumbnail');
  await app.clickText('Choose an image');
  const saved = await flows.eventually(() => guideFile().thumbnailImage?.startsWith('data:image/webp;base64,') && guideFile(), 'chosen image saved');
  assert.equal(saved.thumbnailStepId, undefined, 'the image replaces the chosen screenshot');

  await app.clickText('Library');
  await flows.eventually(() => app.evaluate(`document.querySelector('.guide-card .card-thumb')?.src.startsWith('data:image/webp')`), 'card shows the chosen image');
}));

test('library thumbnails show the step’s annotations and update when one is added', () => withApp('library-thumbnail-annotations', {
  sample: false,
  setup: async (env) => {
    const bytes = await sharp(encodePng(createImage(640, 360, [240, 240, 240, 255]))).webp({ lossless: true }).toBuffer();
    const store = new GuideStore(env.dataDir);
    const guide = store.createGuide({ title: 'Thumbnail annotations test' });
    env.guideId = guide.guideId;
    store.addStep(guide.guideId, {
      title: 'Annotated screenshot',
      annotations: [{ id: 'green-box', type: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.3, style: { stroke: '#00A000', fill: '#00A000', strokeWidth: 3 } }],
    }, bytes, { width: 640, height: 360 });
  },
}, async (app, env) => {
  const thumbnail = () => app.evaluate(`(() => {
    const img = document.querySelector('.card-thumb[data-guide-id="${env.guideId}"]');
    if (!img?.offsetParent || img.naturalWidth !== 640) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { version: img.dataset.version, inBox: [...ctx.getImageData(128, 126, 1, 1).data], outside: [...ctx.getImageData(480, 300, 1, 1).data] };
  })()`);
  await flows.openLibrary(app);
  const before = await flows.eventually(thumbnail, 'thumbnail loaded');
  assert.ok(before.inBox[1] > 120 && before.inBox[0] < 60 && before.inBox[2] < 60, `the green rectangle is drawn (${before.inBox})`);
  assert.ok(before.outside.slice(0, 3).every((v) => v > 200), 'the rest of the screenshot is unchanged');

  await flows.openGuideCard(app, 'Thumbnail annotations test');
  await app.click('[data-tool="rect"]');
  const bounds = await flows.eventually(() => app.evaluate(`(() => {
    const r = document.querySelector('.canvas-wrap canvas')?.getBoundingClientRect();
    return r?.width > 200 ? r.toJSON() : null;
  })()`), 'screenshot visible on the canvas');
  await app.drag({ x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.6 }, { x: bounds.x + bounds.width * 0.8, y: bounds.y + bounds.height * 0.9 });
  await app.clickText('Library');
  const after = await flows.eventually(async () => {
    const shot = await thumbnail();
    return shot && shot.version !== before.version ? shot : null;
  }, 'thumbnail redrawn after adding a rectangle');
  assert.ok(after.inBox[1] > 120, 'the first rectangle is still there');
}));
