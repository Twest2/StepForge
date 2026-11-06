'use strict';

// Test environment helpers: throwaway data folders, reading what the app
// wrote to disk, and decoding the files it exported. Reading files is how
// assertions are made; nothing here performs a UI action.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, launchApp } = require('./driver');
const { decodePng } = require(path.join(REPO_ROOT, 'core', 'png'));

const ARTIFACT_DIR = process.env.STEPFORGE_E2E_ARTIFACTS
  || path.join(REPO_ROOT, '.tmp', 'e2e-artifacts');

/**
 * A fresh folder for one test: a copy of the offline sample library as the
 * data folder, plus a separate Electron userData folder.
 */
function makeTestRoot(name, { sample = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stepforge-e2e-${name}-`));
  const dataDir = path.join(root, 'data');
  if (sample) {
    const made = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'make-sample-guide.js'), '--root', path.join(root, 'sample')], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`make-sample-guide failed: ${made.stderr || made.stdout}`);
    fs.renameSync(path.join(root, 'sample', 'sample-data'), dataDir);
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return { root, dataDir, userDataDir: path.join(root, 'userdata') };
}

/**
 * Starts the app for one test and always cleans up. On failure a screenshot
 * and the app output are kept in the artifact folder (uploaded by CI).
 */
async function withApp(name, options, body) {
  const env = makeTestRoot(name, options);
  let app;
  try {
    app = await launchApp({ dataDir: env.dataDir, userDataDir: env.userDataDir, artifactDir: ARTIFACT_DIR, env: options.env });
    return await body(app, env);
  } catch (error) {
    const shot = app ? await app.page.screenshot(`${name}-failure.png`).catch(() => null) : null;
    const logFile = path.join(ARTIFACT_DIR, `${name}-app.log`);
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(logFile, app ? app.log() : error.stack);
    error.message += `\n  screenshot: ${shot}\n  app log: ${logFile}`;
    throw error;
  } finally {
    if (app) await app.close();
    if (!process.env.STEPFORGE_E2E_KEEP) fs.rmSync(env.root, { recursive: true, force: true });
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback = null) {
  return fs.existsSync(file) ? readJson(file) : fallback;
}

/** Every guide in the library folder as { dir, guide }. */
function listLibraryGuides(dataDir) {
  const guidesDir = path.join(dataDir, 'library', 'guides');
  if (!fs.existsSync(guidesDir)) return [];
  return fs.readdirSync(guidesDir)
    .map((name) => path.join(guidesDir, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'guide.json')))
    .map((dir) => ({ dir, guide: readJson(path.join(dir, 'guide.json')) }));
}

function findGuideByTitle(dataDir, title) {
  return listLibraryGuides(dataDir).find((entry) => entry.guide.title === title) || null;
}

/** Steps of a guide in saved order, each with its step.json and folder. */
function readSteps(guideDir) {
  const guide = readJson(path.join(guideDir, 'guide.json'));
  return (guide.stepsOrder || []).map((stepId) => {
    const dir = path.join(guideDir, 'steps', stepId);
    return { stepId, dir, step: readJson(path.join(dir, 'step.json')) };
  });
}

function listTrashGuides(dataDir) {
  const trashDir = path.join(dataDir, 'library', 'trash');
  if (!fs.existsSync(trashDir)) return [];
  return fs.readdirSync(trashDir)
    .filter((name) => fs.existsSync(path.join(trashDir, name, 'guide.json')))
    .map((name) => ({ name, guide: readJson(path.join(trashDir, name, 'guide.json')) }));
}

function readAppSettings(dataDir) {
  return readJsonIfExists(path.join(dataDir, 'settings', 'app-settings.json'), {});
}

function readFolders(dataDir) {
  return readJsonIfExists(path.join(dataDir, 'library', 'folders.json'), { folders: [], guideFolders: {} });
}

/** Decodes a PNG file to { width, height, data } RGBA using the app's own decoder. */
function decodePngFile(file) {
  return decodePng(fs.readFileSync(file));
}

/** RGBA [r, g, b, a] of one pixel of a decoded image. */
function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

/** Waits for a file to exist. Polls are done by the caller's poll(); this is a plain check. */
function fileExists(file) {
  return fs.existsSync(file);
}

module.exports = {
  ARTIFACT_DIR,
  makeTestRoot,
  withApp,
  readJson,
  readJsonIfExists,
  listLibraryGuides,
  findGuideByTitle,
  readSteps,
  listTrashGuides,
  readAppSettings,
  readFolders,
  decodePngFile,
  pixelAt,
  fileExists,
};

/** Writes a 240x160 PNG with known colours: red left half, blue right half, green box in the middle. */
function writeTestPng(file) {
  const { createImage, fillRect } = require(path.join(REPO_ROOT, 'core', 'raster'));
  const { encodePng } = require(path.join(REPO_ROOT, 'core', 'png'));
  const img = createImage(240, 160, [255, 255, 255, 255]);
  fillRect(img, 0, 0, 120, 160, [220, 30, 30, 255]);
  fillRect(img, 120, 0, 120, 160, [30, 30, 220, 255]);
  fillRect(img, 80, 60, 80, 40, [30, 160, 60, 255]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(img));
  return file;
}

/**
 * Decodes a stored step image (PNG or WebP, whatever the app saved) to RGBA.
 * Uses the app's own image reader, so WebP files are decoded the same way the app does.
 */
async function decodeStoredImage(file) {
  const { rasterToPng } = require(path.join(REPO_ROOT, 'core', 'image-format'));
  const png = await rasterToPng(fs.readFileSync(file));
  return decodePng(png);
}

module.exports.writeTestPng = writeTestPng;
module.exports.decodeStoredImage = decodeStoredImage;
