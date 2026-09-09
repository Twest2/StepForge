'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { dialog, nativeImage } = require('electron');
const CaptureService = require('../../capture');
const { PortalBackend } = require('./portal-backend');
const run = promisify(execFile);
const UUID = 'stepforge@twestbrook.com';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cropGeometry(bounds, rect, size) {
  const x = Math.max(bounds.x, rect.x);
  const y = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
  if (right <= x || bottom <= y) throw new Error('The selected area is outside the shared monitor.');
  const sx = size.width / bounds.width;
  const sy = size.height / bounds.height;
  const px = Math.round((x - bounds.x) * sx);
  const py = Math.round((y - bounds.y) * sy);
  return {
    bounds: { x, y, width: right - x, height: bottom - y },
    pixels: { x: px, y: py, width: Math.round((right - bounds.x) * sx) - px,
      height: Math.round((bottom - bounds.y) * sy) - py },
  };
}

class GnomeCaptureService extends CaptureService {
  constructor(options) {
    super(options);
    this.backendFactory = options.backendFactory || (() => new PortalBackend());
    this.ensureCompanion = options.ensureCompanion || (() => this.ensureExtension());
    this.captureError = '';
  }

  state() {
    return { ...super.state(), gnomeRequired: true, warmingUp: this.warmingUp,
      captureError: this.captureError || '', clickTiming: 'sampled-4ms' };
  }

  // Availability means the GNOME path is required. Readiness is verified on
  // each resume; a missing extension never silently switches to a timer.
  clickCaptureAvailable() { return true; }
  startClickWatcher() { this.clickSource = 'unavailable'; }
  stopClickWatcher() { this.clickSource = 'unavailable'; this.lastAcceptedClickByButton.clear(); }
  osPointToDip(point) { return point; } // Shell already sends logical coordinates.

