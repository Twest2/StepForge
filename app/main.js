'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, globalShortcut,
  clipboard, nativeImage, screen,
} = require('electron');

const { GuideStore } = require('../core/store');
const { Settings } = require('../core/settings');
const { SearchIndex } = require('../core/search');
const { TemplateManager, FORMATS } = require('../core/templates');
const { buildRenderAst } = require('../core/renderast');
const { runExport, EXPORTERS } = require('../exporters');
const { exportGuideArchive, importGuideArchive, saveLinkedGuide, readArchive } = require('../core/archive');
const { createSnapshot, listSnapshots, restoreSnapshot } = require('../core/snapshots');
const { readLock } = require('../core/locks');
const CaptureService = require('./capture');

/**
 * StepForge main process. Zero network code: no telemetry, no updates, no
 * remote anything. The renderer is sandboxed; everything below is the full
 * privileged surface.
 */

function resolveDataDir() {
  if (process.env.STEPFORGE_DATA_DIR) return process.env.STEPFORGE_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'stepforge');
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'stepforge');
}

let store;
let settings;
let searchIndex;
let templates;
let capture;
let mainWindow;

function reindex(guideId) {
  try {
    searchIndex.indexGuide(store.getGuide(guideId), store.listSteps(guideId));
  } catch {
    // index failures must never block saves
  }
}

function orderedSteps(guideId) {
  const guide = store.getGuide(guideId);
  const steps = store.listSteps(guideId);
  return guide.stepsOrder.map((id) => steps.get(id)).filter(Boolean);
}

