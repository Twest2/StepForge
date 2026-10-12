'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const {
  createWindowsInstallerConfig,
  createWindowsInstallerBuildOptions,
  findInstallerExe,
  BUILD_VERSION,
} = require('../../scripts/package-windows');

test('Windows packaging uses an assisted NSIS installer', (t) => {
  const config = createWindowsInstallerConfig('/tmp/stepforge-output');

  assert.deepEqual(config.win.target, ['nsis']);
  assert.equal(config.win.icon, 'app/assets/stepforge.ico');
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  const ico = fs.readFileSync(path.resolve(__dirname, '../..', config.win.icon));
  assert.equal(ico.readUInt16LE(2), 1, 'Windows icon must be an ICO');
  assert.ok(ico.readUInt16LE(4) > 0, 'Windows icon must contain an image');
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.shortcutName, 'StepForge');
  assert.equal(config.buildVersion, '0.3.2.1');
  assert.equal(config.nsis.artifactName, '${productName} Setup ${buildVersion}.${ext}');
  assert.equal(config.nsis.include, 'build/installer.nsh');
  assert.equal(config.asar, true);
  assert.ok(config.files.includes('app/**/*'));
  assert.ok(config.files.includes('core/**/*'));
  assert.ok(config.files.includes('exporters/**/*'));
  assert.ok(!config.files.includes('assets/**/*'));

  const buildOptions = createWindowsInstallerBuildOptions('/tmp/stepforge-output');
  assert.equal(buildOptions.publish, 'never');
  assert.equal(buildOptions.config.publish, undefined);

  const tmp = makeTmpDir('windows-installer');
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, 'nested', 'deeper'), { recursive: true });
  const installer = path.join(tmp, 'nested', 'deeper', 'StepForge Setup 0.3.2.1.exe');
  fs.writeFileSync(installer, Buffer.from('fake installer'));
  assert.equal(findInstallerExe(tmp), installer);
});

const root = path.resolve(__dirname, '../..');
const nsis = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'packaging/windows/chocolatey-setup.ps1'), 'utf8');

test('the installer is built with the exact Chocolatey package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(BUILD_VERSION, pkg.buildVersion || pkg.version);
  const script = fs.readFileSync(path.join(root, 'scripts/package-windows.js'), 'utf8');
  assert.match(script, /process\.env\.STEPFORGE_CHOCO_VERSION = BUILD_VERSION;/);
  assert.match(nsis, /!define STEPFORGE_CHOCO_VERSION "\$%STEPFORGE_CHOCO_VERSION%"/);
  assert.match(nsis, /!error "STEPFORGE_CHOCO_VERSION is not set/);
  // The version is passed to the helper, and the file name uses the same number.
  assert.match(nsis, /-Version "\$\{STEPFORGE_CHOCO_VERSION\}"/);
  assert.match(createWindowsInstallerConfig('/tmp/x').nsis.artifactName, /Setup \$\{buildVersion\}/);
});

test('the installer offers Chocolatey updates on a page after the desktop icon page', () => {
  const desktop = nsis.indexOf('PageCallbacks StepForgeDesktopShortcutPagePre');
  const choco = nsis.indexOf('PageCallbacks StepForgeChocoPagePre');
  assert.ok(desktop > 0 && choco > desktop);
  assert.match(nsis, /Keep StepForge updated with Chocolatey/);
  assert.match(nsis, /Install Chocolatey and keep StepForge updated with it/);
  assert.match(nsis, /needs internet access and administrator approval/);
  assert.match(nsis, /switches StepForge to an all-users install/);
  // Checked by default.
  assert.match(nsis, /StrCpy \$StepForgeChocoState "true"/);
  assert.match(nsis, /BM_SETCHECK\} \$\{BST_CHECKED\}/);
});

test('the installer skips Chocolatey for silent installs, upgrades and choco itself', () => {
  assert.match(nsis, /\$\{StdUtils\.TestParameter\} \$R9 "\/chocolatey"/);
  assert.match(nsis, /\$\{If\} \$\{Silent\}\s+\$\{StdUtils\.TestParameter\}/);
  assert.match(nsis, /\$\{If\} \$\{isUpdated\}\s+StrCpy \$StepForgeChocoSkip "true"/);
  for (const name of ['ChocolateyPackageName', 'ChocolateyPackageFolder', 'ChocolateyPackageVersion']) {
    assert.match(nsis, new RegExp(`ReadEnvStr \\$0 ${name}`));
  }
  // ChocolateyInstall is permanent on any machine with choco, so it is only used to find choco.exe.
  assert.doesNotMatch(nsis, /ReadEnvStr \$0 ChocolateyInstall\s+\$\{If\} \$0 != ""\s+StrCpy \$StepForgeChocoSkip/);
  assert.match(nsis, /\$\{If\} \$StepForgeChocoSkip == "true"\s+Abort/);
});

