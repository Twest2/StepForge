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

// Dedupe duplicate watcher events for one physical click while still
// allowing intentionally fast clicking.
const CLICK_DEBOUNCE_MS = 40;
// Idle gap between frame-loop grabs. Must stay well above zero: grabbing
// back-to-back starves the main-process event loop, which delays delivery
// of click events from the OS watcher by whole seconds. The frame history
// plus hook-side click timestamps tolerate the coarser cadence.
const FRAME_LOOP_IDLE_MS = 200;
// A buffered frame older than this is too stale to pass off as "the screen
// at the instant of the click".
const CLICK_FRAME_MAX_AGE_MS = 600;
// How long a click waits for the in-flight grab before falling back to a
// one-off fresh shot.
const CLICK_FRAME_WAIT_MS = 2000;
// A loop grab that started at most this long after the click still shows
// the screen the user clicked on (UI reactions render slower than this).
const CLICK_FRAME_START_SLACK_MS = 300;
const CLICK_CAPTURE_HIDE_DELAY_MS = 25;
// Frames now hold raw images (~20MB each at 2880x1800), so keep the history
// window wide enough to outlast any processing hiccup but the count low.
const RECENT_FRAME_RETENTION_MS = 4000;
const RECENT_FRAME_LIMIT = 4;

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
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
  constructor({ store, settings, getWindow, notify }) {
    this.store = store;
    this.settings = settings;
    this.getWindow = getWindow;
    this.notify = notify;
    this.session = null; // { guideId, paused, count, intervalSec }
    this.intervalTimer = null;
    this.clickWatcher = null;
    this.frameLoopTimer = null;
    this.frameLoopRunning = false;
    this.frameWaiters = [];
    this.latestFrame = null;
    this.clickWatcherBuf = '';
    this.clickWatcherPendingPress = false;
    this.clickWatcherErrTail = '';
    this.clickQueue = Promise.resolve();
    this.frameLoopInFlight = false;
    this.frameLoopGrabStartedAt = null;
    this.recentFrames = [];
    this.shooting = false;
    this.lastClickCaptureByButton = new Map();
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
    // Sessions start paused: nothing hides and no capturing happens until
    // the user explicitly presses "Start recording" in the capture bar, so
    // New Capture never makes the window vanish out from under them.
    this.session = { guideId, paused: true, count: 0, intervalSec: interval };
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
      try {
        new Notification({
          title: 'StepForge is ready to capture',
          body: 'Click "Start recording" in the red capture bar when you’re ready. The window tucks away and the red tray icon takes over.',
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
    // Starting/resuming tucks the window away again for clean shots (after
    // a brief delay so the user sees it happen) and starts the frame loop
    // that serves click captures. Pausing stops the loop and discards the
    // buffered frame, so a resume can never serve a pre-pause screen.
    if (wasPaused && !this.session.paused) {
      const win = this.getWindow();
      const arm = () => {
        if (!this.session || this.session.paused) return;
        if (this.hiddenForSession && win && !win.isDestroyed() && win.isVisible()) win.hide();
        if (this.settings.get('capture.captureOutsideClicks') !== false && this.clickCaptureAvailable()) {
          this.startFrameLoop();
        }
      };
      if (this.hiddenForSession && win && !win.isDestroyed()) setTimeout(arm, 400);
      else arm();
    } else if (!wasPaused && this.session.paused) {
      this.stopFrameLoop();
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
    this.stopFrameLoop();
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
  async sessionCapture(trigger = 'hotkey', clickPos = null, clickMeta = null) {
    if (!this.session || this.session.paused) return { ok: false, reason: 'no active capture session' };
    // Automatic triggers stand down while the user is in StepForge, so the
    // app stays clickable mid-session and never screenshots itself.
    if (trigger !== 'manual' && this.userIsInApp()) {
      return { ok: false, reason: 'skipped — StepForge is focused' };
    }

    // Clicks are served from the frame loop: the buffered frame was grabbed
    // at (or moments before) the click instant, so the background matches
    // what the user clicked on. A click that lands while a grab is in
    // flight waits for that frame instead of being dropped, so fast
    // clicking still yields one step per click.
    if (trigger === 'click') {
      const clickAt = clickMeta && Number.isFinite(clickMeta.at) ? clickMeta.at : Date.now();
      const frame = await this.frameForClick(clickPos, clickAt);
      if (!this.session || this.session.paused) return { ok: false, reason: 'no active capture session' };
      if (frame) {
        const result = this.storeFrameAsStep(this.session.guideId, frame.mode, frame, clickPos);
        if (result.ok) this.noteStepAdded(result.step, trigger);
        return result;
      }
      // No usable frame (loop not running or grab failing): fall through
      // to a one-off fresh shot.
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

  noteStepAdded(step, trigger) {
    this.session.count += 1;
    this.notify('capture:added', { guideId: this.session.guideId, step, trigger });
    this.notify('capture:state', this.state());
    if (this.rebuildTrayMenu) this.rebuildTrayMenu(); // refresh step counter
  }

  hotkeyCapture() {
    return this.sessionCapture('hotkey');
  }

  // ---- click-triggered capture --------------------------------------------

  /**
   * Continuous screen-grab loop that runs while recording. It keeps the most
   * recent frame in `latestFrame` so a click can be served from a frame
   * grabbed at (or moments before) the instant of the click — a fresh grab
   * started after the click would land hundreds of ms late and show the
   * click's effects instead of what the user clicked on.
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
   * Freshest frame usable for a click capture: the buffered frame when it's
   * recent enough, otherwise the next frame the loop delivers. Null when the
   * loop isn't running or can't deliver in time.
   */
  async frameForClick(clickPos = null, clickAt = Date.now()) {
    const mode = this.settings.get('capture.mode') || 'fullscreen';
    const grabMode = mode === 'region' ? 'fullscreen' : mode;
    const clickTime = Number.isFinite(clickAt) ? clickAt : Date.now();
    // Fast clicks can move to another monitor before the buffered frame is
    // consumed; only reuse frames from the clicked display.
    const usable = (f, { allowInFlight = false } = {}) => {
      const sameDisplay = !clickPos || pointInBounds(clickPos, f && f.display && f.display.bounds);
      const startedAt = Number.isFinite(f && f.startedAt) ? f.startedAt : (f && f.capturedAt);
      const completedBeforeClick = Number.isFinite(f && f.capturedAt) && f.capturedAt <= clickTime;
      // A grab that began within the slack window after the click still
      // shows the click-instant screen (UI reactions take longer than the
      // slack to render), and it beats the alternative — a fresh shot that
      // both starts later and stalls the loop for every queued click.
      const startedNearClick = Number.isFinite(startedAt)
        && startedAt <= clickTime + CLICK_FRAME_START_SLACK_MS;
      const timingMatches = completedBeforeClick
        ? clickTime - f.capturedAt <= CLICK_FRAME_MAX_AGE_MS
        : allowInFlight && startedNearClick;
      return Boolean(f)
        && f.mode === grabMode
        && timingMatches
        && sameDisplay;
    };
    const buffered = [...this.recentFrames, this.latestFrame]
      .filter((f, i, arr) => f && arr.indexOf(f) === i && usable(f))
      .sort((a, b) => b.capturedAt - a.capturedAt)[0];
    if (buffered) return buffered;
    // As long as the loop is running, the next grab is at most one idle gap
    // away — wait for it rather than racing it with a one-off shot.
    if (!this.frameLoopRunning) return null;
    const deadline = Date.now() + CLICK_FRAME_WAIT_MS;
    while (this.frameLoopRunning && Date.now() < deadline) {
      const next = await this.nextFrame(Math.max(1, deadline - Date.now()));
      if (usable(next, { allowInFlight: true })) return next;
      if (next && Number.isFinite(next.startedAt)
        && next.startedAt > clickTime + CLICK_FRAME_START_SLACK_MS) {
        // Grabs only get later from here; let the fresh-shot path handle it.
        return null;
      }
    }
    return null;
  }

  startClickWatcher() {
    this.stopClickWatcher();
    try {
      this.clickWatcherBuf = '';
      this.clickWatcherPendingPress = false;
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
    this.clickWatcherPendingPress = false;
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
    this.clickWatcherPendingPress = false;
    this.lastClickCaptureByButton.clear();
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
      // xinput prints each event as a multi-line block: an "EVENT type …
      // (RawButtonPress)" header followed by a "detail: N" line carrying the
      // button number. Fire on the detail line so scroll-wheel ticks (X11
      // reports them as buttons 4-7) neither create steps nor debounce away
      // the real clicks that follow them.
      for (const line of lines) {
        if (!line) continue;
        if (/RawButtonPress|ButtonPress/.test(line)) {
          if (this.clickWatcherPendingPress) this.onOsClick();
          this.clickWatcherPendingPress = true;
          continue;
        }
        if (!this.clickWatcherPendingPress) continue;
        const detail = line.match(/detail:\s*(\d+)/);
        if (detail) {
          this.clickWatcherPendingPress = false;
          const button = Number(detail[1]);
          if (button < 4 || button > 7) this.onOsClick(Date.now(), null, `button-${button}`);
        } else if (line.includes('EVENT type')) {
          // Next event arrived without a detail line in between — treat the
          // pending press as a plain click rather than dropping it.
          this.clickWatcherPendingPress = false;
          this.onOsClick();
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

  onOsClick(at = Date.now(), osPoint = null, button = 'mouse') {
    if (!this.session || this.session.paused) return;
    const clickAt = Number.isFinite(at) ? at : Date.now();
    const debounceKey = button || 'mouse';
    const last = this.lastClickCaptureByButton.get(debounceKey) || 0;
    if (clickAt >= last && clickAt - last < CLICK_DEBOUNCE_MS) return;
    this.lastClickCaptureByButton.set(debounceKey, clickAt);
    // Prefer the position the watcher sampled with the button-down event
    // (physical px -> DIP); otherwise read the cursor synchronously,
    // right now, so the marker lands where the user clicked even if the
    // shot itself takes a moment to grab. (Clicks on StepForge itself are
    // filtered by the cursor-position check in sessionCapture, not by
    // window focus — WSLg reports focus unreliably.)
    let clickPos = null;
    if (osPoint) {
      clickPos = typeof screen.screenToDipPoint === 'function'
        ? screen.screenToDipPoint(osPoint)
        : osPoint;
    }
    if (!clickPos) clickPos = screen.getCursorScreenPoint();
    this.enqueueClickCapture(clickPos, clickAt, debounceKey);
  }

  /**
   * Serialize click captures: a click that lands while an earlier capture is
   * still being stored queues behind it instead of being dropped by the
   * "capture already in progress" guard. The marker position was already
   * read at click time, so a queued step still circles the right spot.
   */
  enqueueClickCapture(clickPos, clickAt = Date.now(), button = 'mouse') {
    const clickMeta = { at: Number.isFinite(clickAt) ? clickAt : Date.now(), button: button || 'mouse' };
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
    const cursor = clickPos || frame.cursor;
    if (mode !== 'window' && this.settings.get('capture.clickMarker')) {
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
    const cursor = cursorPoint || screen.getCursorScreenPoint();
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
