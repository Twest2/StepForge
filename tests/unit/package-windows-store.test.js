'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { decodePng } = require('../../core/png');
const { APPX_ASSETS } = require('../../scripts/make-icons');
const { createWindowsInstallerConfig } = require('../../scripts/package-windows');
const {
  IDENTITY_FILE,
  TEST_IDENTITY,
  validateStoreIdentity,
  isUnconfigured,
  storeVersion,
  renderStoreManifest,
  createStorePackageConfig,
  createStorePackageBuildOptions,
  findStorePackage,
} = require('../../scripts/package-windows-store');

/**
 * The Microsoft Store package (scripts/package-windows-store.js). The package
 * itself needs Windows to build; CI builds it there. These check what goes
 * into it.
 */

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const IDENTITY = {
  displayName: 'StepForge',
  identityName: '12345CaseyExample.StepForge',
  publisher: 'CN=0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9',
  publisherDisplayName: 'Casey Example',
  productId: '9NBLGGH4R32N',
};

test('Store versions keep the fourth part 0 and grow with every StepForge release', () => {
  assert.equal(storeVersion('1.5.3'), '1.5.300.0');
  assert.equal(storeVersion('1.5.3.1'), '1.5.301.0');
  assert.equal(storeVersion('1.6'), '1.6.0.0');
  assert.equal(storeVersion('2'), '2.0.0.0');

  // Every release so far, in order, maps to a strictly newer Store version.
  const releases = ['0.3.2', '0.3.2.1', '0.3.3', '0.3.3.1', '0.4.0.0', '0.4.1.0', '0.4.1.1', '0.4.1.9', '0.5.0.0',
    '0.5.0.1', '0.6', '0.6.0.2', '0.6.1.0', '0.6.1.3', '0.7', '1.0', '1.1', '1.1.1', '1.3.5', '1.4', '1.4.1', '1.5', '1.5.3'];
  const numeric = (v) => v.split('.').map(Number);
  for (let i = 1; i < releases.length; i++) {
    const [a, b] = [numeric(storeVersion(releases[i - 1])), numeric(storeVersion(releases[i]))];
    const newer = a.findIndex((n, k) => n !== b[k]);
    assert.ok(newer >= 0 && b[newer] > a[newer], `${releases[i]} is newer than ${releases[i - 1]}`);
  }

  for (const bad of ['1.5.3.100', '1.0.700', '1.0.656', '70000.0', '1.0-beta', '', 'v1.0', '1.2.3.4.5']) {
    assert.throws(() => storeVersion(bad), undefined, bad);
  }
});

