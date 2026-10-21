'use strict';

/**
 * Settings → About "Update now" on Windows.
 *
 * Offered only when StepForge is registered with Chocolatey, the way the .exe
 * installer's "Keep StepForge updated with Chocolatey" option or
 * `choco install stepforge` leaves it. Pressing it starts one elevated,
 * visible PowerShell window that waits for StepForge to quit, runs
 * `choco upgrade stepforge -y`, and opens StepForge again as a normal app.
 *
 * Nothing the renderer sends ends up in a command: the PID, the app's own exe
 * and choco.exe are validated here and embedded as PowerShell literals. The
 * elevated script is passed with -EncodedCommand, not as a file, so nothing a
 * standard user can write is ever run elevated.
 *
 * Loadable under plain Node so the decisions and the generated scripts are
 * unit-testable on any platform.
 */

const nodeFs = require('node:fs');
const { win32 } = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_CHOCOLATEY_ROOT = 'C:\\ProgramData\\chocolatey';
const PACKAGE_ID = 'stepforge';
const HELP_URL = 'https://github.com/Twest2/StepForge/blob/main/docs/windows/chocolatey.md';
const WAIT_FOR_EXIT_SEC = 120;
// The outer PowerShell's exit codes.
const EXIT_STARTED = 0;
const EXIT_DECLINED = 2;
// CreateProcess limits a command line to 32,767 characters.
const MAX_COMMAND_LINE = 32767;

