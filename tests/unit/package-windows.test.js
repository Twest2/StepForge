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
  chocolateyPackageVersion,
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
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const nsis = read('build/installer.nsh');
const installerPart = nsis.slice(nsis.indexOf('!ifndef BUILD_UNINSTALLER'), nsis.indexOf('!ifdef BUILD_UNINSTALLER'));
const uninstallerPart = nsis.slice(nsis.indexOf('!ifdef BUILD_UNINSTALLER'));

test('the version registered with Chocolatey is the one release.yml publishes', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(BUILD_VERSION, pkg.buildVersion || pkg.version);

  // release.yml takes the package version from the installer file name.
  const job = read('.github/workflows/release.yml').split('  publish-chocolatey:')[1];
  const pattern = job.match(/-notmatch '(\^StepForge Setup [^']+)'/)[1];
  const releaseName = new RegExp(pattern);
  const artifactName = createWindowsInstallerConfig('/tmp/x').nsis.artifactName;
  for (const version of ['1.4.0', '1.4.0.2', '0.3.2.1', '10.20.30.40', '1.4', '1.4.0-beta.1', '1.4.0"; calc', '']) {
    const fileName = artifactName.replace('${productName}', 'StepForge').replace('${buildVersion}', version).replace('${ext}', 'exe');
    const published = (fileName.match(releaseName) || [])[1] || null;
    assert.equal(chocolateyPackageVersion(version), published, `build version ${JSON.stringify(version)}`);
  }

  // package-windows.js hands it to makensis, and the installer passes it on.
  const script = read('scripts/package-windows.js');
  assert.match(script, /const chocoVersion = chocolateyPackageVersion\(BUILD_VERSION\);/);
  assert.match(script, /process\.env\.STEPFORGE_CHOCO_VERSION = chocoVersion;/);
  assert.match(script, /delete process\.env\.STEPFORGE_CHOCO_VERSION;/);
  assert.match(installerPart, /"\$%STEPFORGE_CHOCO_VERSION%"/);
  assert.match(installerPart, /-Version "\$\{STEPFORGE_CHOCO_VERSION\}"/);
});

test('an installer built without the version still builds, without the Updates page', () => {
  // makensis keeps an unset $%VAR% as literal text, so "!if ... == ''" alone
  // never fires; the "%" check does.
  assert.match(installerPart, /!searchreplace STEPFORGE_CHOCO_VERSION_NO_PCT "\$\{STEPFORGE_CHOCO_VERSION_ENV\}" "%" ""/);
  assert.doesNotMatch(nsis, /!error/);
  const init = installerPart.slice(installerPart.indexOf('!macro customInit'));
  assert.match(init, /!ifndef STEPFORGE_CHOCO_VERSION\s+StrCpy \$StepForgeChocoSkip "true"\s+!endif/);
  const install = installerPart.slice(installerPart.indexOf('!macro customInstall'));
  assert.match(install, /!ifdef STEPFORGE_CHOCO_VERSION\s+\$\{If\} \$StepForgeChocoSkip != "true"/);
});

test('the installer offers Chocolatey updates on a page after the desktop icon page, checked by default', () => {
  const desktop = nsis.indexOf('PageCallbacks StepForgeDesktopShortcutPagePre');
  const choco = nsis.indexOf('PageCallbacks StepForgeChocoPagePre');
  assert.ok(desktop > 0 && choco > desktop);
  assert.match(nsis, /"Keep StepForge updated with Chocolatey"/);
  assert.match(nsis, /"Install Chocolatey and keep StepForge updated with it"/);
  assert.match(nsis, /needs internet access and administrator approval/);
  assert.match(nsis, /switches StepForge to an all-users install/);
  assert.match(nsis, /StrCpy \$StepForgeChocoState "true"/);
  assert.match(nsis, /\$\{If\} \$StepForgeChocoSkip == "true"\s+Abort/);
});