test('the identity must be the one Partner Center reserved, with a clear message when it is not', () => {
  assert.deepEqual(validateStoreIdentity(IDENTITY), IDENTITY);
  assert.equal(validateStoreIdentity({ ...IDENTITY, productId: '' }).productId, '', 'the Store ID is optional');
  assert.deepEqual(validateStoreIdentity({ ...IDENTITY, identityName: ` ${IDENTITY.identityName} ` }).identityName, IDENTITY.identityName);

  for (const [overrides, mentions] of [
    [{ displayName: '' }, /displayName \(the app name you reserved\)/],
    [{ displayName: 'Step<Forge>' }, /displayName/],
    [{ identityName: '' }, /identityName/],
    [{ identityName: 'Step Forge' }, /identityName/],
    [{ publisher: '0A1B2C3D' }, /publisher \(/],
    [{ publisher: "CN=x' Version='9" }, /publisher \(/],
    [{ publisherDisplayName: '' }, /publisherDisplayName/],
    [{ publisherDisplayName: 'A <b>' }, /publisherDisplayName/],
    [{ productId: 'abc' }, /productId/],
  ]) {
    assert.throws(() => validateStoreIdentity({ ...IDENTITY, ...overrides }), (err) => {
      assert.match(err.message, mentions);
      assert.match(err.message, /Partner Center → Product management → Product identity/);
      return true;
    });
  }
  assert.throws(() => validateStoreIdentity(null), /identityName/);
});

test('the committed identity file is either unfilled or a valid Partner Center identity', () => {
  const identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  assert.deepEqual(Object.keys(identity).sort(), ['displayName', 'identityName', 'productId', 'publisher', 'publisherDisplayName']);
  if (isUnconfigured(identity)) return;
  validateStoreIdentity(identity);
});

test('--if-configured skips the build only while nothing is filled in', () => {
  assert.equal(isUnconfigured({ displayName: '', identityName: '', publisher: '', publisherDisplayName: '', productId: '' }), true);
  assert.equal(isUnconfigured({ ...IDENTITY, productId: '' }), false);
  // Half filled in is a mistake to report, not a reason to skip.
  assert.equal(isUnconfigured({ displayName: '', identityName: IDENTITY.identityName, publisher: '', publisherDisplayName: '', productId: '' }), false);
});

test('the manifest carries the Store version and the stepforge.exe alias', () => {
  const manifest = renderStoreManifest('1.5.300.0');
  assert.match(manifest, /Version="1\.5\.300\.0"/);
  assert.doesNotMatch(manifest, /@STORE_VERSION@/);
  assert.match(manifest, /xmlns:uap3="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/uap\/windows10\/3"/);
  assert.match(manifest, /xmlns:desktop="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/desktop\/windows10"/);
  // electron-builder fills these; any it doesn't know fails the build.
  const macros = [...manifest.matchAll(/\$\{([a-zA-Z0-9]+)\}/g)].map((m) => m[1]);
  const known = ['publisher', 'publisherDisplayName', 'version', 'applicationId', 'identityName', 'executable', 'displayName',
    'description', 'backgroundColor', 'logo', 'square150x150Logo', 'square44x44Logo', 'lockScreen', 'defaultTile',
    'splashScreen', 'arch', 'resourceLanguages', 'capabilities', 'extensions', 'minVersion', 'maxVersionTested'];
  assert.deepEqual(macros.filter((m) => !known.includes(m)), []);
  assert.ok(macros.includes('extensions'));
  assert.throws(() => renderStoreManifest('1.5.3.1'), /invalid Store version/);

  const extensions = read('packaging/windows/store/extensions.xml');
  assert.match(extensions, /<uap3:Extension Category="windows\.appExecutionAlias" Executable="app\\StepForge\.exe" EntryPoint="Windows\.FullTrustApplication">/);
  assert.match(extensions, /<desktop:ExecutionAlias Alias="stepforge\.exe" \/>/);
  assert.doesNotMatch(extensions, /\$\{/, 'electron-builder inserts this file as is');
});

test('the Store package is the installer app with the Store identity, unsigned, for x64', () => {
  const config = createStorePackageConfig('/tmp/out', { identity: IDENTITY, manifestPath: '/tmp/work/appxmanifest.xml' });
  const installer = createWindowsInstallerConfig('/tmp/out');
  assert.deepEqual(config.files, installer.files);
  assert.equal(config.appId, installer.appId);
  assert.equal(config.productName, 'StepForge');
  assert.equal(config.buildVersion, installer.buildVersion);
  assert.deepEqual(config.win.target, ['appx']);
  assert.equal(config.nsis, undefined);
  assert.equal(config.appx.identityName, IDENTITY.identityName);
  assert.equal(config.appx.publisher, IDENTITY.publisher);
  assert.equal(config.appx.publisherDisplayName, IDENTITY.publisherDisplayName);
  assert.equal(config.appx.applicationId, 'StepForge');
  // The Store shows the reserved name, whatever it is.
  assert.equal(config.appx.displayName, 'StepForge');
  const renamed = createStorePackageConfig('/tmp/out', { identity: { ...IDENTITY, displayName: 'StepForge Guides' }, manifestPath: '/tmp/m.xml' });
  assert.equal(renamed.appx.displayName, 'StepForge Guides');
  assert.equal(renamed.appx.applicationId, 'StepForge', 'the application id never changes');
  assert.equal(config.appx.customManifestPath, '/tmp/work/appxmanifest.xml');
  assert.ok(fs.existsSync(path.join(root, config.appx.customExtensionsPath)));
  assert.deepEqual(config.extraMetadata, { microsoftStore: { productId: '9NBLGGH4R32N' } });
  assert.match(config.appx.artifactName, /\.\$\{ext\}$/);
  // The Store lists the languages StepForge's interface comes in, English first.
  assert.deepEqual(config.appx.languages, ['en-US', 'fr-FR', 'es-ES', 'ru-RU', 'zh-CN', 'ja-JP']);

  const options = createStorePackageBuildOptions('/tmp/out', { identity: TEST_IDENTITY, manifestPath: '/tmp/m.xml' });
  assert.equal(options.publish, 'never');
  assert.equal(options.config.appx.identityName, TEST_IDENTITY.identityName);
  const [[platform, archTargets]] = [...options.targets];
  assert.equal(platform.name, 'windows');
  assert.deepEqual([...archTargets.values()], [['appx']]);

  const tmp = makeTmpDir('store-package');
  try {
    assert.equal(findStorePackage(tmp), null);
    fs.writeFileSync(path.join(tmp, 'StepForge 1.5.3 Microsoft Store.appx'), 'fake');
    assert.equal(findStorePackage(tmp), path.join(tmp, 'StepForge 1.5.3 Microsoft Store.appx'));
  } finally {
    rmrf(tmp);
  }
});

test('the Store tiles are committed at the sizes the manifest names', () => {
  for (const [file, width, height] of APPX_ASSETS) {
    const png = decodePng(fs.readFileSync(path.join(root, 'build', 'appx', file)));
    assert.deepEqual([png.width, png.height], [width, height], file);
  }
  const names = APPX_ASSETS.map(([file]) => file);
  for (const required of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Wide310x150Logo.png']) {
    assert.ok(names.includes(required), required);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'build', 'appx')).sort(), [...names].sort(), 'nothing stray is packaged');
});

test('npm scripts and the release workflow build the Store package', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['package:windows:store'], 'node scripts/package-windows-store.js');
  assert.equal(pkg.scripts['package:windows:store:test'], 'node scripts/package-windows-store.js --test-identity');
  const job = read('.github/workflows/release.yml').split('  build-windows:')[1].split('\n  build-linux:')[0];
  // Not "npm run ... -- --flag": the Windows runners' PowerShell drops the "--".
  assert.match(job, /node scripts\/package-windows-store\.js --if-configured\n/);
  assert.match(job, /releases\/\*\.appx/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run package:windows:store:test\n/);
  assert.doesNotMatch(`${job}\n${ci}`, /package:windows:store -- /);
});
