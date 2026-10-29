'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  DEFAULT_CHOCOLATEY_ROOT,
  EXIT_DECLINED,
  isSafeWindowsPath,
  psQuote,
  chocolateyStatus,
  updateNowAvailable,
  buildElevatedScript,
  buildLauncherCommand,
  launchElevated,
  updateNow,
} = require('../../app/windows-update');

/**
 * Settings → About "Update now" on Windows (app/windows-update.js): when it
 * is offered, the exact commands it would run elevated, and the refusals.
 * Nothing here runs PowerShell; windows-update-script.test.js does, where
 * PowerShell is installed.
 */

const EXE = 'C:\\Users\\Casey\\AppData\\Local\\Programs\\StepForge\\StepForge.exe';
const CHOCO = 'C:\\ProgramData\\chocolatey\\bin\\choco.exe';

/** An fs with just statSync, holding the given files (and their folders). */
function fakeFs(files) {
  const all = new Set(files.map((f) => f.toLowerCase()));
  return {
    statSync(file) {
      const key = String(file).toLowerCase();
      if (all.has(key)) return { isFile: () => true };
      if ([...all].some((f) => f.startsWith(`${key}\\`))) return { isFile: () => false };
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
  };
}

const registeredAt = (root) => fakeFs([`${root}\\lib\\stepforge\\stepforge.nuspec`, `${root}\\bin\\choco.exe`]);

const decode = (base64) => Buffer.from(base64, 'base64').toString('utf16le');
const encodedIn = (launcher) => /-EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(launcher)[1];

/** The script with its string literals blanked, so only syntax is left to inspect. */
function withoutStrings(script) {
  return script.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
}

const script = (overrides = {}) => buildElevatedScript({ pid: 4242, exePath: EXE, chocoPath: CHOCO, targetVersion: '1.4.1', ...overrides });

test('registration: %ChocolateyInstall%\\lib\\stepforge with its nuspec, and choco.exe beside it', () => {
  const root = 'D:\\Tools\\chocolatey';
  const status = chocolateyStatus({ env: { ChocolateyInstall: root }, fs: registeredAt(root) });
  assert.deepEqual(status, { registered: true, root, chocoPath: `${root}\\bin\\choco.exe` });

  // No ChocolateyInstall: Chocolatey's default folder.
  assert.equal(DEFAULT_CHOCOLATEY_ROOT, 'C:\\ProgramData\\chocolatey');
  const fallback = chocolateyStatus({ env: {}, fs: registeredAt(DEFAULT_CHOCOLATEY_ROOT) });
  assert.equal(fallback.registered, true);
  assert.equal(fallback.chocoPath, CHOCO);
  // A set variable is used as is, not the default.
  assert.equal(chocolateyStatus({ env: { ChocolateyInstall: root }, fs: registeredAt(DEFAULT_CHOCOLATEY_ROOT) }).registered, false);
});

test('registration needs both the package and choco.exe', () => {
  const root = DEFAULT_CHOCOLATEY_ROOT;
  const env = { ChocolateyInstall: root };
  assert.equal(chocolateyStatus({ env, fs: fakeFs([`${root}\\bin\\choco.exe`]) }).registered, false, 'Chocolatey without StepForge');
  assert.equal(chocolateyStatus({ env, fs: fakeFs([`${root}\\lib\\stepforge\\stepforge.nuspec`]) }).registered, false, 'no choco.exe');
  // An empty package folder, or a folder named like the nuspec, is not a registration.
  assert.equal(chocolateyStatus({ env, fs: fakeFs([`${root}\\lib\\stepforge\\tools\\x.ps1`, `${root}\\bin\\choco.exe`]) }).registered, false);
  assert.equal(chocolateyStatus({ env, fs: fakeFs([`${root}\\lib\\stepforge\\stepforge.nuspec\\x`, `${root}\\bin\\choco.exe`]) }).registered, false);
  assert.equal(chocolateyStatus({ env, fs: fakeFs([]) }).chocoPath, null);
});

test('a ChocolateyInstall that is not a plain local path is never used', () => {
  for (const bad of ['chocolatey', '..\\chocolatey', '\\\\server\\share\\chocolatey', 'C:\\choco"x', "C:\\a\nb", 'C:\\a\\..\\b']) {
    const status = chocolateyStatus({ env: { ChocolateyInstall: bad }, fs: { statSync: () => ({ isFile: () => true }) } });
    assert.equal(status.registered, false, JSON.stringify(bad));
  }
});

test('Update now is offered only in the packaged Windows app', () => {
  const env = {};
  const fsImpl = registeredAt(DEFAULT_CHOCOLATEY_ROOT);
  assert.equal(updateNowAvailable({ platform: 'win32', packaged: true, env, fs: fsImpl }), true);
  assert.equal(updateNowAvailable({ platform: 'linux', packaged: true, env, fs: fsImpl }), false);
  assert.equal(updateNowAvailable({ platform: 'win32', packaged: false, env, fs: fsImpl }), false, 'not from a development build');
  assert.equal(updateNowAvailable({ platform: 'win32', packaged: true, env, fs: fakeFs([]) }), false);
  assert.equal(updateNowAvailable({ platform: 'win32', packaged: true, store: true, env, fs: fsImpl }), false,
    'a Microsoft Store install is updated by the Store, even beside a registered installer copy');
});

test('PowerShell literals double every kind of single quote', () => {
  assert.equal(psQuote("C:\\Users\\O'Brien\\x.exe"), "'C:\\Users\\O''Brien\\x.exe'");
  assert.equal(psQuote('a\u2019b\u2018c\u201ad\u201be'), "'a\u2019\u2019b\u2018\u2018c\u201a\u201ad\u201b\u201be'");
  assert.equal(psQuote('$(Remove-Item C:\\)'), "'$(Remove-Item C:\\)'", 'no expansion inside single quotes');
  assert.equal(isSafeWindowsPath(EXE, { exe: true }), true);
  assert.equal(isSafeWindowsPath('C:\\x\\StepForge.dll', { exe: true }), false);
});

test('the elevated script embeds only the validated PID and paths, quoted', () => {
  const tricky = "C:\\Users\\O'Brien ’x\\AppData\\Local\\Programs\\StepForge\\StepForge.exe";
  const text = script({ exePath: tricky });
  assert.match(text, /^\$StepForgePid = 4242$/m);
  assert.ok(text.includes(`$AppExe = 'C:\\Users\\O''Brien ’’x\\AppData\\Local\\Programs\\StepForge\\StepForge.exe'`));
  assert.ok(text.includes(`$Choco = '${CHOCO}'`));
  assert.ok(text.includes("$TargetVersion = '1.4.1'"));

  for (const bad of [
    { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: '4242' }, { pid: 2 ** 33 },
    { exePath: 'StepForge.exe' }, { exePath: 'C:\\x\\StepForge.exe\r\nRemove-Item C:\\' }, { exePath: 'C:\\x\\"StepForge.exe' },
    { exePath: '\\\\server\\StepForge.exe' }, { exePath: 'C:\\x\\notes.txt' },
    { chocoPath: 'C:\\Temp\\evil.exe' }, { chocoPath: 'choco.exe' },
    { targetVersion: '1.4; Remove-Item C:\\' }, { targetVersion: '' }, { targetVersion: '1.2.3.4.5' },
  ]) {
    assert.throws(() => script(bad), /invalid/, JSON.stringify(bad));
  }
});

test('the elevated script waits for StepForge, upgrades only StepForge, and reopens it unelevated', () => {
  const text = script();
  // Exactly one choco call, the StepForge upgrade, never "upgrade all".
  const chocoCalls = text.split(/\r\n/).filter((line) => /^\s*&\s*\$Choco\b/.test(line));
  assert.deepEqual(chocoCalls.map((l) => l.trim()), ['& $Choco upgrade stepforge -y']);
  assert.doesNotMatch(text, /upgrade\s+all/i);
  assert.doesNotMatch(text, /\b(install|uninstall)\s+stepforge/i);

  // A visible window with a heading.
  assert.match(text, /WindowTitle = 'Updating StepForge'/);
  assert.match(text, /Write-Host '  StepForge update'/);
  assert.doesNotMatch(text, /-WindowStyle\s+Hidden/i);

  // Waits for this StepForge to exit, with a deadline, before choco runs.
  const wait = text.indexOf('Wait-Process -Id $StepForgePid -Timeout 120');
  assert.ok(wait > 0);
  assert.ok(wait < text.indexOf('& $Choco upgrade stepforge -y'));
  assert.match(text, /if \(Get-Process -Id \$StepForgePid -ErrorAction SilentlyContinue\) \{\r\n\s+Exit-WithError 'StepForge did not close within 2 minutes/);

  // Failures explain, show the exit code and where to get help, and wait for Enter.
  const failure = /function Exit-WithError \{[\s\S]*?\r\n\}/.exec(text)[0];
  assert.match(failure, /Read-Host 'Press Enter to close this window'/);
  assert.match(failure, /exit 1/);
  assert.match(failure, /\$HelpUrl/);
  assert.match(failure, /\$ChocoLog/);
  assert.match(text, /\$HelpUrl = 'https:\/\/github\.com\/Twest2\/StepForge\/blob\/main\/docs\/windows\/chocolatey\.md'/);
  assert.match(text, /\$ChocoLog = Join-Path \$ChocoRoot 'logs\\chocolatey\.log'/);
  assert.match(text, /if \(@\(0, 1641, 3010\) -notcontains \$code\) \{\r\n\s+Exit-WithError 'Chocolatey could not update StepForge\.' "choco upgrade stepforge -y failed with exit code \$code\."/);

  // choco.exe must be the machine-wide one or owned by an administrator.
  assert.ok(text.indexOf('if (-not (Test-TrustedChoco))') < text.indexOf('& $Choco upgrade'));
  assert.match(text, /GetEnvironmentVariable\('ChocolateyInstall', 'Machine'\)/);

  // Success reopens StepForge through Explorer, as a normal app.
  assert.match(text, /\$explorer = Join-Path \(\[Environment\]::GetFolderPath\('Windows'\)\) 'explorer\.exe'/);
  assert.match(text, /Start-Process -FilePath \$explorer -ArgumentList \('"' \+ \$app \+ '"'\)/);
  assert.doesNotMatch(text, /Start-Process -FilePath \$app/);
  assert.ok(text.indexOf('Start-Process -FilePath $explorer') > text.indexOf('& $Choco upgrade'));
});

test('both scripts are Windows PowerShell 5.1 syntax, and the script text is ASCII', () => {
  const elevated = script();
  const launcher = buildLauncherCommand(elevated);
  for (const [name, text] of [['elevated', elevated], ['launcher', launcher]]) {
    const code = withoutStrings(text);
    assert.doesNotMatch(code, /\?\?/, `${name}: null-coalescing is PowerShell 7`);
    assert.doesNotMatch(code, /\?\./, `${name}: null-conditional member access is PowerShell 7`);
    assert.doesNotMatch(code, /&&|\|\|/, `${name}: pipeline chains are PowerShell 7`);
    assert.doesNotMatch(code, /\s\?\s[^:]*\s:\s/, `${name}: the ternary operator is PowerShell 7`);
    assert.doesNotMatch(code, /-Parallel|\bclean\s*\{/i, `${name}: PowerShell 7 only`);
  }
  assert.match(script({ exePath: 'C:\\Users\\Zoë\\StepForge\\StepForge.exe' }).replace(/^\$AppExe = .*$/m, ''), /^[\x00-\x7f]*$/);
});

test('the launcher asks for elevation without double quotes and passes the script encoded', () => {
  const elevated = script();
  const launcher = buildLauncherCommand(elevated);
  assert.doesNotMatch(launcher, /"/, 'nothing for the command line to re-quote');
  assert.doesNotMatch(launcher, /[\r\n]/);
  assert.equal(decode(encodedIn(launcher)), elevated, 'the elevated window runs exactly this script');
  assert.match(launcher, /\$info\.FileName = Join-Path \(\[Environment\]::SystemDirectory\) 'WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.match(launcher, /\$info\.Arguments = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+'/);
  assert.match(launcher, /\$info\.Verb = 'runas'/);
  assert.match(launcher, /\$info\.UseShellExecute = \$true/);
  assert.doesNotMatch(launcher, /-File\b|\.ps1/i, 'no script file is run elevated');
  // Declined UAC (ERROR_CANCELLED) is told apart from other failures.
  assert.match(launcher, /exit 0 \} catch \{/);
  assert.match(launcher, /NativeErrorCode -eq 1223\)\) \{ exit 2 \}/);
  assert.match(launcher, /\} exit 1 \}$/);
  // Far below the 32,767-character command-line limit, even with long paths.
  const long = `C:\\${'x'.repeat(200)}\\${'y'.repeat(200)}\\StepForge.exe`;
  assert.ok(buildLauncherCommand(script({ exePath: long })).length < 25000);
});

/** A spawn stand-in: records the call and exits with `code` (or fails to start). */
function fakeSpawn({ code = 0, error = null, throws = false } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    if (throws) throw new Error('spawn EACCES');
    const child = new EventEmitter();
    setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', code, null)));
    return child;
  };
  return { spawnImpl, calls };
}

test('the launcher runs hidden in Windows PowerShell and reports started, declined or failed', async () => {
  const started = fakeSpawn({ code: 0 });
  assert.deepEqual(await launchElevated('cmd', { spawnImpl: started.spawnImpl, env: { SystemRoot: 'C:\\Windows' } }), { started: true });
  const [call] = started.calls;
  assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-Command', 'cmd']);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, undefined, 'no cmd.exe in between');

  assert.deepEqual(await launchElevated('cmd', { spawnImpl: fakeSpawn({ code: EXIT_DECLINED }).spawnImpl }), { started: false, declined: true });
  assert.deepEqual(await launchElevated('cmd', { spawnImpl: fakeSpawn({ code: 1 }).spawnImpl }), { started: false, declined: false });
  assert.deepEqual(await launchElevated('cmd', { spawnImpl: fakeSpawn({ error: new Error('ENOENT') }).spawnImpl }), { started: false, declined: false });
  assert.deepEqual(await launchElevated('cmd', { spawnImpl: fakeSpawn({ throws: true }).spawnImpl }), { started: false, declined: false });

  // A strange SystemRoot is not trusted.
  const odd = fakeSpawn();
  await launchElevated('cmd', { spawnImpl: odd.spawnImpl, env: { SystemRoot: 'relative' } });
  assert.equal(odd.calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

const found = { status: 'update-available', latestVersion: '1.4.1', currentVersion: '1.4' };

function run(overrides = {}) {
  const launches = [];
  const launch = async (command) => { launches.push(command); return overrides.outcome || { started: true }; };
  const result = updateNow({
    platform: 'win32', packaged: true, env: {}, fs: registeredAt(DEFAULT_CHOCOLATEY_ROOT),
    lastCheck: found, pid: 4242, exePath: EXE, launch, ...overrides,
  });
  return result.then((value) => ({ result: value, launches }));
}

test('app:updateNow refuses off Windows, in a development build, and when not registered', async () => {
  for (const [overrides, reason] of [
    [{ platform: 'linux' }, 'unsupported'],
    [{ platform: 'darwin' }, 'unsupported'],
    [{ packaged: false }, 'unsupported'],
    [{ store: true }, 'unsupported'],
    [{ fs: fakeFs([]) }, 'not-registered'],
    [{ env: { ChocolateyInstall: 'D:\\elsewhere' } }, 'not-registered'],
    [{ lastCheck: null }, 'no-update'],
    [{ lastCheck: { status: 'up-to-date', latestVersion: '1.4' } }, 'no-update'],
    [{ exePath: 'C:\\x\\"StepForge.exe' }, 'failed'],
  ]) {
    const { result, launches } = await run(overrides);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.reason, reason, JSON.stringify(overrides));
    assert.equal(launches.length, 0, 'nothing was started');
  }
});

test('app:updateNow starts the elevated update for this StepForge and the version the check found', async () => {
  const { result, launches } = await run();
  assert.deepEqual(result, { ok: true });
  assert.equal(launches.length, 1);
  const elevated = decode(encodedIn(launches[0]));
  assert.match(elevated, /^\$StepForgePid = 4242$/m);
  assert.ok(elevated.includes(`$AppExe = '${EXE}'`));
  assert.ok(elevated.includes(`$Choco = '${CHOCO}'`));
  assert.ok(elevated.includes("$TargetVersion = '1.4.1'"));
});

test('a declined UAC prompt keeps StepForge open and says the update was cancelled', async () => {
  const declined = await run({ outcome: { started: false, declined: true } });
  assert.deepEqual(declined.result, { ok: false, reason: 'declined', message: 'Update cancelled' });
  const failed = await run({ outcome: { started: false, declined: false } });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.reason, 'failed');
  assert.match(failed.result.message, /Couldn’t start the update/);
});

test('main.js wires app:updateNow without renderer input and quits only once the update started', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
  const start = main.indexOf("h('app:updateNow'");
  assert.ok(start > 0);
  const handler = main.slice(start, main.indexOf('\n  });', start) + 60);
  assert.match(handler, /^h\('app:updateNow', async \(\) => \{/, 'the handler ignores its arguments');
  assert.match(handler, /validate: \(a\) => Object\.keys\(a\)\.length === 0/);
  assert.match(handler, /platform: process\.platform,\s+packaged: app\.isPackaged,\s+store: windowsStore\.isStoreInstall\(\),\s+lastCheck: lastUpdateCheck,/);
  assert.match(handler, /if \(result\.ok\) setTimeout\(\(\) => app\.quit\(\), \d+\);/, 'the normal quit path, which drains pending writes');
  assert.doesNotMatch(handler, /app\.exit|process\.exit|kill/);
  const preload = fs.readFileSync(path.join(__dirname, '../../app/preload.js'), 'utf8');
  assert.match(preload, /updateNow: invoke\('app:updateNow'\),/);
});
