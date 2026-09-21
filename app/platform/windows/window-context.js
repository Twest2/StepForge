'use strict';

const { execFile } = require('node:child_process');

/**
 * Windows WindowContextProvider. Reads the foreground window (Win32) and, when
 * a click point is given, the UI Automation element under it. Best-effort:
 * resolves {} on any failure. Extracted verbatim from text-intel.js so the
 * shared code carries no `process.platform` branch.
 */
function createWindowsWindowContextProvider() {
  return {
    async collect(osPoint = null) {
      const hasPoint = osPoint && Number.isFinite(osPoint.x) && Number.isFinite(osPoint.y);
      const clickX = hasPoint ? Number(osPoint.x) : 0;
      const clickY = hasPoint ? Number(osPoint.y) : 0;
      const script = `
      $clickX = ${clickX};
      $clickY = ${clickY};
      $elementLabel = '';
      $elementRole = '';
      $elementClass = '';
      $elementProcessId = 0;
      $elementValue = '';
      $elementIsPassword = $false;
      if (${hasPoint ? '$true' : '$false'}) {
        try {
          Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase | Out-Null
          $point = New-Object System.Windows.Point($clickX, $clickY);
          $element = [System.Windows.Automation.AutomationElement]::FromPoint($point);
          if ($element) {
            $current = $element.Current;
            $elementLabel = $current.Name;
            $elementRole = ($current.ControlType.ProgrammaticName -replace '^ControlType[.]', '' -creplace '([a-z])([A-Z])', '$1 $2').ToLowerInvariant();
            $elementIsPassword = $current.IsPassword;
            if ($elementIsPassword) { $elementLabel = 'Password'; }
            $elementClass = $current.ClassName;
            $elementProcessId = $current.ProcessId;
            try {
              $valPattern = [System.Windows.Automation.ValuePattern]::Pattern;
              if (!$elementIsPassword -and ($element.GetSupportedPatterns() -contains $valPattern)) {
                $elementValue = $element.GetCurrentPattern($valPattern).Current.Value;
              }
            } catch { }
          }
        } catch { }
      }
      Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@;
      $hWnd = [Win32]::GetForegroundWindow();
      $sb = New-Object System.Text.StringBuilder 512;
      [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity);
      $foregroundProcessId = 0;
      [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$foregroundProcessId);
      $proc = Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue | Select-Object -First 1;
      $out = [ordered]@{
        appName = if ($proc) { $proc.ProcessName } else { '' };
        windowTitle = $sb.ToString();
        elementLabel = $elementLabel;
        elementRole = $elementRole;
        elementClass = $elementClass;
        elementValue = $elementValue;
        elementIsPassword = $elementIsPassword;
        elementProcessId = $elementProcessId;
        pid = $foregroundProcessId;
      };
      $out | ConvertTo-Json -Compress;
    `;
      return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          encoding: 'utf8',
          timeout: 4000,
          windowsHide: true,
        }, (err, stdout) => {
          if (err) { resolve({}); return; }
          try { resolve(JSON.parse(stdout.trim() || '{}')); } catch { resolve({}); }
        });
      });
    },
  };
}

module.exports = { createWindowsWindowContextProvider };
