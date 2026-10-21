'use strict';
// Runs the elevated "Update now" script from app/windows-update.js for real,
// against a stub choco and a stub explorer.exe, so waiting for StepForge,
// the failure pauses and the relaunch are checked, not just the text.
// Needs PowerShell (pwsh, or STEPFORGE_PWSH); skipped where it is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  EXIT_STARTED, EXIT_DECLINED, buildElevatedScript, buildLauncherCommand, encodeCommand, psQuote,
} = require('../../app/windows-update');

const pwsh = process.env.STEPFORGE_PWSH || 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;
const skip = hasPwsh ? false : 'PowerShell (pwsh) is not installed';
const windows = process.platform === 'win32';

// This test's own Node stands in for StepForge.exe: Get-Process reports its
// real path, which is what the script compares with.
const APP = fs.realpathSync(process.execPath);

function stubs(dir, { chocoExit, installed }) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'lib', 'stepforge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'stepforge', 'stepforge.nuspec'),
    `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd"><metadata><id>stepforge</id><version>${installed}</version></metadata></package>\n`);
  const calls = path.join(dir, 'choco-calls.txt');
  const opened = path.join(dir, 'explorer-calls.txt');
  let choco;
  let explorer;
  if (windows) {
    choco = path.join(bin, 'choco.cmd');
    fs.writeFileSync(choco, `@echo off\r\necho %*>>"${calls}"\r\necho Chocolatey v2.4.3\r\nexit /b ${chocoExit}\r\n`);
    explorer = path.join(dir, 'explorer.cmd');
    fs.writeFileSync(explorer, `@echo off\r\necho %*>>"${opened}"\r\n`);
  } else {
    choco = path.join(bin, 'choco');
    fs.writeFileSync(choco, `#!/bin/sh\necho "$@" >> '${calls}'\necho 'Chocolatey v2.4.3'\nexit ${chocoExit}\n`, { mode: 0o755 });
    explorer = path.join(dir, 'explorer');
    fs.writeFileSync(explorer, `#!/bin/sh\necho "$@" >> '${opened}'\n`, { mode: 0o755 });
  }
  return { choco, explorer, calls, opened };
}

/**
 * The script as Update now builds it, with the paths pointed at the stubs.
 * Only the lines that name real Windows locations change; the trust check on
 * choco.exe needs a real administrator-owned file and stays out of the run.
 */
