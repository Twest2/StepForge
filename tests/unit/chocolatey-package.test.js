'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the Chocolatey package ships the tools folder under the stepforge id', () => {
  const nuspec = read('packaging/windows/chocolatey/stepforge.nuspec');
  assert.match(nuspec, /<id>stepforge<\/id>/);
  assert.match(nuspec, /<file src="tools\\\*\*" target="tools" \/>/);
  assert.match(nuspec, /docs\/windows_installation\.md/);
});

test('install and uninstall run the NSIS installer silently for all users', () => {
  const install = read('packaging/windows/chocolatey/tools/chocolateyinstall.ps1');
  assert.match(install, /-Filter 'StepForge Setup \*\.exe'/);
  assert.match(install, /silentArgs\s+= '\/S \/allusers'/);
  assert.match(install, /Install-ChocolateyInstallPackage/);
  // A wizard "only for me" install is replaced, not duplicated.
  assert.match(install, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
  const uninstall = read('packaging/windows/chocolatey/tools/chocolateyuninstall.ps1');
  assert.match(uninstall, /Get-UninstallRegistryKey -SoftwareName 'StepForge\*'/);
  assert.match(uninstall, /\/S"\.Trim\(\)/);
});

test('stable releases publish the Chocolatey package to ProGet from the Windows installer artifact', () => {
  const workflow = read('.github/workflows/release.yml');
  const job = workflow.slice(workflow.indexOf('  publish-chocolatey:'));
  assert.ok(job.length > 0 && workflow.includes('  publish-chocolatey:'));
  assert.match(job, /needs: release/);
  assert.match(job, /if: inputs\.prerelease == false/);
  assert.match(job, /name: windows-installer/);
  assert.match(job, /choco pack packaging\/windows\/chocolatey\/stepforge\.nuspec --version \$version/);
  assert.match(job, /PROGET_CHOCO_FEED: \$\{\{ vars\.PROGET_CHOCO_FEED \|\| 'stepforge-choco' \}\}/);
  assert.match(job, /choco push .*--source "\$base\/nuget\/\$env:PROGET_CHOCO_FEED\/"/);
  // Installer names come from package-windows.js: "StepForge Setup <buildVersion>.exe".
  assert.match(read('scripts/package-windows.js'), /artifactName: '\$\{productName\} Setup \$\{buildVersion\}\.\$\{ext\}'/);
});