/** An absolute local Windows path ("C:\..."), with nothing PowerShell or explorer.exe would read as syntax. */
function isSafeWindowsPath(value, { exe = false } = {}) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  if (!/^[A-Za-z]:\\/.test(value)) return false;
  // Control characters and double quotes have no place in a real path.
  if (/[\u0000-\u001f\u007f"]/.test(value)) return false;
  if (value.split('\\').some((part) => part === '..')) return false;
  return !exe || /\.exe$/i.test(value);
}

/**
 * A PowerShell single-quoted string literal. PowerShell treats the curly
 * quotes ‘ ’ ‚ ‛ as single quotes too, so every one of them is doubled, not
 * just the ASCII apostrophe.
 */
function psQuote(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/** -EncodedCommand takes UTF-16LE text as base64. */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function isFile(fs, file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Is StepForge registered with Chocolatey on this machine? Chocolatey keeps a
 * registered package in %ChocolateyInstall%\lib\<id>, with its .nuspec, and
 * both the .exe installer's registration and `choco install` leave one there.
 * choco.exe must be there too, since that is what Update now runs.
 */
function chocolateyStatus({ env = process.env, fs = nodeFs } = {}) {
  const configured = typeof env.ChocolateyInstall === 'string' ? env.ChocolateyInstall.trim() : '';
  const root = configured || DEFAULT_CHOCOLATEY_ROOT;
  if (!isSafeWindowsPath(root)) return { registered: false, root: null, chocoPath: null };
  const chocoPath = win32.join(root, 'bin', 'choco.exe');
  const nuspec = win32.join(root, 'lib', PACKAGE_ID, `${PACKAGE_ID}.nuspec`);
  const registered = isFile(fs, nuspec) && isFile(fs, chocoPath);
  return { registered, root, chocoPath: registered ? chocoPath : null };
}

/**
 * Whether Settings → About offers Update now at all: a packaged StepForge on
 * Windows that Chocolatey has registered. A development build runs from
 * electron.exe, which must not be "reopened" after updating the installed app.
 */
function updateNowAvailable({ platform = process.platform, packaged = true, env, fs } = {}) {
  return platform === 'win32' && packaged === true && chocolateyStatus({ env, fs }).registered;
}

/**
 * The script the elevated window runs. Windows PowerShell 5.1: no `??`,
 * `&&`/`||` or ternaries. Its text is ASCII; only the embedded paths may not
 * be.
 */
function buildElevatedScript({ pid, exePath, chocoPath, targetVersion }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error('invalid process id');
  if (!isSafeWindowsPath(exePath, { exe: true })) throw new Error('invalid StepForge path');
  if (!isSafeWindowsPath(chocoPath, { exe: true }) || !/\\bin\\choco\.exe$/i.test(chocoPath)) throw new Error('invalid choco.exe path');
  if (typeof targetVersion !== 'string' || !/^\d{1,9}(\.\d{1,9}){0,3}$/.test(targetVersion)) throw new Error('invalid version');
  return [
    "$ErrorActionPreference = 'Continue'",
    `$StepForgePid = ${pid}`,
    `$AppExe = ${psQuote(exePath)}`,
    `$Choco = ${psQuote(chocoPath)}`,
    `$TargetVersion = ${psQuote(targetVersion)}`,
    `$HelpUrl = ${psQuote(HELP_URL)}`,
    '$ChocoRoot = Split-Path -Parent (Split-Path -Parent $Choco)',
    "$ChocoLog = Join-Path $ChocoRoot 'logs\\chocolatey.log'",
    // SYSTEM, Administrators and TrustedInstaller, as in chocolatey-setup.ps1.
    "$TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')",
    "try { $Host.UI.RawUI.WindowTitle = 'Updating StepForge' } catch { }",
    '',
    // Something went wrong: say what, where to look, and keep the window open
    // until it has been read.
    'function Exit-WithError {',
    '  param([string]$Message, [string]$Detail)',
    "  Write-Host ''",
    '  Write-Host $Message -ForegroundColor Red',
    '  if ($Detail) { Write-Host $Detail }',
    "  Write-Host ''",
    "  Write-Host 'StepForge was not updated. To update it yourself, close StepForge, open PowerShell as administrator and run: choco upgrade stepforge -y'",
    '  Write-Host "Help: $HelpUrl"',
    '  Write-Host "Chocolatey log: $ChocoLog"',
    "  Write-Host ''",
    "  [void](Read-Host 'Press Enter to close this window')",
    '  exit 1',
    '}',
    '',
    // Like Find-Choco in chocolatey-setup.ps1: the machine-wide
    // ChocolateyInstall is set by administrators alone; any other choco.exe
    // must be owned by SYSTEM or Administrators before it is run elevated.
    'function Test-TrustedChoco {',
    "  if (-not (Test-Path -LiteralPath $Choco -PathType Leaf)) { return $false }",
    "  $machineRoot = [Environment]::GetEnvironmentVariable('ChocolateyInstall', 'Machine')",
    "  if ($machineRoot -and ((Join-Path $machineRoot 'bin\\choco.exe') -eq $Choco)) { return $true }",
    '  try {',
    '    $owner = (Get-Acl -LiteralPath $Choco -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier]).Value',
    '  } catch {',
    '    return $false',
    '  }',
    '  return ($TrustedSids -contains $owner)',
    '}',
    '',
    // "1.4" -> 1.4.0.0, so versions with fewer parts compare as equal.
    'function ConvertTo-FullVersion {',
    '  param([string]$Text)',
    "  $parts = @(([string]$Text).Trim().Split('.'))",
    '  if ($parts.Count -gt 4) { return $null }',
    "  while ($parts.Count -lt 4) { $parts += '0' }",
    '  $parsed = $null',
    "  if ([version]::TryParse(($parts -join '.'), [ref]$parsed)) { return $parsed }",
    '  return $null',
    '}',
    '',
    // A per-user install is replaced by an all-users one on the first
    // Chocolatey update, so the old exe may be gone.
    'function Find-StepForge {',
    '  if (Test-Path -LiteralPath $AppExe -PathType Leaf) { return $AppExe }',
    '  $leaf = Split-Path -Leaf $AppExe',
    "  foreach ($key in @(Get-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue)) {",
    "    if ($key.DisplayName -like 'StepForge*' -and $key.InstallLocation) {",
    '      $candidate = Join-Path $key.InstallLocation $leaf',
    '      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }',
    '    }',
    '  }',
    '  if ($env:ProgramFiles) {',
    "    $candidate = Join-Path $env:ProgramFiles ('StepForge\\' + $leaf)",
    '    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }',
    '  }',
    '  return $null',
    '}',
    '',
    "Write-Host ''",
    "Write-Host '  StepForge update' -ForegroundColor Cyan",
    "Write-Host '  ----------------' -ForegroundColor Cyan",
    'Write-Host "  Installing StepForge $TargetVersion with Chocolatey."',
    "Write-Host '  Please leave this window open. It closes by itself and reopens StepForge when the update is done.'",
    "Write-Host ''",
    '',
    "Write-Host 'Waiting for StepForge to close...'",
    '$running = Get-Process -Id $StepForgePid -ErrorAction SilentlyContinue',
    // The PID may already belong to something else if StepForge closed first.
    'if ($running -and $running.Path -and ($running.Path -ne $AppExe)) { $running = $null }',
    'if ($running) {',
    `  Wait-Process -Id $StepForgePid -Timeout ${WAIT_FOR_EXIT_SEC} -ErrorAction SilentlyContinue`,
    '  if (Get-Process -Id $StepForgePid -ErrorAction SilentlyContinue) {',
    `    Exit-WithError 'StepForge did not close within ${WAIT_FOR_EXIT_SEC / 60} minutes, so the update did not start.' 'If StepForge is stuck, close it from the tray or Task Manager, then try again.'`,
    '  }',
    '}',
    '',
    'if (-not (Test-TrustedChoco)) {',
    '  Exit-WithError "Chocolatey was not found at $Choco, or that file is not owned by an administrator, so it was not run." \'\'',
    '}',
    '',
    "Write-Host 'Running: choco upgrade stepforge -y'",
    "Write-Host ''",
    '$code = -1',
    'try {',
    '  & $Choco upgrade stepforge -y',
    '  $code = $LASTEXITCODE',
    '} catch {',
    '  Write-Host $_.Exception.Message',
    '}',
    // 0 is success; 1641 and 3010 mean success with a restart pending.
    'if (@(0, 1641, 3010) -notcontains $code) {',
    '  Exit-WithError \'Chocolatey could not update StepForge.\' "choco upgrade stepforge -y failed with exit code $code."',
    '}',
    '',
    // The GitHub release can be out a little before the Chocolatey package,
    // and then choco reports success without changing anything.
    '$installed = $null',
    'try {',
    "  $nuspec = Join-Path $ChocoRoot 'lib\\stepforge\\stepforge.nuspec'",
    '  $installed = [string]([xml](Get-Content -LiteralPath $nuspec -Raw)).package.metadata.version',
    '} catch { }',
    "$done = 'StepForge was updated.'",
    '$installedVersion = ConvertTo-FullVersion $installed',
    '$targetFull = ConvertTo-FullVersion $TargetVersion',
    'if ($installedVersion -and $targetFull -and ($installedVersion -lt $targetFull)) {',
    "  Write-Host ''",
    '  Write-Host "Chocolatey does not have StepForge $TargetVersion yet, so StepForge $installed is still installed." -ForegroundColor Yellow',
    "  Write-Host 'New versions reach Chocolatey shortly after they are released. Try Update now again later.'",
    "  [void](Read-Host 'Press Enter to open StepForge')",
    "  $done = 'StepForge was not changed.'",
    '}',
    '',
    '$app = Find-StepForge',
    'if (-not $app) {',
    "  Write-Host ''",
    '  Write-Host "$done Open it from the Start menu." -ForegroundColor Green',
    "  [void](Read-Host 'Press Enter to close this window')",
    '  exit 0',
    '}',
    "Write-Host ''",
    'Write-Host "$done Opening it..." -ForegroundColor Green',
    // Explorer hands the launch to the signed-in desktop, so StepForge runs as
    // a normal app rather than as administrator like this window.
    "$explorer = Join-Path ([Environment]::GetFolderPath('Windows')) 'explorer.exe'",
    "Start-Process -FilePath $explorer -ArgumentList ('\"' + $app + '\"')",
    'Start-Sleep -Seconds 2',
    'exit 0',
    '',
  ].join('\r\n');
}

/**
 * The non-elevated PowerShell command that asks for administrator approval
 * and starts the elevated window. It holds no double quotes and nothing but
 * fixed text and base64, so it passes through the command line unchanged.
 * Exits 0 once the elevated window has started, 2 when the UAC prompt was
 * declined (ERROR_CANCELLED, 1223), and 1 for anything else.
 */
function buildLauncherCommand(elevatedScript) {
  const encoded = encodeCommand(elevatedScript);
  return [
    "$ErrorActionPreference = 'Stop';",
    'try {',
    '$info = New-Object System.Diagnostics.ProcessStartInfo;',
    "$info.FileName = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe';",
    `$info.Arguments = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}';`,
    "$info.Verb = 'runas';",
    '$info.UseShellExecute = $true;',
    '[void][System.Diagnostics.Process]::Start($info);',
    `exit ${EXIT_STARTED}`,
    '} catch {',
    'for ($e = $_.Exception; $e; $e = $e.InnerException) {',
    `if (($e -is [System.ComponentModel.Win32Exception]) -and ($e.NativeErrorCode -eq 1223)) { exit ${EXIT_DECLINED} }`,
    '}',
    'exit 1',
    '}',
  ].join(' ');
}

/** Windows PowerShell 5.1, which every supported Windows has. */
function windowsPowerShellPath(env = process.env) {
  const systemRoot = isSafeWindowsPath(env.SystemRoot || '') ? env.SystemRoot : 'C:\\Windows';
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Run the launcher and report whether the elevated window started. Resolves
 * { started: true }, { started: false, declined: true } or
 * { started: false, declined: false }; never rejects.
 */
function launchElevated(command, { spawnImpl = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(windowsPowerShellPath(env), ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      resolve({ started: false, declined: false });
      return;
    }
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    child.once('error', () => finish({ started: false, declined: false }));
    child.once('exit', (code) => finish(code === EXIT_STARTED
      ? { started: true }
      : { started: false, declined: code === EXIT_DECLINED }));
  });
}

/**
 * The app:updateNow decision. Everything is re-checked here, in the main
 * process: Windows, a packaged build, Chocolatey registration, and that this
 * session's own update check found the version to install. Resolves
 * { ok: true } when the elevated window started (the caller then quits
 * StepForge), or { ok: false, reason, message }.
 */
async function updateNow({
  platform = process.platform,
  packaged = true,
  env = process.env,
  fs = nodeFs,
  lastCheck = null,
  pid = process.pid,
  exePath = process.execPath,
  launch = launchElevated,
} = {}) {
  if (platform !== 'win32' || packaged !== true) {
    return { ok: false, reason: 'unsupported', message: 'Update now is only available in the Windows app.' };
  }
  const status = chocolateyStatus({ env, fs });
  if (!status.registered) {
    return { ok: false, reason: 'not-registered', message: 'StepForge isn’t registered with Chocolatey, so it can’t update itself. Download the new installer instead.' };
  }
  if (!lastCheck || lastCheck.status !== 'update-available' || !lastCheck.latestVersion) {
    return { ok: false, reason: 'no-update', message: 'Check for updates first.' };
  }
  let command;
  try {
    command = buildLauncherCommand(buildElevatedScript({
      pid, exePath, chocoPath: status.chocoPath, targetVersion: lastCheck.latestVersion,
    }));
  } catch {
    return { ok: false, reason: 'failed', message: 'Couldn’t prepare the update. Download the new installer instead.' };
  }
  if (command.length > MAX_COMMAND_LINE - 200) {
    return { ok: false, reason: 'failed', message: 'Couldn’t prepare the update. Download the new installer instead.' };
  }
  const result = await launch(command, { env });
  if (result.started) return { ok: true };
  if (result.declined) return { ok: false, reason: 'declined', message: 'Update cancelled' };
  return { ok: false, reason: 'failed', message: 'Couldn’t start the update. Try again, or download the new installer.' };
}

module.exports = {
  DEFAULT_CHOCOLATEY_ROOT,
  HELP_URL,
  EXIT_STARTED,
  EXIT_DECLINED,
  WAIT_FOR_EXIT_SEC,
  isSafeWindowsPath,
  psQuote,
  encodeCommand,
  chocolateyStatus,
  updateNowAvailable,
  buildElevatedScript,
  buildLauncherCommand,
  windowsPowerShellPath,
  launchElevated,
  updateNow,
};