async function runScript({ pid, chocoExit = 0, installed = '1.4.1', target = '1.4.1', timeoutSec = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-update-now-'));
  const s = stubs(dir, { chocoExit, installed });
  let text = buildElevatedScript({
    pid, exePath: 'C:\\Program Files\\StepForge\\StepForge.exe', chocoPath: 'C:\\ProgramData\\chocolatey\\bin\\choco.exe', targetVersion: target,
  });
  const swap = (pattern, replacement) => {
    assert.match(text, pattern);
    text = text.replace(pattern, replacement);
  };
  swap(/^\$AppExe = .*$/m, `$AppExe = ${psQuote(APP)}`);
  swap(/^\$Choco = .*$/m, `$Choco = ${psQuote(s.choco)}`);
  swap(/^\$explorer = .*$/m, `$explorer = ${psQuote(s.explorer)}`);
  swap(/^function Test-TrustedChoco \{$/m, 'function Test-TrustedChoco { return $true }\r\nfunction Test-TrustedChoco-NotUsed {');
  if (!windows) swap(/'lib\\stepforge\\stepforge\.nuspec'/, "'lib/stepforge/stepforge.nuspec'");
  if (timeoutSec) swap(/-Timeout 120\b/, `-Timeout ${timeoutSec}`);

  // Asynchronous, so this process keeps reaping its own stand-in StepForge.
  const child = spawn(pwsh, ['-NoProfile', '-EncodedCommand', encodeCommand(text)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.stdin.end('\n\n\n');
  const timer = setTimeout(() => child.kill(), 60000);
  const status = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  const out = { status, output, choco: read(s.calls), opened: read(s.opened).map((l) => l.replace(/"/g, '').trim()) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/** A process to stand in for the running StepForge; it exits after `ms`. */
function fakeStepForge(ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
  return child;
}

test('the elevated script parses as PowerShell with no errors', { skip }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-update-now-')), 'update.ps1');
  fs.writeFileSync(file, buildElevatedScript({ pid: 1, exePath: 'C:\\a\\StepForge.exe', chocoPath: 'C:\\c\\bin\\choco.exe', targetVersion: '1.4' }));
  const cmd = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(file)}, [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`;
  const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('waits for StepForge to close, runs choco upgrade stepforge -y, then reopens it', { skip }, async () => {
  const app = fakeStepForge(3000);
  const exited = new Promise((resolve) => app.once('exit', resolve));
  const started = Date.now();
  const r = await runScript({ pid: app.pid });
  await exited;
  assert.equal(r.status, 0, r.output);
  assert.ok(Date.now() - started >= 2900, 'it waited for StepForge');
  assert.deepEqual(r.choco, ['upgrade stepforge -y']);
  assert.deepEqual(r.opened, [APP]);
  assert.match(r.output, /StepForge update/);
  assert.match(r.output, /Waiting for StepForge to close/);
  assert.match(r.output, /StepForge was updated\. Opening it/);
  assert.doesNotMatch(r.output, /Press Enter/, 'success closes by itself');
});

test('a StepForge that already closed does not hold the update up', { skip }, async () => {
  const r = await runScript({ pid: 2 ** 22 + 12345 });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.choco, ['upgrade stepforge -y']);
  assert.deepEqual(r.opened, [APP]);
});

test('a failed upgrade explains, shows the exit code and help, waits for Enter, and does not reopen', { skip }, async () => {
  const r = await runScript({ pid: 2 ** 22 + 12345, chocoExit: 1 });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Chocolatey could not update StepForge\./);
  assert.match(r.output, /failed with exit code 1\./);
  assert.match(r.output, /docs\/windows\/chocolatey\.md/);
  assert.match(r.output, /chocolatey\.log/);
  assert.match(r.output, /choco upgrade stepforge -y/);
  assert.match(r.output, /Press Enter to close this window/);
  assert.deepEqual(r.opened, []);
});

// Unix exit codes stop at 255, so only a Windows stub can return 3010.
test('a restart-pending exit code counts as success', { skip: skip || (windows ? false : 'needs Windows exit codes') }, async () => {
  const r = await runScript({ pid: 2 ** 22 + 12345, chocoExit: 3010 });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.opened, [APP]);
});

test('if StepForge never closes, choco is not run and the window says so', { skip }, async () => {
  const app = fakeStepForge(30000);
  try {
    const r = await runScript({ pid: app.pid, timeoutSec: 1 });
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /StepForge did not close/);
    assert.match(r.output, /Press Enter to close this window/);
    assert.deepEqual(r.choco, []);
    assert.deepEqual(r.opened, []);
  } finally {
    app.kill();
  }
});

test('when Chocolatey does not have the new version yet, the window says so before reopening', { skip }, async () => {
  const r = await runScript({ pid: 2 ** 22 + 12345, installed: '1.4.0.3', target: '1.4.1' });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Chocolatey does not have StepForge 1\.4\.1 yet, so StepForge 1\.4\.0\.3 is still installed\./);
  assert.match(r.output, /Press Enter to open StepForge/);
  assert.match(r.output, /StepForge was not changed\. Opening it/);
  assert.deepEqual(r.opened, [APP]);

  // "1.4" and "1.4.0.0" are the same version.
  const same = await runScript({ pid: 2 ** 22 + 12345, installed: '1.4.0.0', target: '1.4' });
  assert.doesNotMatch(same.output, /does not have/);
});

/**
 * The launcher as Update now runs it, with the elevation itself swapped for a
 * stand-in, since a test cannot answer a UAC prompt: the stand-in either
 * returns or throws the way Process.Start does.
 */
async function runLauncher(start) {
  const elevated = buildElevatedScript({ pid: 1, exePath: 'C:\\a\\StepForge.exe', chocoPath: 'C:\\c\\bin\\choco.exe', targetVersion: '1.4' });
  const real = '[void][System.Diagnostics.Process]::Start($info);';
  const launcher = buildLauncherCommand(elevated);
  assert.ok(launcher.includes(real));
  let command = launcher.replace(real, start);
  // Linux has no system directory for Join-Path to start from.
  if (!windows) command = command.replace('[Environment]::SystemDirectory', psQuote(os.tmpdir()));
  const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore', windowsHide: true });
  return new Promise((resolve) => child.once('close', resolve));
}

// A .NET method that throws, so PowerShell wraps the exception as it does a
// failed Process.Start.
const throwing = (code) => `[System.Runtime.ExceptionServices.ExceptionDispatchInfo]::Capture((New-Object System.ComponentModel.Win32Exception ${code})).Throw();`;

test('the launcher exits 0 once started, 2 for a declined UAC prompt, and 1 otherwise', { skip }, async () => {
  assert.equal(await runLauncher('$null = $info.Verb;'), EXIT_STARTED);
  assert.equal(await runLauncher(throwing(1223)), EXIT_DECLINED, 'ERROR_CANCELLED');
  assert.equal(await runLauncher(throwing(2)), 1, 'file not found is a failure, not a cancel');
  assert.equal(await runLauncher("throw 'unexpected';"), 1);
});
