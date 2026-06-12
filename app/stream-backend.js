'use strict';

const path = require('node:path');
const { displayForDipPoint, pointInBounds } = require('./coords');

/**
 * Off-main-process click-frame backend.
 *
 * The legacy design ran desktopCapturer.getSources() in a 200ms loop on the
 * main process. That had two structural problems this backend removes:
 *  - every grab (and the occasional PNG encode) blocked the main-process
 *    event loop, which delayed delivery of OS click events — the very events
 *    the loop existed to serve — by up to whole seconds under load;
 *  - getSources() is a heavy thumbnail API, so the loop had to idle 200ms
 *    between grabs, leaving clicks to be matched against frames that could
 *    be hundreds of ms stale.
 *
 * Here, a hidden worker window opens a desktop media *stream* per display
 * and samples it on a tight cadence into a timestamped ring buffer — all in
 * the worker's renderer process. On click, the main process sends only a tiny
 * IPC request carrying the hook-time click timestamp; the worker picks the
 * newest frame captured at or before that instant (strict semantics from
 * click-frames.js), PNG-encodes it off the main process, and ships the bytes
 * back. The main process never grabs or encodes a frame while recording.
 *
 * Failure handling: the backend is an optimization, never a single point of
 * failure. If streams don't come up (Wayland portals, WSLg quirks) start()
 * reports false and the capture service falls back to the legacy loop; if
 * frame requests start timing out mid-session, the backend declares itself
 * unhealthy once and the service degrades the same way.
 */

const DEFAULT_SAMPLE_MS = 100;
// The reply protocol is two-stage so a *slow* worker is never mistaken for a
// *dead* one: the worker acknowledges frame selection within milliseconds
// (that pins the click↔frame pairing and proves liveness), then ships the
// PNG whenever the encode finishes — which can take seconds per frame on
// software-rendered hosts (WSLg, VMs). Only a missing ack marks the worker
// unhealthy; a slow payload merely arrives late but is still the exact
// frame chosen at click time.
const DEFAULT_ACK_TIMEOUT_MS = 2000;
const DEFAULT_ENCODE_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 8000;
// Consecutive unanswered requests before the backend declares itself
// unhealthy and the capture service degrades to the in-process loop.
const MAX_CONSECUTIVE_FAILURES = 2;

class StreamCaptureBackend {
  /**
   * @param {object} opts
   * @param {(onEvent: (msg) => void) => Promise<{send,destroy}>} opts.createHost
   *   Factory for the worker transport (the hidden BrowserWindow in
   *   production, a fake in tests).
   * @param {(reason: string) => void} [opts.onUnhealthy]
   */
  constructor({
    createHost,
    onUnhealthy = null,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    encodeTimeoutMs = DEFAULT_ENCODE_TIMEOUT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  } = {}) {
    this.createHost = createHost;
    this.onUnhealthy = onUnhealthy;
    this.ackTimeoutMs = ackTimeoutMs;
    this.encodeTimeoutMs = encodeTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.host = null;
    this.active = false;
    this.requests = new Map(); // requestId -> { resolve, timer }
    this.streams = new Map(); // displayId(string) -> { display, ready }
    this.nextRequestId = 1;
    this.consecutiveFailures = 0;
    this.startWaiters = [];
    this.draining = false;
  }

  isActive() {
    return this.active;
  }

