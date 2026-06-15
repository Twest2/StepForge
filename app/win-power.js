'use strict';

const { spawn } = require('node:child_process');

/**
 * Opt a set of OS processes out of Windows Power Throttling (EcoQoS) and raise
 * them to high priority, so the capture pipeline keeps running at full CPU
 * speed while the laptop is on battery in a power-saving plan.
 *
 * Why this exists: during a recording StepForge hides its window, so Windows
 * treats the frame-capture worker renderer (and the GPU / screen-capture
 * utility processes feeding it) as background work and CPU-throttles them on
 * DC power. Throttled, the worker can't sample frames fast enough — every
 * click then finds no fresh pre-click frame and falls back to a slow
 * post-click shot, which is what broke recordings on battery only.
 *
 * The Chromium command-line switches in main.js stop Chromium's own
 * backgrounding; this goes one level lower and clears the OS EcoQoS flag via
 * SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED → off), which
 * has no Node binding, so we drive it through a short-lived PowerShell.
 *
 * Best-effort and fire-and-forget: any failure (older Windows without the API,
 * PowerShell blocked by policy, a process that already exited) is swallowed —
 * the Chromium switches still apply and capture degrades gracefully.
 *
 * No-op on every non-Windows platform.
 *
 * @param {number[]} pids OS process ids to keep responsive.
 */
function keepProcessesResponsive(pids) {
  if (process.platform !== 'win32') return;
  // Only integers reach the script, so the interpolation below can't inject.
  const list = [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))];
  if (!list.length) return;

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SFPower {
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }

  const int ProcessPowerThrottling = 4;
  const uint PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
  const uint PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
  const uint HIGH_PRIORITY_CLASS = 0x00000080;
  const uint PROCESS_SET_INFORMATION = 0x0200;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetProcessInformation(IntPtr h, int cls, ref PROCESS_POWER_THROTTLING_STATE info, uint size);
  [DllImport("kernel32.dll")]
  static extern bool SetPriorityClass(IntPtr h, uint cls);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);

  public static void Apply(uint pid) {
    IntPtr h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return;
    try {
      PROCESS_POWER_THROTTLING_STATE s = new PROCESS_POWER_THROTTLING_STATE();
      s.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
      s.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
      s.StateMask = 0; // 0 => throttling off => opt out of EcoQoS
      SetProcessInformation(h, ProcessPowerThrottling, ref s, (uint)Marshal.SizeOf(s));
      SetPriorityClass(h, HIGH_PRIORITY_CLASS);
    } finally { CloseHandle(h); }
  }
}
'@
${list.map((p) => `[SFPower]::Apply(${p})`).join('\n')}
`;

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => { /* PowerShell missing/blocked — best effort */ });
    child.unref();
  } catch {
    // spawn itself failed; the Chromium switches remain in effect.
  }
}

module.exports = { keepProcessesResponsive };
