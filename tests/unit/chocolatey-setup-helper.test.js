'use strict';
// Runs packaging/windows/chocolatey-setup.ps1 against a stub choco, so its
// choco calls, output parsing and never-fail paths are checked for real.
// Needs PowerShell (pwsh, or STEPFORGE_PWSH); skipped where it is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'packaging/windows/chocolatey-setup.ps1');
const pwsh = process.env.STEPFORGE_PWSH || 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;
const skip = hasPwsh ? false : 'PowerShell (pwsh) is not installed';

const FEED = 'https://packages.twestbrook.com/nuget/stepforge-choco/';
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A choco stand-in: answers from a scenario and records each call.
const STUB = String.raw`
$scenario = Get-Content -Raw -LiteralPath $env:STUB_SCENARIO | ConvertFrom-Json
Add-Content -LiteralPath $env:STUB_CALLS -Value ($args -join ' ')
$verb = $args[0]
if ($verb -eq '--version') { Write-Output $scenario.version; exit 0 }
if ($verb -eq 'source' -and $args[1] -eq 'list') { foreach ($l in $scenario.sources) { Write-Output $l }; exit 0 }
if ($verb -eq 'list') {
  if ($scenario.version -like '2.*' -and $args -contains '--local-only') {
    Write-Output 'Invalid argument --local-only. This argument has been removed from the list command and cannot be used.'
    exit 1
  }
  foreach ($l in $scenario.list) { Write-Output $l }
  exit 0
}
$code = $scenario.exit.$verb
if ($null -eq $code) { $code = 0 }
[Console]::Error.WriteLine("stub $verb")
exit $code
`;

