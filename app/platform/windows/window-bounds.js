'use strict';

const { execFile } = require('node:child_process');

/**
 * Which window a Window-mode capture shows, on Windows.
 *
 * Window shots are cut out of the full-screen frame (app/capture.js
 * windowFrame), so all StepForge needs is the window's rectangle on screen.
 * Asking desktopCapturer for "the window" instead returned the top of the
 * window stack, which is an input method's toolbar or any other
 * always-on-top window (#203).
 *
 * `SFWindows` (C#, compiled by PowerShell's Add-Type) finds the rectangle:
 *  - for a click, the top-level window under the click point. The mouse hook
 *    runs before Windows activates that window, so on the first click into
 *    another app the foreground window is still the previous one.
 *  - a menu, dropdown list or tooltip never becomes the active window. The
 *    area grows to include it, and the window that owns it is the one shown.
 *  - a window that never takes focus and has no owner (an input method's
 *    toolbar, the on-screen keyboard) stands for the active window, which is
 *    shown instead. Its own area is only added when it belongs to the same
 *    app, like a classic popup menu.
 *  - without a click, the active window.
 * Rectangles are DWM's extended frame bounds (the visible frame, without the
 * invisible resize border) in physical pixels, read in a per-monitor DPI
 * aware thread context. The desktop, the taskbar and minimized windows are
 * not windows to show: "-".
 *
 * The same class is compiled into the click hook in app/capture.js, which
 * reports it as a `WIN` line before each `CLICK`. It expects `using System;`
 * and `using System.Runtime.InteropServices;`, which the hook already has:
 * the hook script goes to PowerShell on the command line, and Windows caps
 * that at 32,767 characters.
 */
const WINDOW_BOUNDS_CS = String.raw`
public static class SFWindows {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X, Y;
    public POINT(int x, int y) { X = x; Y = y; }
  }

  private const uint GA_ROOT = 2;
  private const uint GW_OWNER = 4;
  private const int GWL_STYLE = -16;
  private const int GWL_EXSTYLE = -20;
  private const int WS_CAPTION = 0x00C00000;
  private const int WS_EX_NOACTIVATE = 0x08000000;
  private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

  [DllImport("user32.dll")]
  private static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")]
  private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")]
  private static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
  private static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  private static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll")]
  private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")]
  private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

  // The area to show for a click at (x, y), physical pixels, as
  // "left top right bottom pid", or "-" when there is no window to show.
  // window is the window the click is for, even the taskbar or the desktop.
  public static string ForClick(int x, int y, out IntPtr window) {
    window = IntPtr.Zero;
    IntPtr previous = PhysicalPixels();
    try {
      IntPtr hit = WindowFromPoint(new POINT(x, y));
      IntPtr w = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, GA_ROOT);
      RECT area = new RECT();
      bool grown = false;
      for (int depth = 0; w != IntPtr.Zero && depth < 8 && IsPopup(w); depth++) {
        IntPtr owner = GetWindow(w, GW_OWNER);
        if (owner == IntPtr.Zero) {
          IntPtr active = GetForegroundWindow();
          if (SameProcess(w, active)) grown = Grow(ref area, grown, w);
          w = active;
          break;
        }
        grown = Grow(ref area, grown, w);
        w = owner;
      }
      window = w;
      return Describe(w, area, grown);
    } finally {
      Restore(previous);
    }
  }

  // The active window's area, in the same format.
  public static string Active() {
    IntPtr previous = PhysicalPixels();
    try {
      return Describe(GetForegroundWindow(), new RECT(), false);
    } finally {
      Restore(previous);
    }
  }

  private static string Describe(IntPtr w, RECT area, bool grown) {
    RECT frame;
    if (!Showable(w) || !Bounds(w, out frame)) return "-";
    if (grown) frame = Union(frame, area);
    uint pid;
    GetWindowThreadProcessId(w, out pid);
    return frame.Left + " " + frame.Top + " " + frame.Right + " " + frame.Bottom + " " + pid;
  }

  private static bool Showable(IntPtr w) {
    if (w == IntPtr.Zero || w == GetShellWindow() || !IsWindowVisible(w) || IsIconic(w)) return false;
    string name = ClassName(w);
    return name != "Progman" && name != "WorkerW" && name != "Shell_TrayWnd" && name != "Shell_SecondaryTrayWnd";
  }

  // Menus, dropdown lists, tooltips and toolbars that never take focus.
  private static bool IsPopup(IntPtr w) {
    if ((GetWindowLong(w, GWL_EXSTYLE) & WS_EX_NOACTIVATE) != 0) return true;
    if (ClassName(w) == "#32768") return true;
    return GetWindow(w, GW_OWNER) != IntPtr.Zero && (GetWindowLong(w, GWL_STYLE) & WS_CAPTION) != WS_CAPTION;
  }

  private static bool Bounds(IntPtr w, out RECT r) {
    if (DwmGetWindowAttribute(w, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0
        && r.Right > r.Left && r.Bottom > r.Top) return true;
    return GetWindowRect(w, out r) && r.Right > r.Left && r.Bottom > r.Top;
  }

  private static bool Grow(ref RECT area, bool grown, IntPtr w) {
    RECT r;
    if (!Bounds(w, out r)) return grown;
    area = grown ? Union(area, r) : r;
    return true;
  }

  private static RECT Union(RECT a, RECT b) {
    RECT r;
    r.Left = Math.Min(a.Left, b.Left);
    r.Top = Math.Min(a.Top, b.Top);
    r.Right = Math.Max(a.Right, b.Right);
    r.Bottom = Math.Max(a.Bottom, b.Bottom);
    return r;
  }

  private static bool SameProcess(IntPtr a, IntPtr b) {
    if (a == IntPtr.Zero || b == IntPtr.Zero) return false;
    uint first, second;
    GetWindowThreadProcessId(a, out first);
    GetWindowThreadProcessId(b, out second);
    return first != 0 && first == second;
  }

  private static string ClassName(IntPtr w) {
    System.Text.StringBuilder name = new System.Text.StringBuilder(64);
    GetClassName(w, name, name.Capacity);
    return name.ToString();
  }

  private static IntPtr PhysicalPixels() {
    try { return SetThreadDpiAwarenessContext(PerMonitorAwareV2); } catch { return IntPtr.Zero; }
  }

  private static void Restore(IntPtr previous) {
    if (previous == IntPtr.Zero) return;
    try { SetThreadDpiAwarenessContext(previous); } catch { }
  }
}
`;

/**
 * "left top right bottom pid" -> { left, top, right, bottom, pid }; null for
 * "-" or anything malformed.
 */
function parseWindowBounds(text) {
  const m = /^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const [left, top, right, bottom, pid] = m.slice(1).map(Number);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, pid };
}

/** PowerShell that prints the active window's area (see SFWindows.Active). */
function activeWindowScript() {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
${WINDOW_BOUNDS_CS}
'@
[SFWindows]::Active()
`;
}

/**
 * The active window's area in physical pixels, or null. For Window shots
 * without a click (Capture window, Retake, the capture hotkey), read after
 * StepForge has hidden itself.
 */
function readActiveWindow({ run = execFile } = {}) {
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', activeWindowScript()], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }, (err, stdout) => {
      resolve(err ? null : parseWindowBounds(String(stdout || '').trim()));
    });
  });
}

module.exports = { WINDOW_BOUNDS_CS, parseWindowBounds, activeWindowScript, readActiveWindow };