function applyTheme() {
  nativeTheme.themeSource = settings.get('appearance') || 'system';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111827' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: Boolean(settings.get('spellcheck')),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Dev-only verification hook: optionally navigate, then write a
    // screenshot locally and exit. Used by the smoke tooling.
    if (process.env.STEPFORGE_SCREENSHOT) {
      const target = process.env.STEPFORGE_SCREENSHOT;
      const navigate = process.env.STEPFORGE_SCREENSHOT_JS || '';
      setTimeout(async () => {
        try {
          if (navigate) {
            await mainWindow.webContents.executeJavaScript(navigate, true);
            await new Promise((r) => setTimeout(r, 900));
          }
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(target, image.toPNG());
        } catch (err) {
          console.error('screenshot failed:', err.message);
        } finally {
          app.quit();
        }
      }, 1500);
    }
    // Dev-only self-test: exercise the exact hotkey-session capture path
    // (hide window -> grab -> showInactive) several times, then exit.
    if (process.env.STEPFORGE_CAPTURE_SELFTEST) {
      setTimeout(async () => {
        try {
          const guide = store.createGuide({ title: 'hotkey selftest' });
          capture.startSession(guide.guideId, { intervalSec: 0 });
          // Sessions start paused until "Start recording" is pressed; do
          // that here instead of waiting out the toast-grace delay, and
          // hide the window immediately rather than after the 400ms pause.
          capture.togglePause(false);
          mainWindow.hide();
          await new Promise((res) => setTimeout(res, 400));
          const results = [];
          for (let i = 0; i < 3; i++) {
            const r = await capture.hotkeyCapture();
            results.push(r.ok ? 'OK' : `FAIL:${r.reason}`);
            await new Promise((res) => setTimeout(res, 500));
          }
          console.log('HOTKEY-SELFTEST', JSON.stringify(results),
            'steps:', store.getGuide(guide.guideId).stepsOrder.length);

          // Interval auto-capture: 1s timer should add ~3 steps in 3.6s.
          const guide2 = store.createGuide({ title: 'interval selftest' });
          capture.startSession(guide2.guideId, { intervalSec: 1 });
          capture.togglePause(false);
          await new Promise((res) => setTimeout(res, 3600));
          capture.finishSession();
          console.log('INTERVAL-SELFTEST steps:', store.getGuide(guide2.guideId).stepsOrder.length);
        } catch (err) {
          console.log('SELFTEST ERROR', err.message);
        } finally {
          app.quit();
        }
      }, 1500);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const accel = settings.get('capture.hotkeyCapture');
  const pauseAccel = settings.get('capture.hotkeyPauseResume');
  try {
    if (accel) {
      globalShortcut.register(accel, () => {
        capture.hotkeyCapture().catch(() => {});
      });
    }
    if (pauseAccel) {
      globalShortcut.register(pauseAccel, () => {
        capture.togglePause();
        sendToRenderer('capture:state', capture.state());
      });
    }
  } catch {
    // invalid accelerator strings must not crash the app
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- IPC ------------------------------------------------------------------

function setupIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, async (event, args = {}) => fn(args));

  // library
  h('library:list', () => ({
    guides: store.listGuides().map((g) => ({
      ...g,
      stepCount: g.stepsOrder.length,
      locked: g.linkedSource ? Boolean(readLock(g.linkedSource.path)) : false,
    })),
    folders: store.loadFolders(),
  }));
  h('library:create', ({ title }) => {
    const guide = store.createGuide({
      title: title || 'Untitled guide',
      flags: { focusedViewDefault: Boolean(settings.get('editor.focusedViewDefaultForNewSteps')) },
    });
    reindex(guide.guideId);
    return guide;
  });
  h('library:duplicate', ({ guideId }) => {
    const copy = store.duplicateGuide(guideId);
    reindex(copy.guideId);
    return copy;
  });
  h('library:delete', ({ guideId }) => {
    store.deleteGuide(guideId);
    searchIndex.removeGuide(guideId);
    return true;
  });
  h('library:setFavorite', ({ guideId, favorite }) => store.setFavorite(guideId, favorite));
  h('library:trash:list', () => store.listTrash());
  h('library:trash:restore', ({ name }) => {
    const id = store.restoreFromTrash(name);
    reindex(id);
    return id;
  });
  h('library:trash:purge', ({ names } = {}) => {
    if (names && names.length) store.purgeTrashItems(names);
    else store.purgeTrash();
    return true;
  });
  h('folders:create', ({ name, parentId }) => store.createFolder(name, parentId || null));
  h('folders:rename', ({ folderId, name }) => store.renameFolder(folderId, name));
  h('folders:delete', ({ folderId }) => store.deleteFolder(folderId));
  h('folders:moveGuide', ({ guideId, folderId }) => store.moveGuideToFolder(guideId, folderId || null));

  // guide + steps
  h('guide:get', ({ guideId }) => ({
    guide: store.getGuide(guideId),
    steps: orderedSteps(guideId),
  }));
  h('guide:save', ({ guide }) => {
    const saved = store.saveGuide(guide);
    reindex(guide.guideId);
    return saved;
  });
  h('step:add', ({ guideId, fields, imageBase64, size, position }) => {
    const buf = imageBase64 ? Buffer.from(imageBase64, 'base64') : null;
    const step = store.addStep(guideId, fields || {}, buf, size || null, { position });
    reindex(guideId);
    return step;
  });
  h('step:save', ({ guideId, step }) => {
    const saved = store.saveStep(guideId, step);
    reindex(guideId);
    return saved;
  });
  h('step:delete', ({ guideId, stepId }) => {
    store.deleteStep(guideId, stepId);
    reindex(guideId);
    return true;
  });
  h('steps:reorder', ({ guideId, order }) => store.reorderSteps(guideId, order));
  h('step:imagePath', ({ guideId, stepId, which }) => {
    const p = store.stepImagePath(guideId, stepId, which || 'working');
    return p && fs.existsSync(p) ? `file://${p}?v=${fs.statSync(p).mtimeMs}` : null;
  });
  h('step:setWorkingImage', ({ guideId, stepId, pngBase64, size }) =>
    store.setWorkingImage(guideId, stepId, Buffer.from(pngBase64, 'base64'), size));
  h('step:resetWorkingImage', ({ guideId, stepId }) => {
    const p = store.stepImagePath(guideId, stepId, 'original');
    const img = nativeImage.createFromPath(p);
    const { width, height } = img.getSize();
    return store.resetWorkingImage(guideId, stepId, { width, height });
  });
  h('step:fromClipboard', ({ guideId, position }) => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false, reason: 'clipboard has no image' };
    const { width, height } = img.getSize();
    const step = store.addStep(guideId, {
      title: 'Pasted image',
      focusedView: { enabled: false, zoom: 1, panX: 0.5, panY: 0.5 },
    }, img.toPNG(), { width, height }, { position });
    reindex(guideId);
    return { ok: true, step };
  });
  h('step:importImage', async ({ guideId }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import images as steps',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return { ok: false };
    const steps = [];
    for (const file of res.filePaths) {
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) continue;
      const { width, height } = img.getSize();
      steps.push(store.addStep(guideId, { title: path.basename(file, path.extname(file)) },
        img.toPNG(), { width, height }));
    }
    reindex(guideId);
    return { ok: true, steps };
  });

  // search
  h('search:query', ({ q, guideId }) => searchIndex.search(q, { guideId: guideId || null }));
  h('search:titles', ({ q }) => searchIndex.searchTitles(q));

  // settings + placeholders
  h('settings:all', () => settings.data);
  h('settings:set', ({ keyPath, value }) => {
    settings.set(keyPath, value);
    if (keyPath === 'appearance') applyTheme();
    if (keyPath.startsWith('capture.hotkey')) registerHotkeys();
    return settings.data;
  });
  h('placeholders:globals:get', () => settings.getGlobalPlaceholders());
  h('placeholders:globals:set', ({ values }) => settings.setGlobalPlaceholders(values));

  // capture
  h('capture:shoot', async ({ guideId, mode, delayMs }) => {
    const result = await capture.shoot({ guideId, mode, delayMs });
    if (result.ok) reindex(guideId);
    return result;
  });
  h('capture:region', async ({ guideId }) => {
    const result = await capture.regionCapture(guideId);
    if (result.ok) reindex(guideId);
    return result;
  });
  h('capture:session', async ({ action, guideId, intervalSec }) => {
    if (action === 'start') capture.startSession(guideId, { intervalSec: intervalSec ?? null });
    else if (action === 'pause') capture.togglePause(true);
    else if (action === 'resume') capture.togglePause(false);
    else if (action === 'finish') capture.finishSession();
    else if (action === 'interval') capture.setInterval(intervalSec);
    else if (action === 'shoot') await capture.sessionCapture('manual');
    const state = capture.state();
    sendToRenderer('capture:state', state);
    return state;
  });
  h('capture:state', () => capture.state());

  // archives & linked guides
  h('archive:export', async ({ guideId }) => {
    const guide = store.getGuide(guideId);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Share guide as file',
      defaultPath: `${guide.title.replace(/[/\\:]+/g, '-')}.sfgz`,
      filters: [{ name: 'StepForge guide archive', extensions: ['sfgz'] }],
    });
    if (res.canceled) return { ok: false };
    exportGuideArchive(store, guideId, res.filePath);
    return { ok: true, path: res.filePath };
  });
  h('archive:open', async ({ mode }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open guide archive',
      filters: [{ name: 'StepForge guide archive', extensions: ['sfgz'] }],
      properties: ['openFile'],
    });
    if (res.canceled) return { ok: false };
    try {
      const guide = importGuideArchive(store, res.filePaths[0], { mode: mode || 'copy' });
      reindex(guide.guideId);
      return { ok: true, guide };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  h('archive:peek', ({ file }) => {
    const { manifest } = readArchive(file);
    return manifest;
  });
  h('archive:saveLinked', ({ guideId, force }) => saveLinkedGuide(store, guideId, { force: Boolean(force) }));

  // snapshots
  h('snapshots:list', ({ guideId }) => listSnapshots(store, guideId));
  h('snapshots:create', ({ guideId, label }) =>
    createSnapshot(store, guideId, { label: label || 'manual', keepLast: settings.get('backups.keepLast') }));
  h('snapshots:restore', ({ guideId, name }) => {
    const guide = restoreSnapshot(store, guideId, name);
    reindex(guideId);
    return guide;
  });

  // templates
  h('templates:list', ({ format }) => templates.list(format));
  h('templates:load', ({ format, name }) => templates.load(format, name));
  h('templates:save', ({ format, name, options }) => templates.save(format, name, options));
  h('templates:delete', ({ format, name }) => templates.remove(format, name));
  h('templates:rename', ({ format, name, newName }) => templates.rename(format, name, newName));
  h('templates:duplicate', ({ format, name }) => templates.duplicate(format, name));
  h('templates:export', async ({ format, name }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${name}.sfglt`,
      filters: [{ name: 'StepForge template', extensions: ['sfglt'] }],
    });
    if (res.canceled) return { ok: false };
    templates.exportTemplate(format, name, res.filePath);
    return { ok: true };
  });
  h('templates:import', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'StepForge template', extensions: ['sfglt'] }],
      properties: ['openFile'],
    });
    if (res.canceled) return { ok: false };
    return { ok: true, ...templates.importTemplate(res.filePaths[0]) };
  });

  // export + preview
  h('export:formats', () => FORMATS.filter((f) => EXPORTERS[f]));
  h('export:defaults', ({ format }) => {
    // Exporter modules expose DEFAULT_TEMPLATE; the dialog renders editable
    // options from it (booleans -> checkbox, numbers -> number, strings -> text).
    const mod = {
      json: '../exporters/json',
      markdown: '../exporters/markdown',
      'html-simple': '../exporters/html',
      'html-rich': '../exporters/html',
      pdf: '../exporters/pdf',
      gif: '../exporters/gif',
      'image-bundle': '../exporters/image-bundle',
      docx: '../exporters/docx',
      pptx: '../exporters/pptx',
    }[format];
    if (!mod) return {};
    return { ...require(mod).DEFAULT_TEMPLATE };
  });
  h('export:run', async ({ guideId, format, options, outDir }) => {
    let dir = outDir || settings.get(`exports.lastOutputDirs.${format}`);
    if (!dir) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled) return { ok: false };
      dir = res.filePaths[0];
    }
    settings.set(`exports.lastOutputDirs.${format}`, dir);
    const ast = buildRenderAst(store, guideId, { globals: settings.getGlobalPlaceholders() });
    const result = runExport(format, ast, dir, options || {});
    if (settings.get('exports.openFolderAfterExport')) shell.showItemInFolder(result.file);
    return { ok: true, ...result };
  });
  h('export:chooseDir', async ({ format }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled) return null;
    settings.set(`exports.lastOutputDirs.${format}`, res.filePaths[0]);
    return res.filePaths[0];
  });
  h('export:preview', ({ guideId, format, options }) => {
    const previewDir = path.join(store.tempDir, `preview-${guideId}-${format}`);
    fs.rmSync(previewDir, { recursive: true, force: true });
    const ast = buildRenderAst(store, guideId, {
      globals: settings.getGlobalPlaceholders(),
      maxSteps: settings.get('exports.previewStepCount') || 3,
    });
    const result = runExport(format, ast, previewDir, options || {});
    return { ok: true, file: result.file, fileUrl: `file://${result.file}` };
  });
  h('preview:cleanup', () => {
    for (const entry of fs.readdirSync(store.tempDir)) {
      if (entry.startsWith('preview-')) {
        fs.rmSync(path.join(store.tempDir, entry), { recursive: true, force: true });
      }
    }
    return true;
  });

  // shell helpers
  h('shell:openPath', ({ target }) => shell.openPath(target));
  h('shell:showItemInFolder', ({ target }) => shell.showItemInFolder(target));
  h('app:info', () => ({
    version: app.getVersion(),
    dataDir: store.root,
    platform: process.platform,
  }));
}

// ---- lifecycle --------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const dataDir = resolveDataDir();
    store = new GuideStore(dataDir);
    settings = new Settings(store.settingsDir);
    searchIndex = new SearchIndex(store.indexDir);
    templates = new TemplateManager(store.templatesDir);
    capture = new CaptureService({
      store,
      settings,
      getWindow: () => mainWindow,
      notify: sendToRenderer,
    });

    applyTheme();
    setupIpc();
    createWindow();
    registerHotkeys();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (capture) {
      // Targeted cleanup (not finishSession — that re-shows the window).
      capture.stopClickWatcher();
      capture.destroySessionTray();
    }
    // clean preview temp files on close
    try {
      for (const entry of fs.readdirSync(store.tempDir)) {
        fs.rmSync(path.join(store.tempDir, entry), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