function runHelper({ scenario, args = [], chocoFound = true, installChocolatey = 'throw' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-choco-helper-'));
  const stub = path.join(dir, 'choco-stub.ps1');
  const calls = path.join(dir, 'calls.txt');
  const result = path.join(dir, 'result.txt');
  fs.writeFileSync(stub, STUB);
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario || {}));
  fs.writeFileSync(calls, '');
  const programData = path.join(dir, 'ProgramData');
  fs.mkdirSync(programData);
  const driver = path.join(dir, 'driver.ps1');
  fs.writeFileSync(driver, [
    `$env:ProgramData = ${psQuote(programData)}`,
    `$env:STUB_SCENARIO = ${psQuote(path.join(dir, 'scenario.json'))}`,
    `$env:STUB_CALLS = ${psQuote(calls)}`,
    `. ${psQuote(helper)} ${args.join(' ')} -ResultFile ${psQuote(result)}`,
    chocoFound ? `function Find-Choco { return ${psQuote(stub)} }` : 'function Find-Choco { return $null }',
    installChocolatey === 'throw'
      ? "function Install-Chocolatey { throw 'The remote name could not be resolved' }"
      : "function Install-Chocolatey { $script:installed = $true }",
    'Invoke-Main',
    'exit 0',
  ].join('\n'));
  const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], { encoding: 'utf8' });
  const lines = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').split(/\r?\n/) : [];
  const out = {
    status: run.status,
    stderr: run.stderr,
    calls: fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean),
    result: lines[0],
    log: lines[1] && fs.existsSync(lines[1]) ? fs.readFileSync(lines[1], 'utf8') : '',
  };
  if (lines[1] && !lines[1].startsWith(dir)) fs.rmSync(lines[1], { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const v2 = (extra = {}) => ({ version: '2.4.3', sources: ['chocolatey|https://community.chocolatey.org/api/v2/|False|||0|False|False|False'], list: [], ...extra });

test('the helper parses as PowerShell with no errors', { skip }, () => {
  const cmd = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(helper)}, [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`;
  const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('Chocolatey 2: adds the feed and registers the exact version without running scripts', { skip }, () => {
  const r = runHelper({ scenario: v2(), args: ['-Version', '1.4.0.2'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result, 'ok', r.log);
  assert.deepEqual(r.calls, [
    '--version',
    'source list --limit-output',
    `source add --name=stepforge --source=${FEED}`,
    'list --exact stepforge --limit-output',
    `install stepforge --version 1.4.0.2 --source ${FEED} -y --skip-automation-scripts --no-progress`,
  ]);
});

test('Chocolatey 1: lists local packages with --local-only', { skip }, () => {
  const r = runHelper({ scenario: v2({ version: '1.4.0' }), args: ['-Version', '1.4.0'] });
  assert.equal(r.result, 'ok', r.log);
  assert.ok(r.calls.includes('list --local-only --exact stepforge --limit-output'), r.calls.join('\n'));
});

test('an existing source with the feed URL under any name is reused, and enabled if disabled', { skip }, () => {
  const sources = ['chocolatey|https://community.chocolatey.org/api/v2/|False|||0|False|False|False', 'mine|https://packages.twestbrook.com/nuget/stepforge-choco|False|||0|False|False|False'];
  let r = runHelper({ scenario: v2({ sources }), args: ['-Version', '1.4.0'] });
  assert.equal(r.result, 'ok', r.log);
  assert.ok(!r.calls.some((c) => c.startsWith('source add') || c.startsWith('source enable')), r.calls.join('\n'));

  sources[1] = sources[1].replace('|False|', '|True|');
  r = runHelper({ scenario: v2({ sources }), args: ['-Version', '1.4.0'] });
  assert.ok(r.calls.includes('source enable --name=mine'), r.calls.join('\n'));
});

test('an already registered version is left alone; another version is moved to this one', { skip }, () => {
  let r = runHelper({ scenario: v2({ list: ['Chocolatey v2.4.3', 'stepforge|1.4.0'] }), args: ['-Version', '1.4.0.0'] });
  assert.equal(r.result, 'ok', r.log);
  assert.ok(!r.calls.some((c) => /^(install|upgrade) /.test(c)), r.calls.join('\n'));

  r = runHelper({ scenario: v2({ list: ['stepforge|1.5.0'] }), args: ['-Version', '1.4.0'] });
  assert.equal(r.result, 'ok', r.log);
  assert.ok(r.calls.includes(`upgrade stepforge --version 1.4.0 --source ${FEED} -y --skip-automation-scripts --no-progress --allow-downgrade`), r.calls.join('\n'));
});

test('a version missing from the feed reports failure but still exits 0', { skip }, () => {
  const r = runHelper({ scenario: v2({ exit: { install: 1 } }), args: ['-Version', '9.9.9'] });
  assert.equal(r.status, 0);
  assert.equal(r.result, 'failed');
  assert.match(r.log, /choco install failed/);
});

test('no Chocolatey: fails unless asked to install it, and an offline install fails cleanly', { skip }, () => {
  let r = runHelper({ chocoFound: false, args: ['-Version', '1.4.0'] });
  assert.equal(r.status, 0);
  assert.equal(r.result, 'failed');
  assert.match(r.log, /installing it was not requested/);

  r = runHelper({ chocoFound: false, args: ['-Version', '1.4.0', '-InstallChocolatey'] });
  assert.equal(r.status, 0);
  assert.equal(r.result, 'failed');
  assert.match(r.log, /Unexpected error: The remote name could not be resolved/);
});

test('a missing or malformed version never runs choco', { skip }, () => {
  for (const args of [[], ['-Version', '"1.0; calc"']]) {
    const r = runHelper({ scenario: v2(), args });
    assert.equal(r.result, 'failed');
    assert.deepEqual(r.calls, []);
  }
});

test('-Uninstall unregisters without the package scripts or the auto-uninstaller, only if registered', { skip }, () => {
  let r = runHelper({ scenario: v2({ list: ['stepforge|1.4.0'] }), args: ['-Uninstall'] });
  assert.equal(r.result, 'ok', r.log);
  assert.equal(r.calls.at(-1), 'uninstall stepforge -y --skip-automation-scripts --skip-autouninstaller --no-progress');

  r = runHelper({ scenario: v2(), args: ['-Uninstall'] });
  assert.equal(r.result, 'ok', r.log);
  assert.ok(!r.calls.some((c) => c.startsWith('uninstall')));
});

test('run as a script, the helper always exits 0 and writes a result', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-choco-helper-'));
  const result = path.join(dir, 'result.txt');
  const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', helper, '-Version', 'not-a-version', '-ResultFile', result], {
    encoding: 'utf8',
    env: { ...process.env, ProgramData: dir },
  });
  assert.equal(run.status, 0, run.stderr);
  const [status, log] = fs.readFileSync(result, 'utf8').split(/\r?\n/);
  assert.equal(status, 'failed');
  if (log && !log.startsWith(dir)) fs.rmSync(log, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
