'use strict';

const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { desktopCapturer, screen, BrowserWindow, nativeImage, Tray, Menu, Notification } = require('electron');
const { expandPlaceholders } = require('../core/placeholders');
const raster = require('../core/raster');
const { encodePng } = require('../core/png');

/**
 * Capture service: full-screen, active-window, and region capture via
 * Electron's desktopCapturer, plus a click-marker annotation at the cursor
 * position and a capture session (start/pause/resume/finish).
 *
 * A session captures continuously, with three triggers layered by what the
 * platform supports:
 *  - click-capture via an OS adapter (xinput on X11, PowerShell on Windows),
 *  - a global hotkey (unreliable on some Wayland compositors),
 *  - interval auto-capture as the always-works fallback.
 *
 * Note: under Wayland/WSLg, screen capture may require portal support; all
 * failures surface as { ok: false, reason } instead of crashing.
 */

const CLICK_DEBOUNCE_MS = 700;
const CLICK_CAPTURE_CACHE_MS = 75;
const CLICK_CAPTURE_HIDE_DELAY_MS = 25;

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

class CaptureService {
  constructor({ store, settings, getWindow, notify }) {
    this.store = store;
    this.settings = settings;
    this.getWindow = getWindow;
    this.notify = notify;
    this.session = null; // { guideId, paused, count, intervalSec }
    this.intervalTimer = null;
    this.clickWatcher = null;
    this.captureCacheTimer = null;
    this.captureCache = null;
    this.captureCacheRunning = false;
    this.lastClickCapture = 0;
    this.shooting = false;
  }

  state() {
    return this.session
      ? {
        active: true,
        paused: this.session.paused,
        guideId: this.session.guideId,
        count: this.session.count,
        intervalSec: this.session.intervalSec || 0,
        clickCapture: Boolean(this.clickWatcher),
        clickCaptureAvailable: this.clickCaptureAvailable(),
      }
      : { active: false, clickCaptureAvailable: this.clickCaptureAvailable() };
  }

  clickCaptureAvailable() {
    if (this._clickAvail === undefined) {
      this._clickAvail = process.platform === 'win32' || (process.platform === 'linux' && hasBinary('xinput'));
    }
    return this._clickAvail;
  }

  startSession(guideId, { intervalSec = null } = {}) {
    this.finishSession();
    // Default trigger: clicks when the platform supports it, otherwise an
    // interval so a session always produces steps even if the global hotkey
    // never fires (common under Wayland/WSLg).
    let interval = intervalSec;
    if (interval == null) {
      interval = this.clickCaptureAvailable() ? 0 : (this.settings.get('capture.autoIntervalSec') || 5);
    }
    this.session = { guideId, paused: false, count: 0, intervalSec: interval };
    if (this.settings.get('capture.captureOutsideClicks') !== false) this.startClickWatcher();
    this.applyInterval();
    this.notify('capture:state', this.state());

    // Tuck the app away once instead of hiding it for every shot — the
    // hide/show flicker made the window impossible to click mid-session.
    // A tray icon controls the session while the window is hidden.
    // (Skipped for the dev screenshot hook, which needs a visible page.)
    if (!process.env.STEPFORGE_SCREENSHOT) {
      this.createSessionTray();
      const win = this.getWindow();
      const startClickCache = () => {
        if (this.settings.get('capture.captureOutsideClicks') !== false && this.clickCaptureAvailable()) {
          this.startClickCaptureCache();
        }
      };
      if (win && !win.isDestroyed() && win.isVisible()) {
        this.hiddenForSession = true;
        setTimeout(() => {
          // Re-check: the session may have been finished within the delay.
          if (this.session && this.hiddenForSession && !win.isDestroyed()) {
            win.hide();
            startClickCache();
          }
        }, 1200); // let the user read the "session started" toast first
      } else {
        startClickCache();
      }
      try {
        new Notification({
          title: 'StepForge is capturing',
          body: 'The window tucks away while recording. Use the red tray icon to pause, capture, or finish.',
        }).show();
      } catch { /* notifications unavailable on this desktop */ }
    }
  }

