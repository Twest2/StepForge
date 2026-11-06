'use strict';

// Shared navigation: the steps a person takes to reach a screen. Each one is
// made of real clicks through the driver.

const { poll } = require('./driver');

/** From the welcome screen, open the library ("Existing Workspace"). */
async function openLibrary(app) {
  await app.waitForVisible('.welcome-btn', { label: 'welcome screen' });
  await app.clickWhere('.welcome-btn', "(el) => el.textContent.includes('Existing Workspace')");
  await app.waitForVisible('.card-open', { label: 'guide cards in the library' });
}

/** From the library, open the card whose title starts with `title`. */
async function openGuideCard(app, title) {
  await app.clickWhere('.card-open', `(el) => (el.getAttribute('aria-label') || '').includes(${JSON.stringify(title)})`);
  await app.waitForVisible('.step-select, .editor-empty, .step-actions', { label: 'the guide editor' });
}

/** Opens the card actions menu of a guide and picks an entry by its text. */
async function libraryAction(app, title, entry) {
  await app.clickWhere('.card-actions', `(el) => (el.getAttribute('aria-label') || '').includes(${JSON.stringify(title)})`);
  await app.clickText(entry);
}

/** Answers the app's own confirm or prompt dialog: type a value, then press OK. */
async function answerPrompt(app, value) {
  await app.waitForVisible('#modal-root input', { label: 'prompt dialog' });
  await app.setValue('#modal-root input', value);
  await app.clickText('OK', { scope: '#modal-root' });
}

async function confirmDialog(app, okLabel) {
  await app.waitForVisible('#modal-root', { label: 'confirm dialog' });
  await app.clickText(okLabel, { scope: '#modal-root' });
}

/** Waits until a condition on disk holds. */
function eventually(fn, label) {
  return poll(fn, { timeout: 15000, interval: 100, label });
}

module.exports = { openLibrary, openGuideCard, libraryAction, answerPrompt, confirmDialog, eventually };

/**
 * Adds a step from an image file through Add → Choose image… → Add, as a person
 * would. Returns the new step's id once it is on disk.
 */
async function addPictureStep(app, { picture, title, guideDir }) {
  const { readSteps } = require('./fixtures');
  await app.main.stubDialogs({ open: [{ filePaths: [picture] }] });
  await app.clickText('Add');
  await app.waitForVisible('#modal-root input', { label: 'add step dialog' });
  await app.clickText('Choose image…', { scope: '#modal-root' });
  await app.waitForVisible('#modal-root .primary', { label: 'add button' });
  await app.setValue('#modal-root input', title);
  await app.clickText('Add', { scope: '#modal-root' });
  const step = await eventually(() => readSteps(guideDir).find((s) => s.step.title === title), `step "${title}" on disk`);
  await eventually(() => app.evaluate(`document.querySelector('input[aria-label="Step title"]')?.value === ${JSON.stringify(title)}`), 'new step selected');
  await eventually(() => app.evaluate(`document.querySelector('canvas[aria-label="Screenshot editor"]')?.width === 240`), 'new image rendered');
  return step.stepId;
}

/** Turns off the step's "Focused" view so the canvas shows the whole image. */
async function showWholeImage(app, stepId, guideDir) {
  const { readJson } = require('./fixtures');
  const path = require('node:path');
  const file = path.join(guideDir, 'steps', stepId, 'step.json');
  if (readJson(file).focusedView?.enabled) {
    await app.clickText('Focused');
    await eventually(() => readJson(file).focusedView.enabled === false, 'focused view off on disk');
  }
  await eventually(() => app.evaluate(`document.querySelector('canvas[aria-label="Screenshot editor"]')?.width === 240`), 'whole image rendered');
}

module.exports.addPictureStep = addPictureStep;
module.exports.showWholeImage = showWholeImage;

async function exportThroughUi(app, env, format, extension) {
  const fs = require('node:fs');
  const path = require('node:path');
  const outDir = path.join(env.root, format);
  fs.mkdirSync(outDir);
  await app.clickText('Export');
  await app.waitForVisible('.export-format select');
  const label = await app.evaluate(`Array.from(document.querySelector('.export-format select').options).find(o => o.value === ${JSON.stringify(format)}).textContent`);
  await app.selectOption('.export-format select', label);
  await app.main.stubDialogs({ open: [{ filePaths: [outDir] }] });
  await app.clickText('Choose…', { scope: '.export-output-folder' });
  await eventually(() => app.evaluate(`document.querySelector('input[aria-label="Output folder"]').value === ${JSON.stringify(outDir)}`), 'output folder chosen');
  await app.clickText('Export', { scope: '#modal-root' });
  await app.waitForGone('.export-dialog', { timeout: 60000 });
  return eventually(() => {
    const name = fs.readdirSync(outDir).find((f) => f.endsWith(extension));
    return name && path.join(outDir, name);
  }, `${format} output`);
}

module.exports.exportThroughUi = exportThroughUi;