test('the installer skips Chocolatey for silent installs without /chocolatey, upgrades and choco itself', () => {
  // StdUtils matches option names without their "/" (electron-builder's own
  // flags are tested the same way: "updated" for --updated).
  assert.match(installerPart, /\$\{If\} \$\{Silent\}\s+\$\{StdUtils\.TestParameter\} \$R9 "chocolatey"/);
  assert.doesNotMatch(nsis, /TestParameter \$R9 "\//);
  assert.match(installerPart, /\$\{If\} \$\{isUpdated\}\s+StrCpy \$StepForgeChocoSkip "true"/);
  for (const name of ['ChocolateyPackageName', 'ChocolateyPackageFolder', 'ChocolateyPackageVersion']) {
    assert.match(installerPart, new RegExp(`ReadEnvStr \\$0 ${name}\\s+\\$\\{If\\} \\$0 != ""\\s+StrCpy \\$StepForgeChocoSkip "true"`));
    assert.match(uninstallerPart, new RegExp(`ReadEnvStr \\$1 ${name}\\s+\\$\\{If\\} \\$1 != ""\\s+StrCpy \\$0 "false"`));
  }
  // ChocolateyInstall is permanent on any machine with choco, so it never means "choco is running us".
  assert.doesNotMatch(nsis, /ReadEnvStr \$[01] ChocolateyInstall\s+\$\{If\} \$[01] != ""\s+StrCpy \$(StepForgeChocoSkip|0)/);
});

test('the helper runs elevated once and any failure only shows a note', () => {
  const run = nsis.slice(nsis.indexOf('!macro StepForgeRunChocoHelper'), nsis.indexOf('!macroend'));
  assert.equal((nsis.match(/^\s*ExecShellWait /gm) || []).length, 1, 'one launcher macro');
  assert.match(run, /ExecShellWait "runas" "\$2" "\$\{ARGS\}" SW_HIDE/);
  assert.match(run, /\$\{If\} \$\{Errors\}\s+StrCpy \$4 "administrator approval was declined/);
  assert.match(run, /StrCpy \$3 "failed"/);
  assert.equal((nsis.match(/!insertmacro StepForgeRunChocoHelper \$1/g) || []).length, 2, 'install and uninstall');
  assert.match(installerPart, /\$\{If\} \$StepForgeChocoPresent != "true"\s+StrCpy \$1 "\$1 -InstallChocolatey"/);
  assert.match(installerPart, /MessageBox MB_OK\|MB_ICONINFORMATION "StepForge was installed, but Chocolatey updates were not set up\.[^"]*Details: \$4[^"]*docs\/windows\/chocolatey\.md"/);
  // Nothing after the helper can abort the install or uninstall.
  const after = nsis.slice(nsis.indexOf('!macro customInstall'));
  assert.doesNotMatch(after, /\b(Abort|Quit|SetErrorLevel)\b/);
});

test('the uninstaller unregisters only for interactive uninstalls of a registered StepForge', () => {
  assert.match(uninstallerPart, /\$\{If\} \$\{Silent\}\s+\$\{OrIf\} \$\{isUpdated\}\s+StrCpy \$0 "false"/);
  // Only the machine-wide ChocolateyInstall (administrators only) and an
  // actual registration trigger a UAC prompt.
  assert.match(uninstallerPart, /ReadRegStr \$1 HKLM "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" ChocolateyInstall/);
  assert.match(uninstallerPart, /\$\{AndIf\} \$\{FileExists\} "\$1\\lib\\stepforge\\stepforge\.nuspec"/);
  // The helper comes from inside the uninstaller, never from a copy on disk.
  assert.match(uninstallerPart, /File "\/oname=\$PLUGINSDIR\\chocolatey-setup\.ps1"/);
  assert.match(uninstallerPart, /-Uninstall -ResultFile/);
  assert.doesNotMatch(nsis, /ProgramData\\StepForge\\chocolatey-setup\.ps1|\$1\\StepForge\\chocolatey-setup\.ps1/);
});

test('Chocolatey packages do not shim the embedded installer', () => {
  const job = read('.github/workflows/release.yml').split('  publish-chocolatey:')[1];
  const copy = job.indexOf('Copy-Item -LiteralPath $installer.FullName');
  const ignore = job.indexOf('New-Item -ItemType File -Force -Path "packaging/windows/chocolatey/tools/$($installer.Name).ignore"');
  const pack = job.indexOf('choco pack');
  assert.ok(copy > 0 && ignore > copy && pack > ignore);
});