  /** Red-dot tray icon with session controls, shown while recording. */
  createSessionTray() {
    this.destroySessionTray();
    try {
      const img = raster.createImage(16, 16, [0, 0, 0, 0]);
      raster.fillOval(img, 2, 2, 12, 12, [229, 72, 77, 255]);
      this.tray = new Tray(nativeImage.createFromBuffer(encodePng(img)));
      this.tray.setToolTip('StepForge — capture session running');
      const rebuild = () => {
        if (!this.tray || this.tray.isDestroyed()) return;
        this.tray.setContextMenu(Menu.buildFromTemplate([
          { label: `Captured ${this.session ? this.session.count : 0} steps`, enabled: false },
          { type: 'separator' },
          { label: 'Capture now', click: () => this.sessionCapture('manual').then(rebuild).catch(() => {}) },
          {
            label: this.session && this.session.paused ? 'Resume capturing' : 'Pause capturing',
            click: () => { this.togglePause(); rebuild(); },
          },
          {
            label: 'Open StepForge (pauses capture)',
            click: () => {
              this.togglePause(true);
              this.showWindow();
              rebuild();
            },
          },
          { type: 'separator' },
          { label: 'Finish session', click: () => this.finishSession() },
        ]));
      };
      rebuild();
      this.rebuildTrayMenu = rebuild;
      this.tray.on('click', () => {
        this.togglePause(true);
        this.showWindow();
        rebuild();
      });
    } catch {
      this.tray = null; // no tray on this desktop; cursor-over skip still protects clicks
    }
  }

