'use strict';

const { execFile } = require('node:child_process');

function supportsCaptureExclusion(platform, release) {
  const [major, , build] = String(release).split('.').map(Number);
  return platform === 'win32' && (major > 10 || (major === 10 && build >= 19041));
}

// Electron's isContentProtected() reports the requested state, not whether
// Windows accepted it. Check the actual affinity before showing the window.
function verifyCaptureExclusion(win, run = execFile) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SFCaptureAffinity {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("dwmapi.dll")]
  public static extern int DwmIsCompositionEnabled(out bool enabled);
}
'@
[uint32]$affinity = 0
[bool]$composed = $false
$ok = [SFCaptureAffinity]::GetWindowDisplayAffinity([IntPtr]::new([long]${hwnd}), [ref]$affinity)
$hr = [SFCaptureAffinity]::DwmIsCompositionEnabled([ref]$composed)
if ($ok -and $affinity -eq 17 -and $hr -eq 0 -and $composed) { 'excluded' } else { 'unavailable' }
`;
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      // Add-Type compiles C#; antivirus scans can slow the first run, and the
      // click hook compiles at the same time. A spurious timeout means tray.
      { windowsHide: true, timeout: 15000 }, (error, stdout) => resolve(!error && stdout.trim() === 'excluded'));
  });
}

module.exports = { supportsCaptureExclusion, verifyCaptureExclusion };
