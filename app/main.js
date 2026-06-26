'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
const { exportGuideArchive, importGuideArchive, saveLinkedGuide, readArchive } = require('../core/archive');
const { createSnapshot, listSnapshots, restoreSnapshot } = require('../core/snapshots');
const { readLock } = require('../core/locks');
const CaptureService = require('./capture');
const { TextIntelService } = require('./text-intel');
const { keepProcessesResponsive } = require('./win-power');

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
      spellcheck: Boolean(settings.get('spellcheck')),
      // During a recording the window is minimized (Linux) or hidden (Windows).
      // A throttled renderer stops processing capture:added events, so the step
      // list and capture bar appear "stuck" even though steps are saved. Keep
      // the renderer live so the UI updates in real time while recording.
      backgroundThrottling: false,
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
          // queued (frames still encoding) when the stop lands.
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
  h('step:restore', ({ guideId, step, originalBase64, workingBase64, position }) => {
    const images = {
      original: originalBase64 ? Buffer.from(originalBase64, 'base64') : null,
      working: workingBase64 ? Buffer.from(workingBase64, 'base64') : null,
    };
    const restored = store.restoreStep(guideId, step, images, position);
    reindex(guideId);
    return restored;
  });
  h('steps:reorder', ({ guideId, order }) => store.reorderSteps(guideId, order));
  h('step:imagePath', ({ guideId, stepId, which }) => {
    const p = store.stepImagePath(guideId, stepId, which || 'working');
    return p && fs.existsSync(p) ? `file://${p}?v=${fs.statSync(p).mtimeMs}` : null;
  });
  h('step:setWorkingImage', ({ guideId, stepId, pngBase64, size, step }) =>
    store.setWorkingImage(guideId, stepId, Buffer.from(pngBase64, 'base64'), size, step || null));
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
  h('ai:test', async ({ enabled = null, ollama = null } = {}) => {
    return textIntel.testAiConnection({
      enabled,
      ollama,
    });
  });
  h('ai:fillStep', async ({ guideId, stepId, target = 'all', blockId = null } = {}) => {
    const result = await textIntel.generateStepPatch({
      guideId,
      stepId,
      target,
      blockId,
    });
    if (result.ok) reindex(guideId);
    return result;
  });
  h('ai:rewriteText', async ({ text, guideTitle = '', stepTitle = '' } = {}) => {
    return textIntel.rewriteText({ text, guideTitle, stepTitle });
  });
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
  });
  let capturePowerBlocker = -1;
  const startCapturePower = () => {
    if (!powerSaveBlocker.isStarted(capturePowerBlocker)) {
      capturePowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    }
  };
  const stopCapturePower = () => {
    if (powerSaveBlocker.isStarted(capturePowerBlocker)) {
      powerSaveBlocker.stop(capturePowerBlocker);
    }
  };

  // Opt every live Electron process (browser, GPU, the screen-capture utility,
  // any renderers) out of EcoQoS for the duration of a recording. The hidden
  // capture-worker renderer is created later, during warmup, so it opts itself
  // out separately (see stream-backend.js); this covers the rest.
  const keepCaptureProcessesResponsive = () => {
    try {
      keepProcessesResponsive(app.getAppMetrics().map((m) => m.pid));
    } catch { /* metrics unavailable — best effort */ }
  };

  h('capture:session', async ({ action, guideId, intervalSec }) => {
    if (action === 'start') {
      capture.startSession(guideId, { intervalSec: intervalSec ?? null });
      startCapturePower();
      keepCaptureProcessesResponsive();
    } else if (action === 'pause') {
      capture.togglePause(true);
      stopCapturePower();
    } else if (action === 'resume') {
      capture.togglePause(false);
      startCapturePower();
      keepCaptureProcessesResponsive();
    } else if (action === 'finish') {
      capture.finishSession();
      stopCapturePower();
    } else if (action === 'interval') {
      capture.setInterval(intervalSec);
    }
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
    const result = await runExportInWorker({
      dataDir: store.root,
      guideId,
      format,
      options: options || {},
      outDir: dir,
      globals: settings.getGlobalPlaceholders(),
    });
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

    capture = new CaptureService({
      store,
      settings,
      getWindow: () => mainWindow,
      notify: captureNotify,
      textIntel,
    });

    // Allow the hidden capture-worker renderer to open a desktop media stream.
    // Electron 29+ requires an explicit permission grant for display-capture in
    // renderer windows; without it getUserMedia/getDisplayMedia fails, the
    // stream backend never starts, and every capture falls back to
    // desktopCapturer.getSources() — which triggers the portal dialog on Linux
    // on every single capture. StepForge is fully local/offline so allowing
    // all permissions for our own content is safe.
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));

    // On GNOME Wayland the only working screen-capture path is the portal-backed
    // getDisplayMedia (desktopCapturer source ids fail with "device not found").
    // The worker calls getDisplayMedia; this handler answers it. Calling
    // getSources() *inside* the handler is the documented Wayland path: it
    // drives the XDG portal picker (shown once when a recording starts), and
    // the chosen source then streams for the whole session. (useSystemPicker is
    // macOS-only today, harmless elsewhere.)
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
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