  /**
   * Spin up the worker and one stream per display that has a matching screen
   * source. Resolves true when at least one stream is delivering frames.
   */
  async start({ displays = [], sources = [], sampleMs = DEFAULT_SAMPLE_MS, retentionMs = null, frameLimit = null } = {}) {
    if (this.host) return this.active;
    const pairs = pairDisplaysToSources(displays, sources);
    if (!pairs.length) return false;
    try {
      this.host = await this.createHost((msg) => this.handleWorkerEvent(msg));
    } catch {
      this.host = null;
      return false;
    }
    for (const { display, sourceId } of pairs) {
      this.streams.set(String(display.id), { display, ready: false, failed: false });
      this.hostSend({
        type: 'start-stream',
        displayId: display.id,
        sourceId,
        // The worker needs the physical pixel size to request a full-res
        // stream; bounds stay in DIP for marker math back in the main process.
        display: {
          id: display.id,
          bounds: display.bounds,
          scaleFactor: display.scaleFactor || 1,
        },
        sampleMs,
        retentionMs,
        frameLimit,
      });
    }
    const anyReady = await this.waitForStreams();
    this.active = anyReady;
    if (!anyReady) this.stop();
    return this.active;
  }

  /** Resolves true as soon as one stream reports ready, false on timeout/all-failed. */
  waitForStreams() {
    return new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer);
        this.startWaiters = this.startWaiters.filter((w) => w !== check);
        resolve(ok);
      };
      const check = () => {
        const states = [...this.streams.values()];
        if (states.some((s) => s.ready)) return finish(true);
        if (states.length && states.every((s) => s.failed)) return finish(false);
        return null;
      };
      const timer = setTimeout(() => finish(false), this.startTimeoutMs);
      this.startWaiters.push(check);
      check();
    });
  }

  hostSend(msg) {
    if (!this.host) return;
    try {
      this.host.send(msg);
    } catch {
      // A dead host surfaces as request timeouts → unhealthy → degrade.
    }
  }

  handleWorkerEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'stream-ready' || msg.type === 'stream-error') {
      const stream = this.streams.get(String(msg.displayId));
      if (stream) {
        stream.ready = msg.type === 'stream-ready';
        stream.failed = msg.type === 'stream-error';
      }
      for (const check of [...this.startWaiters]) check();
      return;
    }
    if (msg.type === 'frame-selected') {
      // Stage one: the worker picked a frame for this click. The pairing is
      // now pinned and the worker is provably alive — swap the short ack
      // deadline for the long encode deadline and wait for the pixels.
      const pending = this.requests.get(msg.requestId);
      if (!pending) return;
      this.consecutiveFailures = 0;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        this.settleRequest(msg.requestId, null);
        this.noteFailure();
      }, this.encodeTimeoutMs);
      return;
    }
    if (msg.type === 'frame-response') {
      const pending = this.requests.get(msg.requestId);
      if (!pending) return; // late reply after timeout — already handled
      // Any answer — even "no qualifying frame" — proves the worker is alive.
      this.consecutiveFailures = 0;
      const value = (!msg.ok || !msg.png) ? null : {
        mode: 'fullscreen',
        png: Buffer.from(msg.png),
        size: { width: msg.width, height: msg.height },
        display: pending.display,
        startedAt: msg.startedAt,
        capturedAt: msg.capturedAt,
        source: 'stream',
      };
      this.settleRequest(msg.requestId, value);
    }
  }

  /**
   * Resolve one pending request and clean it up. When the backend is
   * draining (stop() was called while requests were still in flight), the
   * last settled request triggers the deferred worker teardown — this is
   * what lets clicks queued at finish time still receive their frames
   * instead of being cancelled to null.
   */
  settleRequest(requestId, value) {
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(value);
    if (this.draining && this.requests.size === 0) this.finalizeTeardown();
  }

  /**
   * Frame for one click, selected in the worker under the given strictness.
   * Resolves null when no frame qualifies (caller falls back) — and also on
   * timeout, which additionally counts toward unhealthiness.
   */
  frameForClick({ clickPos = null, clickAt = Date.now(), strict = true } = {}) {
    if (!this.active || !this.host) return Promise.resolve(null);
    const displays = [...this.streams.values()].filter((s) => s.ready).map((s) => s.display);
    const display = clickPos ? displayForDipPoint(clickPos, displays) : (displays[0] || null);
    if (!display) return Promise.resolve(null);
    // Never serve a click from another monitor's stream: if the clicked
    // display has no ready stream, a "nearest display" frame would show the
    // wrong screen entirely and the marker fractions would be meaningless.
    // Resolve null instead so the caller's fallback captures the right one.
    if (clickPos && !pointInBounds(clickPos, display.bounds)) return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const pending = { resolve, display, timer: null };
      pending.timer = setTimeout(() => {
        this.settleRequest(requestId, null);
        this.noteFailure();
      }, this.ackTimeoutMs);
      this.requests.set(requestId, pending);
      this.hostSend({
        type: 'frame-request',
        requestId,
        displayId: display.id,
        clickAt,
        strict,
      });
    });
  }

  noteFailure() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return;
    const notify = this.onUnhealthy;
    this.stop({ immediate: true });
    if (notify) notify('frame requests timing out');
  }

  /**
   * Stop the backend. By default this *drains*: it stops accepting new
   * requests but keeps the worker alive so frames already selected for
   * queued clicks finish encoding and resolve — without this, finishing a
   * recording right after a fast click burst cancels every still-encoding
   * frame to null and those clicks are lost ("only two screenshots saved").
   * Pass { immediate: true } to abandon in-flight requests (used when the
   * worker is already unhealthy).
   */
  stop({ immediate = false } = {}) {
    this.active = false;
    for (const check of [...this.startWaiters]) check();
    this.startWaiters = [];
    if (immediate) {
      for (const [, pending] of this.requests) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      this.requests.clear();
      this.finalizeTeardown();
      return;
    }
    if (this.requests.size === 0) {
      this.finalizeTeardown();
      return;
    }
    // Let pending requests resolve naturally (their own encode timers still
    // bound the wait); finalizeTeardown fires from settleRequest when the
    // last one completes.
    this.draining = true;
  }

  finalizeTeardown() {
    this.draining = false;
    this.streams.clear();
    if (this.host) {
      try { this.host.destroy(); } catch { /* already gone */ }
      this.host = null;
    }
  }
}

