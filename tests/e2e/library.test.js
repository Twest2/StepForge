'use strict';

// Library: guides, favourites, folders, Trash. Every step is a real click or
// key press, and each result is checked in the files the app wrote.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, findGuideByTitle, listLibraryGuides, listTrashGuides, readFolders, readJson } = require('./lib/fixtures');
const flows = require('./lib/flows');
const path = require('node:path');
const fs = require('node:fs');

const SAMPLE_ID = 'guide-sample-reset-password';
const SAMPLE_TITLE = 'Reset a password in Admin Portal';

test('creating a guide from the library writes it to disk', () => withApp('library-create', {}, async (app, env) => {
  await flows.openLibrary(app);
  await app.clickText('New guide');
  await flows.answerPrompt(app, 'E2E created guide');
  const created = await flows.eventually(() => findGuideByTitle(env.dataDir, 'E2E created guide'), 'new guide on disk');
  assert.equal(listLibraryGuides(env.dataDir).length, 2, 'library now holds the sample and the new guide');
  assert.deepEqual(created.guide.stepsOrder, []);
}));

test('renaming a guide from its card menu updates guide.json', () => withApp('library-rename', {}, async (app, env) => {
  await flows.openLibrary(app);
  await flows.libraryAction(app, SAMPLE_TITLE, 'Rename guide…');
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
