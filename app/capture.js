'use strict';

const path = require('node:path');
const { desktopCapturer, screen, BrowserWindow, nativeImage } = require('electron');
const { expandPlaceholders } = require('../core/placeholders');

/**
 * Capture service: full-screen, active-window, and region capture via
 * Electron's desktopCapturer, plus a click-marker annotation at the cursor
 * position and a capture session (start/pause/resume/finish) driven by the
 * global hotkey.
 *
 * Note: under Wayland/WSLg, screen capture may require portal support; all
 * failures surface as { ok: false, reason } instead of crashing.
 */

class CaptureService {
  constructor({ store, settings, getWindow, notify }) {
    this.store = store;
    this.settings = settings;
    this.getWindow = getWindow;
    this.notify = notify;
    this.session = null; // { guideId, paused, count }
  }

  state() {
    return this.session
      ? { active: true, paused: this.session.paused, guideId: this.session.guideId, count: this.session.count }
      : { active: false };
  }

  startSession(guideId) {
    this.session = { guideId, paused: false, count: 0 };
  }

  togglePause(force) {
    if (!this.session) return;
    this.session.paused = typeof force === 'boolean' ? force : !this.session.paused;
  }

  finishSession() {
    this.session = null;
  }

  async hotkeyCapture() {
    if (!this.session || this.session.paused) return { ok: false, reason: 'no active capture session' };
    const mode = this.settings.get('capture.mode') || 'fullscreen';
    const result = await this.shoot({
      guideId: this.session.guideId,
      mode: mode === 'region' ? 'fullscreen' : mode,
      delayMs: 0,
    });
    if (result.ok) {
      this.session.count += 1;
      this.notify('capture:added', { guideId: this.session.guideId, step: result.step });
    }
    return result;
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
    const types = mode === 'window' ? ['window'] : ['screen'];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (!sources.length) throw new Error('no capture sources available (portal/permissions?)');

    let source = sources[0];
    if (mode === 'window') {
      const win = this.getWindow();
      const ownTitle = win ? win.getTitle() : '';
      source = sources.find((s) => s.name && s.name !== ownTitle && !/stepforge/i.test(s.name)) || sources[0];
    } else if (sources.length > 1) {
      source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    }
    const image = source.thumbnail;
    if (!image || image.isEmpty()) throw new Error('capture returned an empty image');
    return { image, display, cursor };
  }

  /**
   * Take a screenshot and append it to the guide as a new image step.
   * Adds a click-marker annotation at the cursor position when enabled.
   */
  async shoot({ guideId, mode = 'fullscreen', delayMs = null }) {
    const delay = delayMs == null ? this.settings.get('capture.delayMs') || 0 : delayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    let grabbed;
    try {
      grabbed = await this.grab(mode);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    const { image, display, cursor } = grabbed;
    const size = image.getSize();
    const annotations = [];
    if (mode !== 'window' && this.settings.get('capture.clickMarker')) {
      const fx = (cursor.x - display.bounds.x) / display.bounds.width;
      const fy = (cursor.y - display.bounds.y) / display.bounds.height;
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        const d = 0.035;
        annotations.push({
          type: 'oval',
          x: fx - d / 2, y: fy - (d * size.width / size.height) / 2,
          w: d, h: d * size.width / size.height,
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
    }, image.toPNG(), size);
    return { ok: true, step };
  }

  /**
   * Region capture: shoot the full screen, then let the user drag a
   * rectangle in a fullscreen overlay; the crop becomes the step image.
   */
  async regionCapture(guideId) {
    let grabbed;
    try {
      grabbed = await this.grab('fullscreen');
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