/** Match each display to its desktopCapturer screen source by display_id. */
function pairDisplaysToSources(displays, sources) {
  const screens = (sources || []).filter((s) => s && typeof s.id === 'string' && s.id.startsWith('screen:'));
  const pairs = [];
  const used = new Set();
  for (const display of displays || []) {
    let source = screens.find((s) => !used.has(s.id) && String(s.display_id) === String(display.id));
    if (!source && displays.length === 1 && screens.length === 1) {
      // Single display, single source: some platforms leave display_id empty.
      source = screens[0];
    }
    if (!source) continue;
    used.add(source.id);
    pairs.push({ display, sourceId: source.id });
  }
  return pairs;
}

/**
 * Production worker host: a hidden BrowserWindow running the capture-worker
 * page. Lazy-required Electron so this module stays loadable under node for
 * unit tests.
 */
async function createElectronHost(onEvent) {
  // eslint-disable-next-line global-require
  const { BrowserWindow, ipcMain } = require('electron');
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'capture-worker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The worker must keep sampling while hidden — throttling a hidden
      // window is exactly the wrong default for a frame recorder.
      backgroundThrottling: false,
    },
  });
  const listener = (event, msg) => {
    if (event.sender === win.webContents) onEvent(msg);
  };
  ipcMain.on('capture-worker:event', listener);
  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'capture-worker.html'));
  } catch (err) {
    ipcMain.removeListener('capture-worker:event', listener);
    if (!win.isDestroyed()) win.destroy();
    throw err;
  }
  return {
    send(msg) {
      if (!win.isDestroyed()) win.webContents.send('capture-worker:command', msg);
    },
    destroy() {
      ipcMain.removeListener('capture-worker:event', listener);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = {
  StreamCaptureBackend,
  createElectronHost,
  pairDisplaysToSources,
  DEFAULT_SAMPLE_MS,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_ENCODE_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
};
