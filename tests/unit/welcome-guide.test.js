'use strict';

// The "Welcome to StepForge" sample guide a new library starts with.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { createTranslator } = require('../../core/i18n');
const LOCALES = require('../../core/locales');
const { addWelcomeGuide, isNewLibrary, IMAGES_DIR } = require('../../core/welcome-guide');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { sniffImageFormat, prepareExportImages } = require('../../core/image-format');
const { makeTmpDir, rmrf } = require('./helpers');

const english = createTranslator('en').t;

test('the welcome guide: five steps, four with screenshots, code and a table', (t) => {
  const root = makeTmpDir('welcome');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guideId = addWelcomeGuide(store, { t: english });

  const guide = store.getGuide(guideId);
  assert.equal(guide.title, 'Welcome to StepForge');
  assert.equal(guide.descriptionHtml, '<p>A sample guide to show you around.</p>');
  const steps = guide.stepsOrder.map((id) => store.getStep(guideId, id));
  assert.deepEqual(steps.map((s) => s.title), [
    'Start a new capture', 'Tidy up your steps', 'Draw on the screenshot', 'Add code and tables', 'Export or share it',
  ]);
  assert.deepEqual(steps.map((s) => s.kind), ['image', 'image', 'image', 'empty', 'image']);
  for (const step of steps.filter((s) => s.kind === 'image')) {
    const file = path.join(store.stepDir(guideId, step.stepId), step.image.workingPath);
    assert.equal(sniffImageFormat(fs.readFileSync(file)), 'webp');
    assert.ok(step.image.size.width > 1000 && step.image.size.height > 600, 'real size recorded');
    assert.ok(step.annotations.length > 0, 'the screenshot points at something');
    for (const a of step.annotations) assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 1 && a.y + a.h <= 1, `${step.title}: annotation inside the picture`);
  }
  // Button names are bold.
  assert.match(steps[0].descriptionHtml, /Click <strong>New Capture<\/strong>, then/);
  assert.match(steps[2].textBlocks[0].descriptionHtml, /<strong>More → Find private details…<\/strong>/);
  assert.equal(steps[3].codeBlocks[0].language, 'bash');
  assert.deepEqual(steps[3].tableBlocks[0].rows[1], ['Ctrl+Shift+1', 'Take a step without clicking']);
});

test('the welcome guide follows the interface language and this computer’s shortcuts', (t) => {
  const root = makeTmpDir('welcomefr');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { t: french } = createTranslator('fr', LOCALES);
  const guideId = addWelcomeGuide(store, { t: french, hotkeys: { capture: 'Meta+Alt+1', pauseResume: 'CommandOrControl+Alt+2' } });
  const guide = store.getGuide(guideId);
  assert.equal(guide.title, 'Bienvenue dans StepForge');
  const steps = guide.stepsOrder.map((id) => store.getStep(guideId, id));
  assert.match(steps[0].descriptionHtml, /<strong>Nouvelle capture<\/strong>/);
  assert.deepEqual(steps[3].tableBlocks[0].rows.slice(1).map((row) => row[0]), ['Meta+Alt+1', 'Ctrl+Alt+2']);
});

test('the welcome guide exports (PDF, Word, Markdown)', async (t) => {
  const root = makeTmpDir('welcomeexport');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guideId = addWelcomeGuide(store, { t: english });
  // As the export worker does: WebP screenshots are decoded first.
  const ast = buildRenderAst(store, guideId, { images: await prepareExportImages(store, guideId) });
  for (const format of ['pdf', 'docx', 'markdown']) {
    const result = runExport(format, ast, path.join(root, format), {});
    assert.ok(fs.statSync(result.file).size > 1000, `${format} written`);
  }
  const md = fs.readFileSync(runExport('markdown', ast, path.join(root, 'md2'), {}).file, 'utf8');
  assert.match(md, /```bash\ngit clone/);
  assert.equal(md.match(/!\[[^\]]*\]\(steps-[^)]+\)/g).length, 4);
});

test('only a new library gets it, and only once', (t) => {
  const root = makeTmpDir('welcomenew');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  assert.equal(isNewLibrary(store), true);

  // What app/main.js does at startup.
  const start = () => {
    const isNew = isNewLibrary(store);
    const settings = new Settings(store.settingsDir);
    if (isNew && !settings.get('welcomeGuideAdded')) {
      settings.set('welcomeGuideAdded', true);
      addWelcomeGuide(store, { t: english });
    }
  };
  start();
  assert.equal(store.listGuides().length, 1);
  // Deleted, it stays deleted.
  store.deleteGuide(store.listGuides()[0].guideId);
  start();
  assert.equal(store.listGuides().length, 0);
  assert.equal(isNewLibrary(store), false);

  // An existing library without a settings file (copied by hand) keeps its guides only.
  const other = new GuideStore(path.join(root, 'other'));
  other.createGuide({ title: 'Mine' });
  assert.equal(isNewLibrary(other), false);
});

test('the welcome screenshots ship inside app/ (packaged on every platform)', () => {
  assert.equal(path.relative(path.join(__dirname, '..', '..', 'app'), IMAGES_DIR), path.join('assets', 'welcome-guide'));
  const files = fs.readdirSync(IMAGES_DIR).sort();
  assert.deepEqual(files, ['annotate.webp', 'edit-steps.webp', 'export.webp', 'start-capture.webp']);
  const total = files.reduce((sum, f) => sum + fs.statSync(path.join(IMAGES_DIR, f)).size, 0);
  assert.ok(total < 1024 * 1024, `screenshots stay small (${total} bytes)`);
});
