'use strict';

const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { desktopCapturer, screen, BrowserWindow, nativeImage, Tray, Menu, Notification } = require('electron');
const { expandPlaceholders } = require('../core/placeholders');
const raster = require('../core/raster');
const { encodePng } = require('../core/png');
const {
  selectFrameForClick,
  frameUsableForClick,
  pointInBounds,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_START_SLACK_MS,
} = require('./click-frames');
const { physicalToDip } = require('./coords');

/**
 * Capture service: full-screen, active-window, and region capture, plus a
 * click-marker annotation at the click position and a capture session
 * (start/pause/resume/finish).
 *
 * A session captures continuously, with three triggers layered by what the
 * platform supports:
 *  - click-capture via an OS adapter (xinput on X11, a low-level mouse hook
 *    on Windows),
 *  - a global hotkey (unreliable on some Wayland compositors),
 *  - interval auto-capture as the always-works fallback.
 *
 * Click captures are served from one of two frame recorders:
 *  - the stream backend (app/stream-backend.js): a hidden worker window
 *    samples a desktop media stream per display into a timestamped ring
 *    buffer, entirely off the main process. This is the preferred path —
 *    the main-process event loop stays free, so OS click events arrive on
 *    time, and the tight sampling cadence keeps a genuinely fresh pre-click
 *    frame available for every click;
 *  - the legacy in-process frame loop below, kept as the fallback when
 *    streams can't start (portal-less Wayland, exotic drivers).
 *
 * Either way the pairing rule is the same (click-frames.js): in strict mode
 * a click only ever gets a frame captured at or before the click — never one
 * whose grab started after it.
 *
 * Note: under Wayland/WSLg, screen capture may require portal support; all
 * failures surface as { ok: false, reason } instead of crashing.
 */

// Leading-edge click debounce: the first click of a button is captured, and
// further clicks of that button within this window of the last *accepted*
// click are ignored. This collapses accidental fast / double clicks into one
// step, while any two deliberate clicks spaced more than the window apart
// each register. Tunable via capture.clickDebounceMs; this is only the
// default when the setting is absent.
const DEFAULT_CLICK_DEBOUNCE_MS = 200;
// How long a Linux raw button event waits for its regular twin (the
// representation that carries root coordinates) before firing without them.
const LINUX_CLICK_TWIN_MS = 25;
// Longest the window stays visible warming up the recorder at recording
// start. A slow capture-stream start (Windows can take several seconds) must
// not keep the window up and recording un-armed indefinitely.
const WARMUP_MAX_MS = 1500;
// Idle gap between legacy frame-loop grabs. Must stay well above zero:
// grabbing back-to-back starves the main-process event loop, which delays
// delivery of click events from the OS watcher by whole seconds. (The
// stream backend exists precisely because of this constraint.)
const FRAME_LOOP_IDLE_MS = 200;
// A buffered frame older than this is too stale to pass off as "the screen
// at the instant of the click". Shared with click-frames.js.
const CLICK_FRAME_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
// How long a click waits for the in-flight grab before falling back to a
// one-off fresh shot.
const CLICK_FRAME_WAIT_MS = 2000;
// Balanced (non-strict) mode only: a loop grab that started at most this
// long after the click is still accepted. Strict mode never does this.
const CLICK_FRAME_START_SLACK_MS = DEFAULT_START_SLACK_MS;
const CLICK_CAPTURE_HIDE_DELAY_MS = 25;
// Frames hold raw images (~20MB each at 2880x1800), so keep the history
// window wide enough to outlast any processing hiccup but the count low.
const RECENT_FRAME_RETENTION_MS = 4000;
const RECENT_FRAME_LIMIT = 4;
// The click that stops/pauses a session via the tray reaches the OS hook at
// almost the same instant the tray handler fires. We discard at most that
// one click — and only when it matches the recorded gesture in *both* time
// and position, so a fast workflow click that merely happens to land near
// the stop is never mistaken for the stop itself.
const SESSION_STOP_CLICK_WINDOW_MS = 700;
const SESSION_STOP_CLICK_RADIUS_PX = 8;

// Per-click diagnostics, enabled with STEPFORGE_CAPTURE_LOG=1. Cheap enough
// to leave in: one line per click/frame decision, nothing per frame-loop tick.
const CAPTURE_LOG = Boolean(process.env.STEPFORGE_CAPTURE_LOG);
function clog(...args) {
  if (CAPTURE_LOG) console.log('[capture]', ...args);
}

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