  async ensureExtension() {
    const probe = () => run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell',
      '--object-path', '/org/stepforge/Capture', '--method', 'org.stepforge.Capture1.GetInfo'], { timeout: 4000 });
    try { await probe(); return; } catch { /* first-run setup */ }
    const result = await dialog.showMessageBox(this.getWindow(), {
      type: 'info', title: 'Enable StepForge Capture',
      message: 'GNOME recording requires the bundled StepForge Capture extension.',
      detail: 'Enable it to record mouse clicks and their positions. If GNOME has not loaded the newly installed extension yet, log out and log back in first.',
      buttons: ['Enable extension', 'Cancel'], defaultId: 0, cancelId: 1,
    });
    if (result.response !== 0) throw new Error('Enable the StepForge Capture GNOME extension before recording.');
    try {
      await run('gnome-extensions', ['enable', UUID], { timeout: 5000 });
      await delay(250);
      await probe();
    } catch {
      throw new Error('GNOME could not load StepForge Capture. Install the Ubuntu package (GNOME 50), then log out and back in. For a source checkout, run bash scripts/linux/install-gnome-extension.sh first.');
    }
  }

  async openBackend() {
    const backend = this.backendFactory();
    this.pendingBackend = backend;
    try {
      await backend.start({ sampleMs: this.settings.get('capture.frameSampleMs') || 50,
        includeCursor: this.settings.get('capture.includeCursor') !== false });
      return backend;
    } catch (error) {
      backend.stop({ immediate: true });
      throw error;
    } finally {
      if (this.pendingBackend === backend) this.pendingBackend = null;
    }
  }

  armRecording() {
    const session = this.session;
    const gen = this.captureGen;
    const current = () => this.session === session && !session.paused && this.captureGen === gen;
    this.captureError = '';
    this.warmingUp = true;
    this.notify('capture:state', this.state());
    const start = async () => {
      await this.ensureCompanion();
      if (!current()) return;
      const backend = await this.openBackend();
      if (!current()) { backend.stop(); return; }
      this.streamBackend = backend;
      backend.on('failure', (reason) => { if (current()) this.recordingFailed(reason); });
      backend.on('click', (event) => this.onGnomeClick(event));
      const win = this.getWindow();
      if (win && !win.isDestroyed()) win.minimize();
      await delay(Math.max(150, Number(this.settings.get('capture.postHideSettleMs')) || 0));
      if (!current()) return;
      await backend.arm();
      if (!current()) return;
      this.clickSource = 'gnome-shell-sampled';
      this.warmingUp = false;
      this.notify('capture:state', this.state());
    };
    this.starting = start().catch((error) => { if (current()) this.recordingFailed(error.message); });
  }

  recordingFailed(reason) {
    this.captureError = reason;
    this.togglePause(true);
    const win = this.getWindow();
    if (win && !win.isDestroyed()) { win.restore(); win.show(); }
    this.notify('capture:state', this.state());
  }

  stopClickFrameBackend() {
    if (this.pendingBackend) {
      this.pendingBackend.stop({ immediate: true });
      this.pendingBackend = null;
    }
    this.clickSource = 'unavailable';
    super.stopClickFrameBackend();
  }

  onGnomeClick(event) {
    if (!this.session || this.session.paused || this.warmingUp || this.userIsInApp()) return;
    if (event.windowPid === process.pid) return;
    if (![event.x, event.y, event.at].every(Number.isFinite) || ![1, 2, 3].includes(event.button)) return;
    const button = `button-${event.button}`;
    if (this.isDebouncedClick(event.at, button)) return;
    const guideId = this.session.guideId;
    const point = { x: event.x, y: event.y };
    const mode = this.settings.get('capture.mode') || 'fullscreen';
    // Select immediately, before disk I/O or another click can evict the frame.
    const framePromise = this.frameForClick(point, event.at, mode, event.window)
      .then((frame) => ({ frame }), (error) => ({ error }));
    this.clickQueue = this.clickQueue.then(async () => {
      const { frame, error } = await framePromise;
      if (error) throw error;
      const result = await this.storeFrameAsStep(guideId, frame.mode, frame, point, {
        at: event.at, button, guideId, timingSource: 'gnome-shell-sampled',
        windowContext: { appName: event.appName || '', windowTitle: event.windowTitle || '' },
      });
      if (result.ok) {
        // Accepted clicks stay with their original guide even across pause,
        // finish, or a new recording. Do not increment a different session.
        if (this.session?.guideId === guideId) this.session.count += 1;
        this.notify('capture:added', { guideId, step: result.step, trigger: 'click' });
        this.notify('capture:state', this.state());
      }
    }).catch((error) => {
      // Stopping a session deliberately tears down the helper after it drains
      // selected frames. A late rejection must not turn a completed recording
      // into a persistent, misleading UI warning.
      if (this.session?.guideId !== guideId || this.session.paused) return;
      this.captureError = error.message;
      this.notify('capture:state', this.state());
      this.notify('capture:diagnostic', { kind: 'gnome-click-skipped', guideId, reason: error.message });
    });
  }

  cropFrame(frame, rect, mode) {
    const geometry = cropGeometry(frame.display.bounds, rect, frame.size);
    const image = nativeImage.createFromBuffer(frame.png).crop(geometry.pixels);
    return { ...frame, mode, png: image.toPNG(), size: image.getSize(),
      display: { ...frame.display, bounds: geometry.bounds } };
  }

  async frameForClick(point, at, mode = 'fullscreen', windowRect = null) {
    if (!this.streamBackend?.isActive()) throw new Error('Screen sharing is not ready.');
    const frame = await this.streamBackend.frameForClick({ clickPos: point, clickAt: at,
      strict: this.strictClickFrames(), leadMs: Number(this.settings.get('capture.clickLeadMs')) || 0 });
    if (mode === 'window') {
      if (!windowRect) throw new Error('GNOME did not identify the active window.');
      return this.cropFrame(frame, windowRect, 'window');
    }
    return frame;
  }

  async withBackend(fn) {
    if (this.streamBackend?.isActive()) return fn(this.streamBackend);
    await this.ensureCompanion();
    const backend = await this.openBackend();
    try { return await fn(backend); } finally { backend.stop(); }
  }

  async grab(mode, point = null) {
    return this.withBackend(async (backend) => {
      const context = await backend.request('context');
      const candidate = point || context.pointer;
      const isShared = backend.displays.some(({ bounds: b }) => candidate
        && candidate.x >= b.x && candidate.x < b.x + b.width
        && candidate.y >= b.y && candidate.y < b.y + b.height);
      const frame = await backend.frameForClick({ clickPos: isShared ? candidate : null, strict: false });
      const output = mode === 'window' && context.window ? this.cropFrame(frame, context.window, mode) : frame;
      return { image: nativeImage.createFromBuffer(output.png), display: output.display, cursor: null };
    });
  }

  async regionCapture(guideId) {
    try {
      return await this.withBackend((backend) => this.withWindowHidden(async () => {
        const { rect } = await backend.request('region');
        // Let the native selection overlay disappear from the stream.
        await delay(200);
        const frame = await backend.frameForClick({ clickPos: { x: rect.x, y: rect.y }, strict: false });
        const b = frame.display.bounds;
        if (rect.x + rect.width > b.x + b.width || rect.y + rect.height > b.y + b.height)
          throw new Error('Select a region within one shared monitor.');
        return this.storeFrameAsStep(guideId, 'region', this.cropFrame(frame, rect, 'region'));
      }));
    } catch (error) { return { ok: false, reason: error.message }; }
  }
}

module.exports = GnomeCaptureService;
module.exports.cropGeometry = cropGeometry;