  destroySessionTray() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
    this.rebuildTrayMenu = null;
  }

  showWindow() {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  }

  setInterval(intervalSec) {
    if (!this.session) return this.state();
    this.session.intervalSec = Math.max(0, Number(intervalSec) || 0);
    this.applyInterval();
    this.notify('capture:state', this.state());
    return this.state();
  }

  applyInterval() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    const sec = this.session && this.session.intervalSec;
    if (sec > 0) {
      this.intervalTimer = setInterval(() => {
        this.sessionCapture('interval').catch(() => {});
      }, sec * 1000);
    }
  }

  togglePause(force) {
    if (!this.session) return;
    const wasPaused = this.session.paused;
    this.session.paused = typeof force === 'boolean' ? force : !this.session.paused;
    // Resuming from the app tucks the window away again for clean shots.
    if (wasPaused && !this.session.paused && this.hiddenForSession) {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) setTimeout(() => {
        if (this.session && !this.session.paused && !win.isDestroyed()) win.hide();
      }, 400);
    }
    if (this.rebuildTrayMenu) this.rebuildTrayMenu();
    this.notify('capture:state', this.state());
  }

  finishSession() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.stopClickWatcher();
    this.stopClickCaptureCache();
    this.destroySessionTray();
    this.session = null;
    if (this.hiddenForSession) {
      this.hiddenForSession = false;
      this.showWindow();
    }
    this.notify('capture:state', this.state());
  }

  /**
   * True when the user is interacting with StepForge itself. Deliberately
   * based on cursor position over the visible window, not isFocused():
   * some compositors (WSLg) report focus as stuck-true, which would block
   * every automatic capture forever.
   */
  userIsInApp() {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
    const cur = screen.getCursorScreenPoint();
    const b = win.getBounds();
    return cur.x >= b.x && cur.x <= b.x + b.width && cur.y >= b.y && cur.y <= b.y + b.height;
  }

  /** One capture inside the active session (hotkey/click/interval/manual). */
  async sessionCapture(trigger = 'hotkey') {
    if (!this.session || this.session.paused) return { ok: false, reason: 'no active capture session' };
    if (this.shooting) return { ok: false, reason: 'capture already in progress' };
    // Automatic triggers stand down while the user is in StepForge, so the
    // app stays clickable mid-session and never screenshots itself.
    if (trigger !== 'manual' && this.userIsInApp()) {
      return { ok: false, reason: 'skipped — StepForge is focused' };
    }
    this.shooting = true;
    try {
      const mode = this.settings.get('capture.mode') || 'fullscreen';
      const grabMode = mode === 'region' ? 'fullscreen' : mode;
      const cached = trigger === 'click' && this.captureCache && this.captureCache.mode === grabMode
        ? this.captureCache
        : null;
      const finalResult = cached
        ? this.storeFrameAsStep(this.session.guideId, grabMode, cached)
        : await this.shoot({
          guideId: this.session.guideId,
          mode: grabMode,
          delayMs: 0,
          hideWindowDelayMs: trigger === 'click' ? CLICK_CAPTURE_HIDE_DELAY_MS : null,
          refocus: false, // don't steal focus from the app the user is documenting
        });
      if (finalResult.ok) {
        this.session.count += 1;
        this.notify('capture:added', { guideId: this.session.guideId, step: finalResult.step, trigger });
        this.notify('capture:state', this.state());
        if (this.rebuildTrayMenu) this.rebuildTrayMenu(); // refresh step counter
      }
      return finalResult;
    } finally {
      this.shooting = false;
    }
  }

  hotkeyCapture() {
    return this.sessionCapture('hotkey');
  }

  // ---- click-triggered capture --------------------------------------------

  startClickCaptureCache() {
    if (this.captureCacheRunning) return;
    this.captureCacheRunning = true;
    const refresh = async () => {
      if (!this.session || this.session.paused || !this.captureCacheRunning) return;
      try {
        if (!this.shooting) {
          const mode = this.settings.get('capture.mode') || 'fullscreen';
          const grabMode = mode === 'region' ? 'fullscreen' : mode;
          const frame = await this.captureCurrentFrame(grabMode);
          if (this.captureCacheRunning && this.session && !this.session.paused) {
            this.captureCache = frame;
          }
        }
      } catch {
        // Cache misses are fine; click capture falls back to a fresh shot.
      } finally {
        if (this.session && !this.session.paused && this.captureCacheRunning) {
          this.captureCacheTimer = setTimeout(refresh, CLICK_CAPTURE_CACHE_MS);
        }
      }
    };
    this.captureCacheTimer = setTimeout(refresh, 0);
  }

  stopClickCaptureCache() {
    if (this.captureCacheTimer) {
      clearTimeout(this.captureCacheTimer);
      this.captureCacheTimer = null;
    }
    this.captureCacheRunning = false;
    this.captureCache = null;
  }

  startClickWatcher() {
    this.stopClickWatcher();
    try {
      if (process.platform === 'linux' && hasBinary('xinput')) {
        // Stream raw button events from the X server; one capture per press.
        this.clickWatcher = spawn('xinput', ['test-xi2', '--root'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let sawPress = false;
        this.clickWatcher.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          if (/RawButtonPress|ButtonPress/.test(text)) sawPress = true;
          if (sawPress) {
            sawPress = false;
            this.onOsClick();
          }
        });
      } else if (process.platform === 'win32') {
        // Poll the left mouse button via GetAsyncKeyState; print one line per click.
        const ps = `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);'
$down = $false
while ($true) {
  $s = [W.U]::GetAsyncKeyState(0x01) -band 0x8000
  if ($s -and -not $down) { Write-Output CLICK }
  $down = [bool]$s
  Start-Sleep -Milliseconds 10
}`;
        this.clickWatcher = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] });
        this.clickWatcher.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('CLICK')) this.onOsClick();
        });
      }
      if (this.clickWatcher) {
        this.clickWatcher.on('error', () => { this.clickWatcher = null; });
        this.clickWatcher.on('exit', () => { this.clickWatcher = null; });
      }
    } catch {
      this.clickWatcher = null;
    }
  }

  stopClickWatcher() {
    if (this.clickWatcher) {
      try { this.clickWatcher.kill(); } catch { /* already gone */ }
      this.clickWatcher = null;
    }
  }

  onOsClick() {
    if (!this.session || this.session.paused) return;
    // Ignore clicks on StepForge itself (pausing, finishing, editing).
    if (BrowserWindow.getFocusedWindow()) return;
    const now = Date.now();
    if (now - this.lastClickCapture < CLICK_DEBOUNCE_MS) return;
    this.lastClickCapture = now;
    this.sessionCapture('click').catch(() => {});
  }

  async captureCurrentFrame(mode) {
    const grabbed = await this.grab(mode);
    return {
      mode,
      png: grabbed.image.toPNG(),
      size: grabbed.image.getSize(),
      display: grabbed.display,
      cursor: grabbed.cursor,
      capturedAt: Date.now(),
    };
  }

  storeFrameAsStep(guideId, mode, frame) {
    if (!frame) return { ok: false, reason: 'no capture frame available' };
    const annotations = [];
    if (mode !== 'window' && this.settings.get('capture.clickMarker')) {
      const fx = (frame.cursor.x - frame.display.bounds.x) / frame.display.bounds.width;
      const fy = (frame.cursor.y - frame.display.bounds.y) / frame.display.bounds.height;
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        const d = 0.035;
        annotations.push({
          type: 'oval',
          x: fx - d / 2, y: fy - (d * frame.size.width / frame.size.height) / 2,
          w: d, h: d * frame.size.width / frame.size.height,
          style: {
            stroke: this.settings.get('capture.clickMarkerColor') || '#E5484D',
            strokeWidth: 4, fill: 'transparent',
          },
        });
      }
    }

    const step = this.store.addStep(guideId, {
      title: this.autoTitle(mode),
      annotations,
      focusedView: {
        enabled: Boolean(this.settings.get('editor.focusedViewDefaultForNewSteps')),
        zoom: 1, panX: 0.5, panY: 0.5,
      },
    }, frame.png, frame.size);
    return { ok: true, step };
  }

  autoTitle(mode) {
    const tplStr = this.settings.get('editor.autoTitleTemplate') || '[[Mode]] capture [[Time]]';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return expandPlaceholders(tplStr, {
      Mode: { fullscreen: 'Screen', window: 'Window', region: 'Region' }[mode] || 'Screen',
      Time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      Date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    });
  }

  /** Grab the screen/window image as { image, display } or throw. */
  async grab(mode) {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    // Ask for both kinds: some compositors (WSLg/Wayland portals) expose no
    // individual window sources, so window mode falls back to the screen.
    const sources = await desktopCapturer.getSources({
      types: mode === 'window' ? ['window', 'screen'] : ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (!sources.length) throw new Error('no capture sources available (portal/permissions?)');

    let source = null;
    if (mode === 'window') {
      const win = this.getWindow();
      const ownTitle = win ? win.getTitle() : '';
      const windows = sources.filter((s) => s.id.startsWith('window:'));
      source = windows.find((s) => s.name && s.name !== ownTitle && !/stepforge/i.test(s.name))
        || windows[0]
        || sources.find((s) => s.id.startsWith('screen:'));
    } else {
      const screens = sources.filter((s) => s.id.startsWith('screen:'));
      source = screens.find((s) => String(s.display_id) === String(display.id)) || screens[0] || sources[0];
    }
    if (!source) throw new Error('no capture source matched');
    const image = source.thumbnail;
    if (!image || image.isEmpty()) throw new Error('capture returned an empty image');
    return { image, display, cursor };
  }

  /**
   * Hide the app window while `fn` runs so screenshots show the user's work,
   * not StepForge itself. Restores visibility afterwards.
   */
  async withWindowHidden(fn, { refocus = true, pauseMs = 350 } = {}) {
    const win = this.getWindow();
    const wasVisible = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    if (wasVisible) {
      win.hide();
      if (pauseMs > 0) {
        await new Promise((r) => setTimeout(r, pauseMs)); // let the compositor repaint
      }
    }
    try {
      return await fn();
    } finally {
      if (wasVisible && win && !win.isDestroyed()) {
        if (refocus) {
          win.show();
          win.focus();
        } else {
          win.showInactive();
        }
      }
    }
  }

  /**
   * Take a screenshot and append it to the guide as a new image step.
   * Adds a click-marker annotation at the cursor position when enabled.
   */
  async shoot({
    guideId,
    mode = 'fullscreen',
    delayMs = null,
    hideWindow = true,
    refocus = true,
    hideWindowDelayMs = null,
  }) {
    const delay = delayMs == null ? this.settings.get('capture.delayMs') || 0 : delayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    let frame;
    try {
      frame = hideWindow
        ? await this.withWindowHidden(() => this.captureCurrentFrame(mode), {
          refocus,
          pauseMs: hideWindowDelayMs == null ? 350 : hideWindowDelayMs,
        })
        : await this.captureCurrentFrame(mode);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    return this.storeFrameAsStep(guideId, mode, frame);
  }

  /**
   * Region capture: shoot the full screen, then let the user drag a
   * rectangle in a fullscreen overlay; the crop becomes the step image.
   */
  async regionCapture(guideId) {
    let grabbed;
    try {
      grabbed = await this.withWindowHidden(() => this.grab('fullscreen'));
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    const { image, display } = grabbed;
    const rect = await this.pickRegion(display, image);
    if (!rect) return { ok: false, reason: 'selection cancelled' };

    const cropped = image.crop(rect);
    const size = cropped.getSize();
    if (!size.width || !size.height) return { ok: false, reason: 'empty selection' };
    const step = this.store.addStep(guideId, { title: this.autoTitle('region') },
      cropped.toPNG(), size);
    return { ok: true, step };
  }

  /** Fullscreen overlay window that resolves with a crop rect (image px). */
  pickRegion(display, image) {
    return new Promise((resolve) => {
      const overlay = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        fullscreen: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, 'region-preload.js'),
          contextIsolation: true,
        },
      });
      let settled = false;
      const finish = (rect) => {
        if (settled) return;
        settled = true;
        if (!overlay.isDestroyed()) overlay.close();
        resolve(rect);
      };
      const { ipcMain } = require('electron');
      const onPick = (event, rect) => {
        if (event.sender !== overlay.webContents) return;
        ipcMain.removeListener('region:picked', onPick);
        if (!rect) return finish(null);
        const imgSize = image.getSize();
        const sx = imgSize.width / display.bounds.width;
        const sy = imgSize.height / display.bounds.height;
        finish({
          x: Math.round(rect.x * sx),
          y: Math.round(rect.y * sy),
          width: Math.round(rect.w * sx),
          height: Math.round(rect.h * sy),
        });
      };
      ipcMain.on('region:picked', onPick);
      overlay.on('closed', () => finish(null));
      overlay.loadFile(path.join(__dirname, 'renderer', 'region.html'));
    });
  }
}

module.exports = CaptureService;