class CaptureService {
  constructor({ store, settings, getWindow, notify, screenApi = screen }) {
    this.store = store;
    this.settings = settings;
    this.getWindow = getWindow;
    this.notify = notify;
    // Injectable for tests; the click/coordinate paths must never reach for
    // the global `screen` directly so coordinate handling stays testable.
    this.screen = screenApi;
    this.session = null; // { guideId, paused, count, intervalSec }
    this.intervalTimer = null;
    this.clickWatcher = null;
    this.frameLoopTimer = null;
    this.frameLoopRunning = false;
    this.frameWaiters = [];
    this.latestFrame = null;
    this.clickWatcherBuf = '';
    this.clickWatcherErrTail = '';
    this.linuxEvent = null; // event block currently being parsed
    this.pendingRawClick = null; // raw press waiting for its coordinate twin
    this.clickQueue = Promise.resolve();
    this.frameLoopInFlight = false;
    this.frameLoopGrabStartedAt = null;
    this.recentFrames = [];
    this.shooting = false;
    this.lastAcceptedClickByButton = new Map();
    this.streamBackend = null;
    this.streamBackendStarting = false;
    this.captureGen = 0; // bumped on stop to invalidate in-flight backend starts
    // True only while a resume is warming up (window still visible, buffer
    // not yet primed). Clicks are ignored until it clears — see armRecording.
    this.warmingUp = false;
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
        clickFrameSource: this.streamBackend ? 'stream' : (this.frameLoopRunning ? 'loop' : 'idle'),
        strictClickFrames: this.strictClickFrames(),
      }
      : { active: false, clickCaptureAvailable: this.clickCaptureAvailable() };
  }

  /**
   * Strict is the default: a stored step must never show the screen *after*
   * its click (a frame whose grab started post-click can already contain the
   * click's effects). The setting exists as an explicit escape hatch for
   * machines where capture is too slow to keep pre-click frames buffered —
   * there, the legacy slack heuristics trade accuracy for fewer fresh-shot
   * fallbacks.
   */
  strictClickFrames() {
    return this.settings.get('capture.strictClickFrames') !== false;
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
    // Sessions start paused: nothing hides and no capturing happens until
    // the user explicitly presses "Start recording" in the capture bar, so
    // New Capture never makes the window vanish out from under them.
    this.session = { guideId, paused: true, count: 0, intervalSec: interval };
    this.sessionNotificationShown = false;
    if (this.settings.get('capture.captureOutsideClicks') !== false) this.startClickWatcher();
    this.applyInterval();
    this.notify('capture:state', this.state());

    // (Skipped for the dev screenshot hook, which needs a visible page.)
    if (!process.env.STEPFORGE_SCREENSHOT) {
      this.createSessionTray();
      const win = this.getWindow();
      // Remember whether the window was visible when the session was set
      // up — that's what `togglePause` uses to decide whether to tuck the
      // app away once the user actually starts recording.
      this.hiddenForSession = Boolean(win && !win.isDestroyed() && win.isVisible());
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
            click: () => { this.noteUiStopGesture(); this.togglePause(); rebuild(); },
          },
          {
            label: 'Open StepForge (pauses capture)',
            click: () => {
              this.noteUiStopGesture();
              this.togglePause(true);
              this.showWindow();
              rebuild();
            },
          },
          { type: 'separator' },
          { label: 'Finish session', click: () => { this.noteUiStopGesture(); this.finishSession(); } },
        ]));
      };
      rebuild();
      this.rebuildTrayMenu = rebuild;
      this.tray.on('click', () => {
        this.noteUiStopGesture();
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

  /**
   * Record that the user just stopped/paused capture from StepForge's own UI
   * (tray icon or its menu). The physical click that did so is also seen by
   * the OS hook and would otherwise queue as a workflow step; isStopGesture
   * uses this to discard exactly that one click — matched by position, not
   * just time, so a real fast click elsewhere is never lost.
   */
  noteUiStopGesture() {
    let pos = null;
    try { pos = this.screen.getCursorScreenPoint(); } catch { pos = null; }
    this.uiStopGesture = { at: Date.now(), pos };
  }

  /** True when a queued click is the tray gesture that stopped the session. */
  isStopGesture(clickPos, clickAt) {
    const g = this.uiStopGesture;
    if (!g) return false;
    if (Math.abs((clickAt || Date.now()) - g.at) > SESSION_STOP_CLICK_WINDOW_MS) return false;
    // No position to compare (e.g. cursor read failed): fall back to the
    // time window alone, but only consume the gesture once.
    if (!g.pos || !clickPos) {
      this.uiStopGesture = null;
      return true;
    }
    const near = Math.abs(clickPos.x - g.pos.x) <= SESSION_STOP_CLICK_RADIUS_PX
      && Math.abs(clickPos.y - g.pos.y) <= SESSION_STOP_CLICK_RADIUS_PX;
    if (near) this.uiStopGesture = null; // one stop click per gesture
    return near;
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
    // Starting/resuming tucks the window away again for clean shots (after
    // a brief delay so the user sees it happen) and starts the frame
    // recorder that serves click captures. Pausing stops it and discards
    // buffered frames, so a resume can never serve a pre-pause screen.
    if (wasPaused && !this.session.paused) {
      this.armRecording();
    } else if (!wasPaused && this.session.paused) {
      this.warmingUp = false; // cancel any in-flight warmup
      this.stopFrameLoop();
      this.stopClickFrameBackend();
    }
    if (this.rebuildTrayMenu) this.rebuildTrayMenu();
    this.notify('capture:state', this.state());
  }

  /**
   * Bring a session from paused to recording. The order matters for the
   * first click: the frame recorder is warmed up *while the window is still
   * visible*, then the window is hidden. Warming after the hide (the old
   * order) left a ~1s gap where the worker had no buffered frame yet, so the
   * first click fell back to a post-click fresh shot — "the first screenshot
   * is late". By the time the window tucks away here, frames are already
   * being buffered, so the first click is served a pre-click frame like
   * every other.
   */
  armRecording() {
    const win = this.getWindow();
    const wantHide = Boolean(this.hiddenForSession && win && !win.isDestroyed());
    const recorderWanted = this.settings.get('capture.captureOutsideClicks') !== false
      && this.clickCaptureAvailable();
    // Recording is not "live" until the window is hidden and the buffer is
    // primed. While warming up, the window is still visible and over the
    // user's work, so clicks in this period are ignored (onOsClick checks
    // warmingUp) instead of being skipped erratically or shot post-click —
    // the bug that made a restarted recording "stop after one click".
    this.warmingUp = Boolean(wantHide || recorderWanted);
    const settleMs = Number(this.settings.get('capture.postHideSettleMs'));
    const run = async () => {
      if (!this.session || this.session.paused) { this.warmingUp = false; return; }
      const startedAt = Date.now();
      if (recorderWanted) {
        // Warm the recorder, but never let a slow backend start (it waits up
        // to several seconds for the capture stream) keep the window visible
        // and recording un-armed. Cap the wait; if it isn't ready by then,
        // hide anyway and let the first click or two take the fresh-shot
        // fallback while the stream finishes coming up in the background.
        const warm = this.startClickFrameBackend().catch(() => {});
        let capTimer = null;
        const cap = new Promise((r) => { capTimer = setTimeout(r, WARMUP_MAX_MS); });
        await Promise.race([warm, cap]);
        if (capTimer) clearTimeout(capTimer);
        if (!this.session || this.session.paused) { this.warmingUp = false; return; }
      }
      // Keep the window visible briefly so the user sees the transition even
      // when warmup was instant; warmup time counts toward this.
      const minVisibleMs = wantHide ? 400 : 0;
      const elapsed = Date.now() - startedAt;
      if (elapsed < minVisibleMs) {
        await new Promise((r) => setTimeout(r, minVisibleMs - elapsed));
        if (!this.session || this.session.paused) { this.warmingUp = false; return; }
      }
      if (wantHide && win && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        // Let a couple of frames of the now-unobscured screen land before
        // the user's first click, so that frame shows their work, not the
        // app window that was just dismissed.
        await new Promise((r) => setTimeout(r, Number.isFinite(settleMs) ? settleMs : 150));
      }
      // Window hidden and buffer primed — clicks now count.
      if (!process.env.STEPFORGE_SCREENSHOT && !this.sessionNotificationShown) {
        try {
          new Notification({
            title: 'StepForge is recording',
            body: 'Use the red tray icon to pause or finish capture.',
          }).show();
          this.sessionNotificationShown = true;
        } catch { /* notifications unavailable on this desktop */ }
      }
      this.warmingUp = false;
    };
    run().catch(() => { this.warmingUp = false; });
  }

  finishSession() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.warmingUp = false;
    this.stopClickWatcher();
    this.stopFrameLoop();
    this.stopClickFrameBackend();
    this.destroySessionTray();
    this.session = null;
    this.sessionNotificationShown = false;
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
    const cur = this.screen.getCursorScreenPoint();
    const b = win.getBounds();
    return cur.x >= b.x && cur.x <= b.x + b.width && cur.y >= b.y && cur.y <= b.y + b.height;
  }

  /** One capture inside the active session (hotkey/click/interval/manual). */
  async sessionCapture(trigger = 'hotkey', clickPos = null, clickMeta = null) {
    // A click that was registered while recording carries its guide id
    // (see enqueueClickCapture) and must become a step even if the session
    // was paused or finished while it sat behind slower clicks in the
    // queue. Dropping queued clicks at stop time is how "I clicked five
    // times and only got two steps" happens on hosts with slow encodes.
    const queuedClickGuide = trigger === 'click' && clickMeta && clickMeta.guideId
      ? clickMeta.guideId
      : null;
    if (!this.session || this.session.paused) {
      if (!queuedClickGuide) return { ok: false, reason: 'no active capture session' };
    } else if (trigger !== 'manual' && this.userIsInApp()) {
      // Automatic triggers stand down while the user is in StepForge, so the
      // app stays clickable mid-session and never screenshots itself.
      return { ok: false, reason: 'skipped — StepForge is focused' };
    }

    // Clicks are served from the frame recorder: the chosen frame was
    // captured at (or moments before) the click instant, so the background
    // matches what the user clicked on. A click that lands while a grab is
    // in flight waits for that frame instead of being dropped, so fast
    // clicking still yields one step per click.
    if (trigger === 'click') {
      const clickAt = clickMeta && Number.isFinite(clickMeta.at) ? clickMeta.at : Date.now();
      // Prefer the frame the click was paired with at event time (see
      // enqueueClickCapture); ask now only when no eager pairing happened.
      const frame = clickMeta && clickMeta.framePromise
        ? await clickMeta.framePromise
        : await this.frameForClick(clickPos, clickAt);
      const sessionLive = this.session && !this.session.paused;
      const guideId = sessionLive ? this.session.guideId : queuedClickGuide;
      if (!guideId) return { ok: false, reason: 'no active capture session' };
      // The tray gesture that stopped the session is itself a hook click in
      // the queue — storing it would append a junk step of the menu. Discard
      // only that one click, matched by position so a fast workflow click is
      // never collateral damage.
      if (!sessionLive && this.isStopGesture(clickPos, clickAt)) {
        clog('click@', clickAt, 'discarded — it triggered the session stop');
        return { ok: false, reason: 'click stopped the session' };
      }
      if (frame) {
        clog('click@', clickAt, 'frame', frame.source || 'loop',
          'started', frame.startedAt - clickAt, 'ms, captured', frame.capturedAt - clickAt, 'ms rel. click');
        const result = this.storeFrameAsStep(guideId, frame.mode, frame, clickPos);
        if (result.ok) this.noteStepAdded(result.step, trigger, guideId);
        return result;
      }
      // No usable frame: fall through to a one-off fresh shot — but only
      // while still recording. After a stop, a fresh shot would show
      // whatever replaced the user's workflow on screen.
      clog('click@', clickAt, 'no frame qualified — falling back to a fresh (post-click) shot');
      if (!sessionLive) return { ok: false, reason: 'session ended before the fallback shot' };
    }

    if (this.shooting) return { ok: false, reason: 'capture already in progress' };
    this.shooting = true;
    try {
      const mode = this.settings.get('capture.mode') || 'fullscreen';
      const grabMode = mode === 'region' ? 'fullscreen' : mode;
      const finalResult = await this.shoot({
        guideId: this.session.guideId,
        mode: grabMode,
        delayMs: 0,
        hideWindowDelayMs: trigger === 'click' ? CLICK_CAPTURE_HIDE_DELAY_MS : null,
        refocus: false, // don't steal focus from the app the user is documenting
        clickPos,
      });
      if (finalResult.ok) this.noteStepAdded(finalResult.step, trigger);
      return finalResult;
    } finally {
      this.shooting = false;
    }
  }

  noteStepAdded(step, trigger, guideId = null) {
    // Steps from queued clicks can land after the session object is gone.
    if (this.session) this.session.count += 1;
    this.notify('capture:added', {
      guideId: guideId || (this.session && this.session.guideId),
      step,
      trigger,
    });
    this.notify('capture:state', this.state());
    if (this.rebuildTrayMenu) this.rebuildTrayMenu(); // refresh step counter
  }

  hotkeyCapture() {
    return this.sessionCapture('hotkey');
  }

  // ---- click-triggered capture --------------------------------------------

  /**
   * Fallback frame recorder: a continuous screen-grab loop in the main
   * process, used only when the stream backend can't run. It keeps the most
   * recent frames buffered so a click can be served from a frame grabbed at
   * (or moments before) the instant of the click — a fresh grab started
   * after the click would land hundreds of ms late and show the click's
   * effects instead of what the user clicked on. Its cadence is capped at
   * FRAME_LOOP_IDLE_MS because tighter grabbing here starves the event loop
   * and delays the very click events it serves.
   */
  startFrameLoop() {
    if (this.frameLoopRunning) return;
    this.frameLoopRunning = true;
    const tick = async () => {
      if (!this.frameLoopRunning) return;
      if (!this.session || this.session.paused) {
        this.frameLoopRunning = false;
        this.frameLoopInFlight = false;
        return;
      }
      try {
        if (!this.shooting) {
          this.frameLoopInFlight = true;
          this.frameLoopGrabStartedAt = Date.now();
          const mode = this.settings.get('capture.mode') || 'fullscreen';
          const grabMode = mode === 'region' ? 'fullscreen' : mode;
          const frame = await this.captureCurrentFrame(grabMode, null, this.frameLoopGrabStartedAt);
          if (this.frameLoopRunning) this.acceptFrame(frame);
        }
      } catch {
        // Grab failures are fine — clicks fall back to a one-off fresh shot.
      } finally {
        this.frameLoopInFlight = false;
        this.frameLoopGrabStartedAt = null;
        if (this.frameLoopRunning && this.session && !this.session.paused) {
          this.frameLoopTimer = setTimeout(tick, FRAME_LOOP_IDLE_MS);
        }
      }
    };
    this.frameLoopTimer = setTimeout(tick, 0);
  }

  /** Store a grabbed frame and hand it to any clicks waiting on it. */
  acceptFrame(frame) {
    this.latestFrame = frame;
    this.recentFrames.push(frame);
    const cutoff = Date.now() - RECENT_FRAME_RETENTION_MS;
    this.recentFrames = this.recentFrames
      .filter((f) => f && f.capturedAt >= cutoff)
      .slice(-RECENT_FRAME_LIMIT);
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const resolve of waiters) resolve(frame);
  }

  /** Resolves with the next frame the loop grabs (null on timeout/stop). */
  nextFrame(timeoutMs) {
    return new Promise((resolve) => {
      const entry = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w !== entry);
        resolve(null);
      }, timeoutMs);
      this.frameWaiters.push(entry);
    });
  }

  stopFrameLoop() {
    if (this.frameLoopTimer) {
      clearTimeout(this.frameLoopTimer);
      this.frameLoopTimer = null;
    }
    this.frameLoopRunning = false;
    this.frameLoopGrabStartedAt = null;
    this.latestFrame = null;
    this.recentFrames = [];
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const resolve of waiters) resolve(null);
  }

  /**
   * Frame representing the screen at the instant of one click.
   *
   * Order of preference:
   *  1. the stream backend's ring buffer (off-main-process, tight cadence);
   *  2. the legacy loop's buffered frames;
   *  3. waiting for the loop grab that was already in flight when the user
   *     clicked.
   * Selection semantics live in click-frames.js. In strict mode every path
   * obeys the same rule — never a frame whose grab started after the click —
   * and when nothing qualifies this returns null so the caller takes the
   * *explicit* fresh-shot fallback rather than silently passing a post-click
   * frame off as the click-time screen.
   */
  async frameForClick(clickPos = null, clickAt = Date.now()) {
    const mode = this.settings.get('capture.mode') || 'fullscreen';
    const grabMode = mode === 'region' ? 'fullscreen' : mode;
    const clickTime = Number.isFinite(clickAt) ? clickAt : Date.now();
    // Click lead: prefer a frame captured a little *before* the hook
    // timestamp. The hook fires on button-down, but the visible UI often
    // starts reacting within a frame or two (hover→press states, the cursor
    // settling) and capture-stream pixels lag the real screen slightly, so a
    // frame timestamped right at the click can still show the click's onset.
    // The lead is a *preference*: selection falls back to any pre-click
    // frame when none is old enough, so it never forces a post-click fresh
    // shot. Tunable via capture.clickLeadMs.
    const leadMs = Math.max(0, Number(this.settings.get('capture.clickLeadMs')) || 0);
    const strict = this.strictClickFrames();
    const opts = {
      clickAt: clickTime,
      leadMs,
      clickPos,
      mode: grabMode,
      strict,
      maxAgeMs: CLICK_FRAME_MAX_AGE_MS,
      startSlackMs: CLICK_FRAME_START_SLACK_MS,
    };

    if (this.streamBackend && this.streamBackend.isActive() && grabMode === 'fullscreen') {
      const frame = await this.streamBackend.frameForClick({ clickPos, clickAt: clickTime, strict, leadMs });
      if (frame) return frame;
      // No qualifying frame (or the backend just went unhealthy): fall
      // through to the loop buffer / fresh-shot fallbacks below.
    }

    const buffered = selectFrameForClick(
      [...this.recentFrames, this.latestFrame].filter((f, i, arr) => f && arr.indexOf(f) === i),
      opts,
    );
    if (buffered) return buffered;
    if (!this.frameLoopRunning) return null;

    if (strict) {
      // Only a grab already in flight when the user clicked can still
      // qualify: its pixels predate the click even though it completes
      // after. Any grab starting later is post-click by definition, so
      // don't wait around for one — return immediately and let the caller
      // take the fresh-shot fallback.
      const inFlightStartedBeforeClick = this.frameLoopInFlight
        && Number.isFinite(this.frameLoopGrabStartedAt)
        && this.frameLoopGrabStartedAt <= clickTime;
      if (!inFlightStartedBeforeClick) return null;
      const next = await this.nextFrame(CLICK_FRAME_WAIT_MS);
      return frameUsableForClick(next, { ...opts, allowInFlight: true }) ? next : null;
    }

    // Balanced (legacy) mode: wait for the next loop frame and accept it if
    // its grab started within the slack window after the click.
    const deadline = Date.now() + CLICK_FRAME_WAIT_MS;
    while (this.frameLoopRunning && Date.now() < deadline) {
      const next = await this.nextFrame(Math.max(1, deadline - Date.now()));
      if (frameUsableForClick(next, { ...opts, allowInFlight: true })) return next;
      if (next && Number.isFinite(next.startedAt)
        && next.startedAt > clickTime + CLICK_FRAME_START_SLACK_MS) {
        // Grabs only get later from here; let the fresh-shot path handle it.
        return null;
      }
    }
    return null;
  }

  // ---- click-frame backends -------------------------------------------------

  /**
   * Bring up the frame recorder for a recording run. The stream backend is
   * the architecture path (capture entirely off the main process); the
   * in-process frame loop is the fallback when streams can't start — and the
   * automatic degradation target if the worker stops answering mid-session.
   */
  async startClickFrameBackend() {
    const mode = this.settings.get('capture.mode') || 'fullscreen';
    // The worker streams screens; window-mode grabs need the loop's
    // source-filtering logic.
    if (this.settings.get('capture.streamCapture') === false || mode === 'window') {
      this.startFrameLoop();
      return;
    }
    if (this.streamBackend || this.streamBackendStarting) return;
    // Generation token: a stop/finish/pause bumps it. If it changes while
    // this async start is in flight (e.g. the user finishes and restarts
    // before a slow start resolves), the backend we built belongs to a dead
    // session — discard it instead of installing it, and never leave
    // streamBackendStarting stuck so the new session can start its own.
    const gen = this.captureGen;
    this.streamBackendStarting = true;
    try {
      // eslint-disable-next-line global-require
      const { StreamCaptureBackend, createElectronHost } = require('./stream-backend');
      const backend = new StreamCaptureBackend({
        createHost: createElectronHost,
        onUnhealthy: () => this.degradeToFrameLoop(),
      });
      const displays = this.screen.getAllDisplays();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }, // ids only — skip thumbnail work
      });
      const ok = await backend.start({
        displays,
        sources: sources.map((s) => ({ id: s.id, display_id: s.display_id })),
        sampleMs: this.settings.get('capture.frameSampleMs') || 100,
      });
      const stale = gen !== this.captureGen;
      if (!ok || stale || !this.session || this.session.paused) {
        backend.stop();
        if (!stale && this.session && !this.session.paused) {
          console.error('[stepforge] stream capture backend failed to start — using in-process frame loop');
          this.startFrameLoop();
        }
        return;
      }
      this.streamBackend = backend;
      clog('stream capture backend active');
      this.notify('capture:state', this.state());
    } catch (err) {
      if (gen === this.captureGen && this.session && !this.session.paused) {
        console.error(`[stepforge] stream capture backend error (${err && err.message}) — using in-process frame loop`);
        this.startFrameLoop();
      }
    } finally {
      if (gen === this.captureGen) this.streamBackendStarting = false;
    }
  }

  stopClickFrameBackend() {
    // Invalidate any in-flight start (see captureGen above) and free the
    // guard so the next session can start a fresh backend immediately.
    this.captureGen += 1;
    this.streamBackendStarting = false;
    if (!this.streamBackend) return;
    const backend = this.streamBackend;
    this.streamBackend = null;
    backend.stop();
  }

  /**
   * The worker stopped answering frame requests. Capture must not silently
   * stop mid-session: drop the backend and run the in-process loop for the
   * rest of the recording.
   */
  degradeToFrameLoop() {
    this.streamBackend = null;
    console.error('[stepforge] stream capture backend unhealthy — falling back to in-process frame loop');
    if (this.session && !this.session.paused) this.startFrameLoop();
    this.notify('capture:state', this.state());
  }

  startClickWatcher() {
    this.stopClickWatcher();
    try {
      this.clickWatcherBuf = '';
      this.linuxEvent = null;
      if (process.platform === 'linux' && hasBinary('xinput')) {
        // Stream raw button events from the X server; one capture per press.
        // xinput block-buffers stdout when piped, so a press event can sit
        // in its buffer until later motion events flush it — by then the
        // cursor read in onOsClick lands where the mouse moved *after* the
        // click. stdbuf -oL forces line-buffering so events (and the cursor
        // read) line up with the actual click instant.
        const argv = hasBinary('stdbuf')
          ? ['stdbuf', '-oL', 'xinput', 'test-xi2', '--root']
          : ['xinput', 'test-xi2', '--root'];
        this.clickWatcher = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
        this.clickWatcher.stdout.on('data', (chunk) => {
          this.ingestClickWatcherChunk(chunk.toString(), 'linux');
        });
      } else if (process.platform === 'win32') {
        // Use a low-level Windows mouse hook instead of polling
        // GetAsyncKeyState. The low bit from GetAsyncKeyState can be consumed
        // by other processes and a polling loop can miss short clicks under
        // load; WH_MOUSE_LL gives us one event for each button-down, with the
        // hook-time cursor position and timestamp.
        const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class SFMouseHook {
  private const int WH_MOUSE_LL = 14;
  private const int WM_LBUTTONDOWN = 0x0201;
  private const int WM_RBUTTONDOWN = 0x0204;
  private const int WM_MBUTTONDOWN = 0x0207;
  private const int WM_XBUTTONDOWN = 0x020B;
  private const long UnixEpochMilliseconds = 62135596800000L;

  private static IntPtr hook = IntPtr.Zero;
  private static LowLevelMouseProc proc = HookCallback;
  private static readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
  private static readonly AutoResetEvent signal = new AutoResetEvent(false);

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT {
    public int x;
    public int y;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSLLHOOKSTRUCT {
    public POINT pt;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public POINT pt;
  }

  private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool UnhookWindowsHookEx(IntPtr hhk);

  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr GetModuleHandle(string lpModuleName);

  [DllImport("user32.dll")]
  private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

  [DllImport("user32.dll")]
  private static extern bool TranslateMessage(ref MSG lpMsg);

  [DllImport("user32.dll")]
  private static extern IntPtr DispatchMessage(ref MSG lpMsg);

  [DllImport("user32.dll")]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }

    Thread writer = new Thread(WriterLoop);
    writer.IsBackground = true;
    writer.Start();

    hook = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    Console.Out.WriteLine("READY");
    Console.Out.Flush();

    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }

    UnhookWindowsHookEx(hook);
  }

  private static void WriterLoop() {
    while (true) {
      signal.WaitOne();
      string line;
      while (queue.TryDequeue(out line)) {
        Console.Out.WriteLine(line);
      }
      Console.Out.Flush();
    }
  }

  private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int message = wParam.ToInt32();
      string button = ButtonName(message, lParam);
      if (button != null) {
        MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
        long unixMs = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond - UnixEpochMilliseconds;
        queue.Enqueue("CLICK " + data.pt.x + " " + data.pt.y + " " + button + " " + unixMs);
        signal.Set();
      }
    }
    return CallNextHookEx(hook, nCode, wParam, lParam);
  }

  private static string ButtonName(int message, IntPtr lParam) {
    if (message == WM_LBUTTONDOWN) return "left";
    if (message == WM_RBUTTONDOWN) return "right";
    if (message == WM_MBUTTONDOWN) return "middle";
    if (message == WM_XBUTTONDOWN) {
      MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
      uint xButton = (data.mouseData >> 16) & 0xffff;
      return xButton == 1 ? "x1" : "x2";
    }
    return null;
  }
}
'@
[SFMouseHook]::Run()
`;
        this.clickWatcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        this.clickWatcher.stdout.on('data', (chunk) => {
          this.ingestClickWatcherChunk(chunk.toString(), 'win32');
        });
      }
      if (this.clickWatcher) {
        const child = this.clickWatcher;
        this.clickWatcherErrTail = '';
        if (child.stderr) {
          child.stderr.on('data', (chunk) => {
            this.clickWatcherErrTail = String(chunk).slice(-400);
          });
        }
        const lost = (reason) => {
          if (this.clickWatcher !== child) return; // stopped deliberately
          this.clickWatcher = null;
          this.handleClickWatcherLoss(reason);
        };
        child.on('error', (err) => lost(err && err.message));
        child.on('exit', (code) => lost(`exited with code ${code}`));
      }
    } catch {
      this.clickWatcher = null;
    }
  }

  /**
   * The watcher process died mid-session (crashed X server, PowerShell
   * blocked by policy, …). Captures must not silently stop: log why, switch
   * the session to interval captures, and tell the UI.
   */
  handleClickWatcherLoss(reason) {
    this.linuxEvent = null;
    this.discardPendingRawClick();
    const detail = [reason, this.clickWatcherErrTail].filter(Boolean).join(' — ');
    console.error(`[stepforge] click watcher stopped${detail ? `: ${detail}` : ''}`);
    if (!this.session) return;
    if (!this.session.intervalSec) {
      this.session.intervalSec = this.settings.get('capture.autoIntervalSec') || 5;
      this.applyInterval();
    }
    this.notify('capture:state', this.state());
  }

  stopClickWatcher() {
    if (this.clickWatcher) {
      try { this.clickWatcher.kill(); } catch { /* already gone */ }
      this.clickWatcher = null;
    }
    this.clickWatcherBuf = '';
    this.linuxEvent = null;
    this.discardPendingRawClick();
    this.lastAcceptedClickByButton.clear();
  }

  /**
   * Buffer stdout chunks and only parse complete lines: a chunk boundary
   * can split an event line in half, which used to corrupt press/release
   * parsing and swallow clicks.
   */
  ingestClickWatcherChunk(chunk, platform = process.platform) {
    this.clickWatcherBuf += String(chunk);
    const cut = this.clickWatcherBuf.lastIndexOf('\n');
    if (cut === -1) return;
    const complete = this.clickWatcherBuf.slice(0, cut);
    this.clickWatcherBuf = this.clickWatcherBuf.slice(cut + 1);
    this.processClickWatcherData(complete, platform);
  }

  processClickWatcherData(text, platform = process.platform) {
    const lines = String(text).split(/\r?\n/);
    if (platform === 'linux') {
      // xinput test-xi2 --root prints each event as a multi-line block:
      //
      //   EVENT type 4 (ButtonPress)        EVENT type 15 (RawButtonPress)
      //       device: 11 (10)                   device: 11 (11)
      //       detail: 1                         detail: 1
      //       root: 644.52/343.55               valuators: …
      //
      // Regular (non-raw) blocks carry the event-time root coordinates —
      // exactly what the click marker needs, because a cursor read at parse
      // time drifts whenever delivery is delayed or the pointer keeps
      // moving after the click. Raw blocks have no coordinates, but on many
      // servers they are the only representation delivered for the root
      // window, so both kinds must fire. One physical press can produce
      // *both* representations; that duplication is resolved structurally
      // in fireLinuxClick (raw press briefly waits for its regular twin and
      // they merge into one click), never by a time-only debounce that
      // could swallow legitimate fast clicks.
      for (const line of lines) {
        if (!line) continue;
        const header = /EVENT type \d+ \(([A-Za-z]+)\)/.exec(line);
        if (header) {
          this.finishLinuxEvent();
          const name = header[1];
          this.linuxEvent = /ButtonPress$/.test(name)
            ? { name, raw: /^Raw/.test(name), button: null, at: Date.now(), fired: false }
            : null;
          continue;
        }
        const ev = this.linuxEvent;
        if (!ev || ev.fired) continue;
        const detail = /detail:\s*(\d+)/.exec(line);
        if (detail) {
          ev.button = Number(detail[1]);
          if (ev.button >= 4 && ev.button <= 7) {
            // Scroll-wheel ticks (X11 buttons 4-7) are not clicks.
            this.linuxEvent = null;
          } else if (ev.raw) {
            // Raw blocks never carry coordinates; this one is complete.
            ev.fired = true;
            this.linuxEvent = null;
            this.fireLinuxClick(ev.at, null, ev.button, { raw: true });
          }
          continue;
        }
        const root = /root:\s*(-?[\d.]+)\/(-?[\d.]+)/.exec(line);
        if (root && !ev.raw && ev.button != null) {
          ev.fired = true;
          this.linuxEvent = null;
          this.fireLinuxClick(ev.at, {
            x: Math.round(parseFloat(root[1])),
            y: Math.round(parseFloat(root[2])),
          }, ev.button, { raw: false });
        }
      }
      return;
    }
    if (platform === 'win32') {
      for (const line of lines) {
        const m = /^CLICK(?:\s+(-?\d+)\s+(-?\d+)(?:\s+([A-Za-z0-9_-]+))?(?:\s+(\d+))?)?\s*$/.exec(line.trim());
        if (m) {
          const osPoint = m[1] === undefined ? null : { x: Number(m[1]), y: Number(m[2]) };
          const eventAt = m[4] === undefined ? Date.now() : Number(m[4]);
          this.onOsClick(Number.isFinite(eventAt) ? eventAt : Date.now(), osPoint, m[3] || 'mouse');
        }
      }
    }
  }

  /**
   * A new event header arrived while a press block was still open: the block
   * ended without the line we fire on. Old xinput builds sometimes omit
   * detail lines entirely — treat such a press as a plain click rather than
   * dropping it.
   */
  finishLinuxEvent() {
    const ev = this.linuxEvent;
    this.linuxEvent = null;
    if (!ev || ev.fired) return;
    if (ev.button == null) {
      this.onOsClick(ev.at, null, 'mouse');
    } else if (!ev.raw) {
      // Regular press whose root line never showed up — fire without
      // coordinates; onOsClick falls back to a cursor read.
      this.fireLinuxClick(ev.at, null, ev.button, { raw: false });
    }
  }

  /**
   * Funnel for parsed Linux button presses. Raw and regular blocks for the
   * same physical press are merged here: a raw press (no coordinates) is
   * held for LINUX_CLICK_TWIN_MS; if the regular twin (with root
   * coordinates) arrives inside that window the pair fires once, with the
   * raw block's earlier timestamp and the regular block's coordinates.
   * Distinct presses always fire — there is no time-based dropping.
   */
  fireLinuxClick(at, osPoint, button, { raw = false } = {}) {
    const pending = this.pendingRawClick;
    if (raw) {
      // Two raw presses can't be one click — release the held one first.
      this.flushPendingRawClick();
      const entry = { button, at, timer: null };
      entry.timer = setTimeout(() => {
        if (this.pendingRawClick !== entry) return;
        this.pendingRawClick = null;
        this.onOsClick(entry.at, null, `button-${entry.button}`);
      }, LINUX_CLICK_TWIN_MS);
      if (entry.timer.unref) entry.timer.unref();
      this.pendingRawClick = entry;
      return;
    }
    if (pending && pending.button === button) {
      // The regular twin of the held raw press: one physical click.
      this.pendingRawClick = null;
      clearTimeout(pending.timer);
      this.onOsClick(Math.min(pending.at, at), osPoint, `button-${button}`);
      return;
    }
    this.onOsClick(at, osPoint, `button-${button}`);
  }

  /** Fire the held raw press immediately (its twin is not coming). */
  flushPendingRawClick() {
    const pending = this.pendingRawClick;
    if (!pending) return;
    this.pendingRawClick = null;
    clearTimeout(pending.timer);
    this.onOsClick(pending.at, null, `button-${pending.button}`);
  }

  discardPendingRawClick() {
    if (!this.pendingRawClick) return;
    clearTimeout(this.pendingRawClick.timer);
    this.pendingRawClick = null;
  }

  /** Debounce window in ms (capture.clickDebounceMs, default 200). */
  clickDebounceMs() {
    const raw = this.settings.get('capture.clickDebounceMs');
    const v = Number(raw);
    return raw != null && Number.isFinite(v) && v >= 0 ? v : DEFAULT_CLICK_DEBOUNCE_MS;
  }

  onOsClick(at = Date.now(), osPoint = null, button = 'mouse') {
    if (!this.session || this.session.paused) return;
    // Recording isn't live until the window is hidden and the buffer primed
    // (see armRecording). Clicks during warmup land on the still-visible app
    // window, not the user's work, so ignore them rather than capturing junk.
    if (this.warmingUp) {
      clog('click@', Number.isFinite(at) ? at : Date.now(), button, 'ignored — still warming up');
      return;
    }
    const clickAt = Number.isFinite(at) ? at : Date.now();
    // Leading-edge debounce: ignore a click that lands within the debounce
    // window of the last accepted click of the same button. This makes fast
    // / accidental repeat clicks register once, while two deliberate clicks
    // spaced more than the window apart each register (one step per click).
    if (this.isDebouncedClick(clickAt, button)) {
      clog('click@', clickAt, button, 'debounced (within', this.clickDebounceMs(), 'ms of last accepted)');
      return;
    }
    // Prefer the position the watcher sampled with the button-down event
    // (physical px -> DIP); otherwise read the cursor synchronously, right
    // now, so the marker lands where the user clicked even if the shot
    // itself takes a moment to grab. (Clicks on StepForge itself are
    // filtered by the cursor-position check in sessionCapture, not by
    // window focus — WSLg reports focus unreliably.)
    let clickPos = osPoint ? this.osPointToDip(osPoint) : null;
    if (!clickPos) clickPos = this.screen.getCursorScreenPoint();
    clog('click@', clickAt, button, 'os', osPoint, '-> dip', clickPos);
    this.enqueueClickCapture(clickPos, clickAt, button || 'mouse');
  }

  /**
   * Whether this click should be dropped by the debounce. A click is dropped
   * only when it follows the last *accepted* click of the same button by
   * less than the debounce window — so the window is measured from accepted
   * clicks, never from dropped ones, and a run of fast clicks can't push the
   * next deliberate click out indefinitely. Accepting a click records it as
   * the new reference point. Different buttons debounce independently.
   */
  isDebouncedClick(at, button) {
    const key = button || 'mouse';
    const windowMs = this.clickDebounceMs();
    const last = this.lastAcceptedClickByButton.get(key);
    if (last != null && at >= last && at - last < windowMs) return true;
    this.lastAcceptedClickByButton.set(key, at);
    return false;
  }

  /**
   * Physical (OS event) pixels -> DIP. Windows exposes the canonical
   * conversion; on Linux/X11 it is reconstructed from display geometry (see
   * app/coords.js). Without this, the click marker drifts on any display
   * scaled away from 100% and on secondary monitors.
   */
  osPointToDip(osPoint) {
    if (this.screen && typeof this.screen.screenToDipPoint === 'function') {
      try {
        const dip = this.screen.screenToDipPoint(osPoint);
        if (dip && Number.isFinite(dip.x) && Number.isFinite(dip.y)) return dip;
      } catch { /* fall through to manual conversion */ }
    }
    try {
      const displays = this.screen && typeof this.screen.getAllDisplays === 'function'
        ? this.screen.getAllDisplays()
        : [];
      const dip = physicalToDip(osPoint, displays);
      if (dip) return dip;
    } catch { /* no display geometry available */ }
    return osPoint;
  }

  /**
   * Serialize click captures: a click that lands while an earlier capture is
   * still being stored queues behind it instead of being dropped by the
   * "capture already in progress" guard. The marker position was already
   * read at click time, so a queued step still circles the right spot.
   *
   * Crucially, only the *storing* is serialized. The click is paired with
   * its frame right here, at event time: behind a slow store or PNG encode
   * the queue can run seconds late, and a frame request issued that late
   * could find the click-time frame already evicted from the ring buffer.
   * Eager pairing keeps one-click-one-frame semantics intact no matter how
   * fast the user clicks or how slow the encoder is.
   */
  enqueueClickCapture(clickPos, clickAt = Date.now(), button = 'mouse') {
    const clickMeta = { at: Number.isFinite(clickAt) ? clickAt : Date.now(), button: button || 'mouse' };
    if (this.session && !this.session.paused && !this.userIsInApp()) {
      // The guide id pins the click to its recording so it can still be
      // stored if the session stops while this click waits in the queue.
      clickMeta.guideId = this.session.guideId;
      clickMeta.framePromise = this.frameForClick(clickPos, clickMeta.at)
        .catch(() => null);
    }
    this.clickQueue = this.clickQueue
      .then(() => this.sessionCapture('click', clickPos, clickMeta))
      .catch(() => {});
    return this.clickQueue;
  }

  async captureCurrentFrame(mode, capturePoint = null, startedAt = Date.now()) {
    const grabbed = await this.grab(mode, capturePoint);
    return {
      mode,
      // Keep the raw image and defer PNG encoding to storeFrameAsStep:
      // toPNG() on a full-resolution frame blocks the main thread for
      // hundreds of ms, and doing it every frame-loop tick starved the
      // event loop so badly that click events arrived seconds late.
      // Encoding once per *stored* step is cheap; encoding per grab is not.
      image: grabbed.image,
      size: grabbed.image.getSize(),
      display: grabbed.display,
      cursor: capturePoint || grabbed.cursor,
      startedAt,
      capturedAt: Date.now(),
    };
  }

  storeFrameAsStep(guideId, mode, frame, clickPos = null) {
    if (!frame) return { ok: false, reason: 'no capture frame available' };
    const annotations = [];
    // The click position (DIP, read at event time) wins over the frame's
    // grab-time cursor; stream-backend frames carry no cursor at all.
    const cursor = clickPos || frame.cursor || null;
    if (cursor && mode !== 'window' && this.settings.get('capture.clickMarker')) {
      const fx = (cursor.x - frame.display.bounds.x) / frame.display.bounds.width;
      const fy = (cursor.y - frame.display.bounds.y) / frame.display.bounds.height;
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
    }, frame.png || frame.image.toPNG(), frame.size);
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
  async grab(mode, cursorPoint = null) {
    const cursor = cursorPoint || this.screen.getCursorScreenPoint();
    const display = this.screen.getDisplayNearestPoint(cursor);
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
    clickPos = null,
  }) {
    const delay = delayMs == null ? this.settings.get('capture.delayMs') || 0 : delayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    let frame;
    try {
      frame = hideWindow
        ? await this.withWindowHidden(() => this.captureCurrentFrame(mode, clickPos), {
          refocus,
          pauseMs: hideWindowDelayMs == null ? 350 : hideWindowDelayMs,
        })
        : await this.captureCurrentFrame(mode, clickPos);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    return this.storeFrameAsStep(guideId, mode, frame, clickPos);
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