test('the installer runs the helper once, elevated, and never fails the install', () => {
  assert.match(nsis, /File "\/oname=\$PLUGINSDIR\\chocolatey-setup\.ps1" "\$\{PROJECT_DIR\}\\packaging\\windows\\chocolatey-setup\.ps1"/);
  assert.equal((nsis.match(/ExecShellWait "runas"/g) || []).length, 2, 'one install launch, one uninstall launch');
  assert.match(nsis, /-InstallChocolatey/);
  assert.match(nsis, /\$StepForgeChocoPresent != "true"/);
  // Failure only shows a message that points at the log and the docs.
  assert.match(nsis, /StepForge was installed, but Chocolatey updates were not set up/);
  assert.match(nsis, /StepForge\\chocolatey-setup\.log/);
  assert.match(nsis, /docs\/windows\/chocolatey\.md/);
  assert.doesNotMatch(nsis, /Abort\s+\$\{EndIf\}\s+\$\{EndIf\}\s+!macroend/);
  assert.ok(!/ExecShellWait[^\n]*\n\s*(Abort|Quit)/.test(nsis));
});

test('the uninstaller unregisters from Chocolatey only for interactive user uninstalls', () => {
  const un = nsis.slice(nsis.indexOf('!macro customUnInstall'));
  assert.match(un, /\$\{If\} \$\{Silent\}\s+\$\{OrIf\} \$\{isUpdated\}/);
  assert.match(un, /ReadEnvStr \$1 ChocolateyPackageName/);
  assert.match(un, /-Uninstall'/);
  assert.match(nsis, /!ifdef BUILD_UNINSTALLER\s+;/);
});

test('the Chocolatey helper script covers discovery, idempotent setup and never fails', () => {
  // choco.exe lookup order.
  const env = helper.indexOf("$env:ChocolateyInstall");
  const onPath = helper.indexOf("Get-Command 'choco.exe'");
  const programData = helper.indexOf("'chocolatey\\bin\\choco.exe'");
  assert.ok(env > 0 && onPath > env && programData > onPath);
  // Official Chocolatey install command, only when asked for.
  assert.match(helper, /Set-ExecutionPolicy Bypass -Scope Process -Force/);
  assert.match(helper, /SecurityProtocol -bor 3072/);
  assert.match(helper, /DownloadString\('https:\/\/community\.chocolatey\.org\/install\.ps1'\)/);
  assert.match(helper, /if \(-not \$InstallChocolatey\)/);
  // Source added only if no source has the feed URL, under any name.
  assert.match(helper, /packages\.twestbrook\.com\/nuget\/stepforge-choco\//);
  assert.match(helper, /'source', 'list', '-r'/);
  assert.match(helper, /\$fields\[1\]\.Trim\(\)\.TrimEnd\('\/'\) -eq \$wanted/);
  assert.match(helper, /"--name=\$SourceName", "--source=\$FeedUrl"/);
  // Registers the exact version without running the installer again, once.
  assert.match(helper, /'--version', \$Version, '--source', \$FeedUrl, '-y', '--skip-automation-scripts'/);
  assert.match(helper, /if \(\$registered -eq \$Version\)/);
  assert.match(helper, /'uninstall', 'stepforge', '-y', '--skip-automation-scripts'/);
  // Logging and never-fail behavior.
  assert.match(helper, /Join-Path \$env:ProgramData 'StepForge'/);
  assert.match(helper, /chocolatey-setup\.log/);
  assert.match(helper, /catch \{\s+Write-Log "Unexpected error/);
  assert.match(helper, /\nexit 0\s*$/);
  assert.match(helper, /Write-Result 'failed'/);
  // Windows PowerShell 5.1 compatible: no PowerShell 7 syntax.
  assert.doesNotMatch(helper, /\?\?|SkipHttpErrorCheck|\?\s.*\s:\s/);
});
