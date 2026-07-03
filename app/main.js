'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, globalShortcut,
  clipboard, nativeImage, screen, powerSaveBlocker, session, desktopCapturer,
} = require('electron');

const { GuideStore } = require('../core/store');
const { Settings } = require('../core/settings');
const { SearchIndex } = require('../core/search');
const { TemplateManager, FORMATS, FORMAT_LABELS } = require('../core/templates');
const { buildRenderAst } = require('../core/renderast');
const { runExport, EXPORTERS } = require('../exporters');
const { runExportInWorker } = require('./export-runner');
const { exportGuideArchive, importGuideArchive, saveLinkedGuide } = require('../core/archive');
const { createSnapshot, listSnapshots, restoreSnapshot } = require('../core/snapshots');
const { readLock } = require('../core/locks');
const CaptureService = require('./capture');
const { TextIntelService } = require('./text-intel');
const { keepProcessesResponsive } = require('./win-power');
const security = require('./security');
const PACKAGE_JSON = require(path.join(__dirname, '..', 'package.json'));

const APP_ID = 'com.stepforge.app';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

// Keep capture working on battery. In a power-saving plan on DC power, Windows
// applies Power Throttling (EcoQoS) to background work — and StepForge records
// with its window hidden, so the frame-capture worker renderer is exactly the
// kind of "background" process the OS slows down. A throttled worker can't
// sample the screen fast enough, so every click finds no fresh frame and the
// recording falls apart (the bug only ever reproduced on battery). These
// switches stop Chromium from de-prioritising and timer-throttling the hidden
// worker; win-power.js additionally opts the OS processes out of EcoQoS.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
let textIntel;
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
      sandbox: true,
      spellcheck: Boolean(settings.get('spellcheck')),
      // During a recording the window is minimized (Linux) or hidden (Windows).
      // A throttled renderer stops processing capture:added events, so the step
      // list and capture bar appear "stuck" even though steps are saved. Keep
      // the renderer live so the UI updates in real time while recording.
      backgroundThrottling: false,
    },
  });
  // The main window may only ever display our index.html: all navigation
  // away from it and every popup is denied, so no other document can run
  // with this window's preload bridge.
  security.installWindowSecurity(mainWindow, 'main');
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
    // Dev-only self-test: exercise the full click-capture pipeline — resume
    // session, wait for the frame recorder, inject OS-level clicks the way
    // the watcher would, and verify one stored step per click.
    if (process.env.STEPFORGE_CLICK_SELFTEST) {
      setTimeout(async () => {
        try {
          // The marker/drain scenarios inject clicks faster than the default
          // debounce to stress the frame pipeline; turn the debounce off for
          // them so every injected click is captured. A dedicated scenario
          // at the end re-enables it and verifies the debounce itself.
          settings.set('capture.clickDebounceMs', 0);
          const guide = store.createGuide({ title: 'click selftest' });
          capture.startSession(guide.guideId, { intervalSec: 0 });
          // Isolate the test from the user's real mouse: the session starts
          // the live OS click watcher, and a stray real click (dismissing
          // the toast, focusing the terminal) would add an extra step and
          // shift every marker comparison below.
          capture.stopClickWatcher();
          capture.togglePause(false);
          mainWindow.hide();
          // Arm the frame recorder directly: this host may lack the click
          // watcher binary (xinput), which normally gates the recorder, but
          // the recorder itself must still be testable end to end.
          await capture.startClickFrameBackend();
          // Let the stream backend (or the fallback loop) come up and buffer.
          await new Promise((res) => setTimeout(res, 3000));
          console.log('CLICK-SELFTEST source:', capture.state().clickFrameSource);
          // Targets are chosen in DIP; the OS hook reports *physical* pixels,
          // so convert before injecting (identity on unscaled displays).
          const { bounds } = screen.getPrimaryDisplay();
          const dipTargets = [
            { x: Math.round(bounds.x + bounds.width * 0.2), y: Math.round(bounds.y + bounds.height * 0.2) },
            { x: Math.round(bounds.x + bounds.width * 0.5), y: Math.round(bounds.y + bounds.height * 0.5) },
            { x: Math.round(bounds.x + bounds.width * 0.8), y: Math.round(bounds.y + bounds.height * 0.8) },
          ];
          const toPhysical = (p) => (typeof screen.dipToScreenPoint === 'function'
            ? screen.dipToScreenPoint(p)
            : p);
          for (const point of dipTargets) {
            capture.onOsClick(Date.now(), toPhysical(point), 'button-1');
            await new Promise((res) => setTimeout(res, 120)); // fast clicking
          }
          // Wait for the queue to drain (encodes can take seconds on WSLg).
          await capture.clickQueue;
          await new Promise((res) => setTimeout(res, 500));
          const stepIds = store.getGuide(guide.guideId).stepsOrder;
          const steps = store.listSteps(guide.guideId);
          const markers = stepIds.map((id) => (steps.get(id).annotations || []).length);
          console.log('CLICK-SELFTEST steps:', stepIds.length, 'of', dipTargets.length,
            'markers:', JSON.stringify(markers));
          if (stepIds.length !== dipTargets.length) {
            console.log('CLICK-SELFTEST step count mismatch — marker offsets below are unreliable');
          }
          // Marker accuracy: each oval's center (fractional) must match the
          // injected click position relative to the display bounds.
          stepIds.forEach((id, i) => {
            const a = (steps.get(id).annotations || [])[0];
            const expectedClick = dipTargets[i];
            if (!a || !expectedClick) return;
            const center = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
            const expected = {
              x: (expectedClick.x - bounds.x) / bounds.width,
              y: (expectedClick.y - bounds.y) / bounds.height,
            };
            const offBy = Math.hypot(center.x - expected.x, center.y - expected.y);
            console.log(`CLICK-SELFTEST marker ${i}: off by ${(offBy * 100).toFixed(2)}% of screen`);
          });
          capture.finishSession();

          // Second scenario, reproducing the "I clicked many times but only
          // got two screenshots" report: a fast burst of clicks immediately
          // followed by finishing the session, so most clicks are still
          // queued (frames still encoding) when the stop lands. This scenario
          // tests the queue DRAIN, not strict timing — 30ms-apart clicks
          // outpace the frame sampler, so run it in balanced mode where every
          // queued click stores. (Strict-mode skip-vs-store is covered by the
          // marker scenario above and by unit tests.)
          settings.set('capture.strictClickFrames', false);
          const burstGuide = store.createGuide({ title: 'burst selftest' });
          capture.startSession(burstGuide.guideId, { intervalSec: 0 });
          capture.stopClickWatcher();
          capture.togglePause(false);
          mainWindow.hide();
          await capture.startClickFrameBackend();
          await new Promise((res) => setTimeout(res, 1500));
          const burstCount = 8;
          for (let i = 0; i < burstCount; i++) {
            const p = {
              x: Math.round(bounds.x + bounds.width * (0.15 + 0.08 * i)),
              y: Math.round(bounds.y + bounds.height * 0.5),
            };
            capture.onOsClick(Date.now(), toPhysical(p), 'button-1');
            await new Promise((res) => setTimeout(res, 30)); // very fast clicking
          }
          // Finish right away — clicks are still mid-encode in the queue.
          capture.finishSession();
          await capture.clickQueue;
          await new Promise((res) => setTimeout(res, 1000));
          const burstSteps = store.getGuide(burstGuide.guideId).stepsOrder.length;
          console.log('CLICK-SELFTEST burst:', burstSteps, 'of', burstCount,
            burstSteps === burstCount ? 'OK — no clicks dropped on finish' : 'FAIL — clicks lost');
          settings.set('capture.strictClickFrames', true); // restore for later scenarios

          // Helper: wait until armRecording has finished warming (window
          // hidden, buffer primed) so an injected click counts as a real
          // recording click rather than being ignored as a warmup click.
          const waitArmed = async () => {
            for (let i = 0; i < 80 && capture.warmingUp; i++) {
              await new Promise((res) => setTimeout(res, 50));
            }
          };

          // Third scenario: the real "Start recording" path. armRecording
          // warms the recorder while the window is visible and only arms the
          // session once it hides; the first click *after* arming must get a
          // pre-click frame (not the post-click shot that made "the first
          // screenshot late"), and a click *during* warmup must be ignored,
          // not mishandled. (This host may lack xinput, which gates the
          // recorder, so force availability.)
          const armGuide = store.createGuide({ title: 'arm selftest' });
          mainWindow.show();
          await new Promise((res) => setTimeout(res, 300));
          capture.startSession(armGuide.guideId, { intervalSec: 0 });
          capture.stopClickWatcher();
          capture.clickCaptureAvailable = () => true;
          capture.hiddenForSession = true; // window was visible at session start
          capture.togglePause(false); // armRecording: warm → hide → arm
          // A click during warmup must be ignored (window still visible).
          await new Promise((res) => setTimeout(res, 200));
          const warmupClicks = store.getGuide(armGuide.guideId).stepsOrder.length;
          capture.onOsClick(Date.now(), toPhysical({ x: bounds.x + 100, y: bounds.y + 100 }), 'button-1');
          await waitArmed();
          const armPoint = {
            x: Math.round(bounds.x + bounds.width * 0.4),
            y: Math.round(bounds.y + bounds.height * 0.4),
          };
          capture.onOsClick(Date.now(), toPhysical(armPoint), 'button-1');
          await capture.clickQueue;
          await new Promise((res) => setTimeout(res, 800));
          const armSteps = store.getGuide(armGuide.guideId).stepsOrder.length;
          console.log('CLICK-SELFTEST arm: warmup-click steps', warmupClicks,
            '-> after-arm steps', armSteps,
            armSteps === 1 ? 'OK — warmup click ignored, first armed click captured' : 'FAIL');
          capture.finishSession();

          // Fourth scenario: the debounce itself, exercised end to end through
          // onOsClick. A fast burst (40ms apart) must collapse to one step,
          // and deliberate clicks (300ms apart) must each register.
          settings.set('capture.clickDebounceMs', 200);
          const dbGuide = store.createGuide({ title: 'debounce selftest' });
          mainWindow.show();
          await new Promise((res) => setTimeout(res, 200));
          capture.startSession(dbGuide.guideId, { intervalSec: 0 });
          capture.stopClickWatcher();
          capture.clickCaptureAvailable = () => true;
          capture.hiddenForSession = true;
          capture.togglePause(false);
          await capture.startClickFrameBackend();
          await waitArmed();
          await new Promise((res) => setTimeout(res, 300));
          const dbPoint = {
            x: Math.round(bounds.x + bounds.width * 0.55),
            y: Math.round(bounds.y + bounds.height * 0.55),
          };
          // 4 clicks 40ms apart — accidental fast clicking → expect 1 step.
          for (let i = 0; i < 4; i++) {
            capture.onOsClick(Date.now(), toPhysical(dbPoint), 'button-1');
            await new Promise((res) => setTimeout(res, 40));
          }
          // 3 deliberate clicks 300ms apart → expect 3 more steps.
          for (let i = 0; i < 3; i++) {
            await new Promise((res) => setTimeout(res, 300));
            capture.onOsClick(Date.now(), toPhysical(dbPoint), 'button-1');
          }
          await capture.clickQueue;
          await new Promise((res) => setTimeout(res, 800));
          const dbSteps = store.getGuide(dbGuide.guideId).stepsOrder.length;
          console.log('CLICK-SELFTEST debounce:', dbSteps, 'of 4 expected',
            dbSteps === 4 ? 'OK — burst collapsed to 1, three deliberate clicks kept' : 'FAIL');
          capture.finishSession();
        } catch (err) {
          console.log('CLICK-SELFTEST ERROR', err.message);
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
  // Every invoke channel is guarded: the event must come from the current
  // main window's top frame showing our index.html, the argument bag must be
  // a plain object within a per-channel payload budget, and channels with
  // risky inputs additionally validate fields before the handler runs.
  const trustedSender = security.makeIpcSenderGuard({
    getMainWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  });
  const c = security.check;
  const IMAGE_BUDGET = 256 * 1024 * 1024; // channels that carry base64 PNGs
  const h = (channel, fn, opts = {}) => {
    const { maxChars = 2 * 1024 * 1024, validate = null } = opts;
    ipcMain.handle(channel, async (event, args = {}) => {
      if (!trustedSender(event)) {
        throw new Error(`${channel}: rejected — untrusted IPC sender`);
      }
      const a = args === undefined || args === null ? {} : args;
      if (!security.isPlainArgs(a) || !security.payloadWithinBudget(a, maxChars)) {
        throw new Error(`${channel}: rejected — invalid or oversized arguments`);
      }
      if (validate && !validate(a)) {
        throw new Error(`${channel}: rejected — arguments failed validation`);
      }
      return fn(a);
    });
  };

  // Files the main process itself produced (exports, previews); only these
  // may be re-opened via the shell on renderer request.
  const producedFiles = new security.ProducedFiles();
  // Output directories the user actually picked in a dialog this session.
  const chosenOutputDirs = new Set();

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
  }, { validate: (a) => c.optionalString(a.title, 500) });
  h('library:duplicate', ({ guideId }) => {
    const copy = store.duplicateGuide(guideId);
    reindex(copy.guideId);
    return copy;
  }, { validate: (a) => c.id(a.guideId) });
  h('library:delete', ({ guideId }) => {
    store.deleteGuide(guideId);
    searchIndex.removeGuide(guideId);
    return true;
  }, { validate: (a) => c.id(a.guideId) });
  h('library:setFavorite', ({ guideId, favorite }) => store.setFavorite(guideId, favorite),
    { validate: (a) => c.id(a.guideId) });
  h('library:trash:list', () => store.listTrash());
  h('library:trash:restore', ({ name }) => {
    const id = store.restoreFromTrash(name);
    reindex(id);
    return id;
  }, { validate: (a) => c.fileName(a.name) });
  h('library:trash:purge', ({ names } = {}) => {
    if (names && names.length) store.purgeTrashItems(names);
    else store.purgeTrash();
    return true;
  }, {
    validate: (a) => a.names === undefined || a.names === null
      || (Array.isArray(a.names) && a.names.length <= 1000 && a.names.every((n) => c.fileName(n))),
  });
  h('folders:create', ({ name, parentId }) => store.createFolder(name, parentId || null),
    { validate: (a) => c.string(a.name, 200) && c.optionalId(a.parentId) });
  h('folders:rename', ({ folderId, name }) => store.renameFolder(folderId, name),
    { validate: (a) => c.id(a.folderId) && c.string(a.name, 200) });
  h('folders:delete', ({ folderId }) => store.deleteFolder(folderId),
    { validate: (a) => c.id(a.folderId) });
  h('folders:moveGuide', ({ guideId, folderId }) => store.moveGuideToFolder(guideId, folderId || null),
    { validate: (a) => c.id(a.guideId) && c.optionalId(a.folderId) });

  // guide + steps
  h('guide:get', ({ guideId }) => ({
    guide: store.getGuide(guideId),
    steps: orderedSteps(guideId),
  }), { validate: (a) => c.id(a.guideId) });
  h('guide:save', ({ guide }) => {
    const saved = store.saveGuide(guide);
    reindex(guide.guideId);
    return saved;
  }, { validate: (a) => security.isPlainArgs(a.guide) && a.guide && c.id(a.guide.guideId) });
  h('step:add', ({ guideId, fields, imageBase64, size, position }) => {
    const buf = imageBase64 ? Buffer.from(imageBase64, 'base64') : null;
    const step = store.addStep(guideId, fields || {}, buf, size || null, { position });
    reindex(guideId);
    return step;
  }, {
    maxChars: IMAGE_BUDGET,
    validate: (a) => c.id(a.guideId) && c.optionalBase64(a.imageBase64) && c.optionalNumber(a.position, 0, 100000),
  });
  h('step:save', ({ guideId, step }) => {
    const saved = store.saveStep(guideId, step);
    reindex(guideId);
    return saved;
  }, { validate: (a) => c.id(a.guideId) && security.isPlainArgs(a.step) && a.step && c.id(a.step.stepId) });
  h('step:delete', ({ guideId, stepId }) => {
    store.deleteStep(guideId, stepId);
    reindex(guideId);
    return true;
  }, { validate: (a) => c.id(a.guideId) && c.id(a.stepId) });
  h('step:restore', ({ guideId, step, originalBase64, workingBase64, position }) => {
    const images = {
      original: originalBase64 ? Buffer.from(originalBase64, 'base64') : null,
      working: workingBase64 ? Buffer.from(workingBase64, 'base64') : null,
    };
    const restored = store.restoreStep(guideId, step, images, position);
    reindex(guideId);
    return restored;
  }, {
    maxChars: IMAGE_BUDGET,
    validate: (a) => c.id(a.guideId) && security.isPlainArgs(a.step) && a.step
      && c.optionalBase64(a.originalBase64) && c.optionalBase64(a.workingBase64)
      && c.optionalNumber(a.position, 0, 100000),
  });
  h('steps:reorder', ({ guideId, order }) => store.reorderSteps(guideId, order), {
    validate: (a) => c.id(a.guideId)
      && Array.isArray(a.order) && a.order.length <= 100000 && a.order.every((id) => c.id(id)),
  });
  h('step:imagePath', ({ guideId, stepId, which }) => {
    const p = store.stepImagePath(guideId, stepId, which || 'working');
    if (!p || !fs.existsSync(p)) return null;
    // pathToFileURL correctly encodes spaces, #, %, drive letters, etc.; the
    // mtime is a cache-buster so the renderer reloads after an edit.
    const url = pathToFileURL(p);
    url.searchParams.set('v', String(fs.statSync(p).mtimeMs));
    return url.href;
  }, {
    validate: (a) => c.id(a.guideId) && c.id(a.stepId)
      && (a.which === undefined || a.which === null || c.oneOf(a.which, ['original', 'working'])),
  });
  h('step:setWorkingImage', ({ guideId, stepId, pngBase64, size, step }) =>
    store.setWorkingImage(guideId, stepId, Buffer.from(pngBase64, 'base64'), size, step || null), {
    maxChars: IMAGE_BUDGET,
    validate: (a) => c.id(a.guideId) && c.id(a.stepId) && c.base64(a.pngBase64),
  });
  h('step:resetWorkingImage', ({ guideId, stepId }) => {
    const p = store.stepImagePath(guideId, stepId, 'original');
    const img = nativeImage.createFromPath(p);
    const { width, height } = img.getSize();
    return store.resetWorkingImage(guideId, stepId, { width, height });
  }, { validate: (a) => c.id(a.guideId) && c.id(a.stepId) });
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
  }, { validate: (a) => c.id(a.guideId) && c.optionalNumber(a.position, 0, 100000) });
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
  }, { validate: (a) => c.id(a.guideId) });

  // search
  h('search:query', ({ q, guideId }) => searchIndex.search(q, { guideId: guideId || null }),
    { validate: (a) => c.optionalString(a.q, 1000) && c.optionalId(a.guideId) });
  h('search:titles', ({ q }) => searchIndex.searchTitles(q),
    { validate: (a) => c.optionalString(a.q, 1000) });

  // settings + placeholders
  h('settings:all', () => settings.data);
  h('settings:set', ({ keyPath, value }) => {
    settings.set(keyPath, value);
    if (keyPath === 'appearance') applyTheme();
    if (keyPath.startsWith('capture.hotkey')) registerHotkeys();
    return settings.data;
  }, { validate: (a) => c.settingsKeyPath(a.keyPath) });
  h('ai:test', async ({ enabled = null, ollama = null } = {}) => {
    return textIntel.testAiConnection({
      enabled,
      ollama,
    });
  }, { validate: (a) => (a.ollama === undefined || a.ollama === null || security.isPlainArgs(a.ollama)) });
  h('ai:fillStep', async ({ guideId, stepId, target = 'all', blockId = null } = {}) => {
    const result = await textIntel.generateStepPatch({
      guideId,
      stepId,
      target,
      blockId,
    });
    if (result.ok) reindex(guideId);
    return result;
  }, {
    validate: (a) => c.id(a.guideId) && c.id(a.stepId) && c.optionalId(a.blockId)
      && (a.target === undefined || c.oneOf(a.target, ['all', 'title', 'description', 'block'])),
  });
  h('ai:rewriteText', async ({ text, guideTitle = '', stepTitle = '' } = {}) => {
    return textIntel.rewriteText({ text, guideTitle, stepTitle });
  }, {
    validate: (a) => c.string(a.text, 200000)
      && c.optionalString(a.guideTitle, 1000) && c.optionalString(a.stepTitle, 1000),
  });
  // Cancel outstanding AI requests, e.g. when a guide/editor closes, so a
  // slow response can't resolve against data the user has moved on from.
  h('ai:cancel', ({ guideId = null } = {}) => {
    textIntel.cancelInflight(guideId || null);
    return true;
  }, { validate: (a) => c.optionalId(a.guideId) });
  h('placeholders:globals:get', () => settings.getGlobalPlaceholders());
  h('placeholders:globals:set', (values) => settings.setGlobalPlaceholders(values));

  // capture
  h('capture:shoot', async ({ guideId, mode, delayMs }) => {
    const result = await capture.shoot({ guideId, mode, delayMs });
    if (result.ok) {
      reindex(guideId);
      const aiConf = settings.get('ai') || {};
      if (aiConf.enabled && aiConf.autoDoc && result.step) {
        const aiResult = await textIntel.generateStepPatch({
          guideId,
          stepId: result.step.stepId,
          target: 'all',
        }).catch(() => null);
        if (aiResult?.ok) {
          reindex(guideId);
          result.step = aiResult.step;
        }
      }
    }
    return result;
  }, {
    validate: (a) => c.id(a.guideId)
      && (a.mode === undefined || c.oneOf(a.mode, ['fullscreen', 'window', 'region']))
      && c.optionalNumber(a.delayMs, 0, 600000),
  });
  h('capture:region', async ({ guideId }) => {
    const result = await capture.regionCapture(guideId);
    if (result.ok) {
      reindex(guideId);
      const aiConf = settings.get('ai') || {};
      if (aiConf.enabled && aiConf.autoDoc && result.step) {
        const aiResult = await textIntel.generateStepPatch({
          guideId,
          stepId: result.step.stepId,
          target: 'all',
        }).catch(() => null);
        if (aiResult?.ok) {
          reindex(guideId);
          result.step = aiResult.step;
        }
      }
    }
    return result;
  }, { validate: (a) => c.id(a.guideId) });

  // Power/throttling state is owned entirely by the capture service's
  // recording transitions (see createCapturePowerPolicy) so there is exactly
  // one owner: it is held iff a session is actively recording, and paused,
  // finished, tray, and second-instance transitions all release it correctly.
  h('capture:session', async ({ action, guideId, intervalSec }) => {
    if (action === 'start') {
      capture.startSession(guideId, { intervalSec: intervalSec ?? null });
    } else if (action === 'pause') {
      capture.togglePause(true);
    } else if (action === 'resume') {
      capture.togglePause(false);
    } else if (action === 'finish') {
      capture.finishSession();
    } else if (action === 'interval') {
      capture.setInterval(intervalSec);
    }
    const state = capture.state();
    sendToRenderer('capture:state', state);
    return state;
  }, {
    validate: (a) => c.oneOf(a.action, ['start', 'pause', 'resume', 'finish', 'interval'])
      && (a.action !== 'start' || c.id(a.guideId))
      && c.optionalNumber(a.intervalSec, 0, 86400),
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
  }, { validate: (a) => c.id(a.guideId) });
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
  }, { validate: (a) => a.mode === undefined || c.oneOf(a.mode, ['copy', 'linked']) });
  // archive:peek was removed: nothing in the renderer used it, and it let a
  // compromised renderer read arbitrary local archives by path.
  h('archive:saveLinked', ({ guideId, force }) => saveLinkedGuide(store, guideId, { force: Boolean(force) }),
    { validate: (a) => c.id(a.guideId) });

  // snapshots
  h('snapshots:list', ({ guideId }) => listSnapshots(store, guideId),
    { validate: (a) => c.id(a.guideId) });
  h('snapshots:create', ({ guideId, label }) =>
    createSnapshot(store, guideId, { label: label || 'manual', keepLast: settings.get('backups.keepLast') }),
  { validate: (a) => c.id(a.guideId) && c.optionalString(a.label, 200) });
  h('snapshots:restore', ({ guideId, name }) => {
    const guide = restoreSnapshot(store, guideId, name);
    reindex(guideId);
    return guide;
  }, { validate: (a) => c.id(a.guideId) && c.fileName(a.name) });

  // templates
  const validFormat = (v) => c.oneOf(v, FORMATS);
  h('templates:list', ({ format }) => templates.list(format),
    { validate: (a) => validFormat(a.format) });
  h('templates:load', ({ format, name }) => templates.load(format, name),
    { validate: (a) => validFormat(a.format) && c.fileName(a.name) });
  h('templates:save', ({ format, name, options }) => templates.save(format, name, options),
    { validate: (a) => validFormat(a.format) && c.fileName(a.name) && security.isPlainArgs(a.options) });
  h('templates:delete', ({ format, name }) => templates.remove(format, name),
    { validate: (a) => validFormat(a.format) && c.fileName(a.name) });
  h('templates:rename', ({ format, name, newName }) => templates.rename(format, name, newName),
    { validate: (a) => validFormat(a.format) && c.fileName(a.name) && c.fileName(a.newName) });
  h('templates:duplicate', ({ format, name }) => templates.duplicate(format, name),
    { validate: (a) => validFormat(a.format) && c.fileName(a.name) });
  h('templates:export', async ({ format, name }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${name}.sfglt`,
      filters: [{ name: 'StepForge template', extensions: ['sfglt'] }],
    });
    if (res.canceled) return { ok: false };
    templates.exportTemplate(format, name, res.filePath);
    return { ok: true };
  }, { validate: (a) => validFormat(a.format) && c.fileName(a.name) });
  h('templates:import', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'StepForge template', extensions: ['sfglt'] }],
      properties: ['openFile'],
    });
    if (res.canceled) return { ok: false };
    return { ok: true, ...templates.importTemplate(res.filePaths[0]) };
  });

  // export + preview
  h('export:formats', () => FORMATS.filter((f) => EXPORTERS[f]).map((format) => ({
    id: format,
    label: FORMAT_LABELS[format] || format,
  })));
  h('export:defaults', ({ format }) => {
    // Exporter modules expose DEFAULT_TEMPLATE; the dialog renders editable
    // options from it (booleans -> checkbox, numbers -> number, strings -> text).
    const mod = {
      json: '../exporters/json',
      markdown: '../exporters/markdown',
      wikijs: '../exporters/wikijs',
      'html-simple': '../exporters/html',
      'html-rich': '../exporters/html',
      confluence: '../exporters/confluence',
      pdf: '../exporters/pdf',
      gif: '../exporters/gif',
      'image-bundle': '../exporters/image-bundle',
      docx: '../exporters/docx',
      pptx: '../exporters/pptx',
    }[format];
    if (!mod) return {};
    return { ...require(mod).DEFAULT_TEMPLATE };
  }, { validate: (a) => c.string(a.format, 40) });
  h('export:run', async ({ guideId, format, options, outDir }) => {
    // The renderer may only nominate directories that came from this main
    // process: a dialog pick from this session or a remembered last-output
    // directory. Anything else is ignored and re-asked via the dialog.
    const rememberedDirs = Object.values(settings.get('exports.lastOutputDirs') || {});
    let dir = null;
    if (outDir && (chosenOutputDirs.has(outDir) || rememberedDirs.includes(outDir))) {
      dir = outDir;
    }
    if (!dir) dir = settings.get(`exports.lastOutputDirs.${format}`);
    if (!dir) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled) return { ok: false };
      dir = res.filePaths[0];
      chosenOutputDirs.add(dir);
    }
    settings.set(`exports.lastOutputDirs.${format}`, dir);
    const result = await runExportInWorker({
      dataDir: store.root,
      guideId,
      format,
      options: options || {},
      outDir: dir,
      globals: settings.getGlobalPlaceholders(),
    });
    producedFiles.add(result.file);
    if (settings.get('exports.openFolderAfterExport')) shell.showItemInFolder(result.file);
    return { ok: true, ...result };
  }, {
    validate: (a) => c.id(a.guideId) && validFormat(a.format)
      && (a.options === undefined || security.isPlainArgs(a.options))
      && c.optionalString(a.outDir, 1000),
  });
  h('export:chooseDir', async ({ format }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled) return null;
    chosenOutputDirs.add(res.filePaths[0]);
    settings.set(`exports.lastOutputDirs.${format}`, res.filePaths[0]);
    return res.filePaths[0];
  }, { validate: (a) => validFormat(a.format) });
  h('export:preview', ({ guideId, format, options }) => {
    const previewDir = path.join(store.tempDir, `preview-${guideId}-${format}`);
    fs.rmSync(previewDir, { recursive: true, force: true });
    const ast = buildRenderAst(store, guideId, {
      globals: settings.getGlobalPlaceholders(),
      maxSteps: settings.get('exports.previewStepCount') || 3,
    });
    const result = runExport(format, ast, previewDir, options || {});
    producedFiles.add(result.file);
    return { ok: true, file: result.file, fileUrl: pathToFileURL(result.file).href };
  }, {
    validate: (a) => c.id(a.guideId) && validFormat(a.format)
      && (a.options === undefined || security.isPlainArgs(a.options)),
  });
  h('preview:cleanup', () => {
    for (const entry of fs.readdirSync(store.tempDir)) {
      if (entry.startsWith('preview-')) {
        fs.rmSync(path.join(store.tempDir, entry), { recursive: true, force: true });
      }
    }
    return true;
  });

  // shell helpers — intent-specific, no arbitrary paths from the renderer.
  // Only files this main process produced (exports/previews) may be opened.
  h('shell:openProduced', ({ target }) => {
    if (!producedFiles.has(target)) {
      return { ok: false, reason: 'not a StepForge-produced file' };
    }
    shell.openPath(target);
    return { ok: true };
  }, { validate: (a) => c.string(a.target, 2000) });
  // Reveal the linked archive of a guide; the path comes from the store,
  // never from the renderer.
  h('shell:revealLinkedArchive', ({ guideId }) => {
    const guide = store.getGuide(guideId);
    const target = guide && guide.linkedSource && guide.linkedSource.path;
    if (!target || !fs.existsSync(target)) return { ok: false, reason: 'no linked archive' };
    shell.showItemInFolder(target);
    return { ok: true };
  }, { validate: (a) => c.id(a.guideId) });
  // Open a user-clicked link in the system browser. Scheme-validated;
  // everything that is not plain http(s)/mailto is refused.
  h('shell:openExternal', ({ url }) => {
    const safe = security.validateExternalUrl(url);
    if (!safe) return { ok: false, reason: 'blocked URL' };
    shell.openExternal(safe);
    return { ok: true };
  }, { validate: (a) => c.string(a.url, 2048) });
  h('app:info', () => ({
    version: app.getVersion(),
    buildVersion: PACKAGE_JSON.buildVersion || app.getVersion(),
    dataDir: store.root,
    platform: process.platform,
  }));
}

// ---- lifecycle --------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Exiting silently here looks like a broken install ("npm start does
  // nothing") — say why, and let the running instance surface itself.
  console.error('[stepforge] already running — surfacing the existing window (check the tray).');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    // The window may be tucked away by a recording session; opening the
    // app again is an explicit request to see it, so pause and show, the
    // same as the tray's "Open StepForge".
    if (capture) capture.togglePause(true);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const dataDir = resolveDataDir();
    store = new GuideStore(dataDir);
    settings = new Settings(store.settingsDir);
    searchIndex = new SearchIndex(store.indexDir);
    templates = new TemplateManager(store.templatesDir);
    textIntel = new TextIntelService({
      store,
      settings,
      getWindow: () => mainWindow,
      dataDir,
      screenApi: screen,
    });
    // Bringing up the desktop-capture stream spawns/upgrades Chromium's GPU
    // and screen-capture utility processes — which can be born after a session
    // already started, so the start-time EcoQoS opt-out misses them. Re-apply
    // it the moment the backend reports it is streaming.
    let lastClickFrameSource = null;
    const captureNotify = (channel, payload) => {
      sendToRenderer(channel, payload);
      if (channel === 'capture:state' && payload && payload.clickFrameSource !== lastClickFrameSource) {
        lastClickFrameSource = payload.clickFrameSource;
        if (payload.clickFrameSource === 'stream') {
          try { keepProcessesResponsive(app.getAppMetrics().map((m) => m.pid)); } catch { /* best effort */ }
        }
      }
      // Auto-document session captures in the background when autoDoc is enabled.
      // Single-shot captures (capture:shoot) are handled synchronously in the IPC handler.
      if (channel === 'capture:added' && payload?.step && payload?.guideId) {
        const aiConf = settings.get('ai') || {};
        if (aiConf.enabled && aiConf.autoDoc) {
          textIntel.generateStepPatch({
            guideId: payload.guideId,
            stepId: payload.step.stepId,
            target: 'all',
          }).then((result) => {
            if (result.ok) {
              reindex(payload.guideId);
              sendToRenderer('step:updated', { guideId: payload.guideId, step: result.step });
            }
          }).catch(() => {});
        }
      }
    };

    // Single owner of OS power/throttling state for recording. The capture
    // service calls setRecording(true/false) on every recording transition;
    // this holds a power-save blocker and opts live Electron processes out of
    // EcoQoS while recording, and releases the blocker when recording stops.
    const capturePowerPolicy = (() => {
      let blocker = -1;
      const keepResponsive = () => {
        try { keepProcessesResponsive(app.getAppMetrics().map((m) => m.pid)); } catch { /* best effort */ }
      };
      return {
        setRecording(recording) {
          if (recording) {
            if (!powerSaveBlocker.isStarted(blocker)) {
              blocker = powerSaveBlocker.start('prevent-app-suspension');
            }
            keepResponsive();
          } else if (powerSaveBlocker.isStarted(blocker)) {
            powerSaveBlocker.stop(blocker);
          }
        },
      };
    })();

    capture = new CaptureService({
      store,
      settings,
      getWindow: () => mainWindow,
      notify: captureNotify,
      textIntel,
      powerPolicy: capturePowerPolicy,
    });

    // Deny-by-default permission policy. The only grant in the entire app is
    // display capture (and the media permission getDisplayMedia consults) for
    // the dedicated hidden capture-worker page. Electron 29+ requires that
    // explicit grant; everything else — including our own main window — is
    // rejected. "Content is local" is not a security control.
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      const url = (details && details.requestingUrl) || (wc && wc.getURL()) || requestingOrigin;
      return security.permissionAllowed(permission, url);
    });
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      const url = (details && details.requestingUrl) || (wc && wc.getURL());
      cb(security.permissionAllowed(permission, url));
    });

    // On GNOME Wayland the only working screen-capture path is the portal-backed
    // getDisplayMedia (desktopCapturer source ids fail with "device not found").
    // The worker calls getDisplayMedia; this handler answers it. Calling
    // getSources() *inside* the handler is the documented Wayland path: it
    // drives the XDG portal picker (shown once when a recording starts), and
    // the chosen source then streams for the whole session. (useSystemPicker is
    // macOS-only today, harmless elsewhere.)
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      // Only the capture worker page may open a desktop stream.
      const frameUrl = request && request.frame && request.frame.url;
      if (!security.isAppPageUrl(frameUrl, 'captureWorker')) {
        console.error('[stepforge] display-media request denied for', frameUrl || '(unknown frame)');
        callback({});
        return;
      }
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => {
          console.log(`[stepforge] display-media request resolved: ${sources.length} screen source(s)`);
          callback(sources.length ? { video: sources[0] } : {});
        })
        .catch((err) => {
          console.error(`[stepforge] display-media getSources failed: ${err && err.message}`);
          callback({});
        });
    }, { useSystemPicker: true });

    applyTheme();
    setupIpc();
    createWindow();
    registerHotkeys();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Drain clicks still encoding in the capture queue before the app exits, so
  // a fast burst immediately before quit is not lost. Defer the quit exactly
  // once with a bounded deadline, then let it proceed.
  let quitDrained = false;
  app.on('before-quit', (event) => {
    if (quitDrained || !capture) return;
    quitDrained = true;
    event.preventDefault();
    // Stop new clicks from being queued, then wait for the queue to settle.
    capture.stopClickWatcher();
    capture.drainPendingClicks(2000).finally(() => app.quit());
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (capture) {
      // Targeted cleanup (not finishSession — that re-shows the window).
      capture.stopClickWatcher();
      capture.destroySessionTray();
    }
    if (textIntel) {
      textIntel.shutdown().catch(() => {});
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
