#!/usr/bin/env node
'use strict';

// Builds the Microsoft Store package (.appx) that is uploaded to Partner
// Center. The Store signs it, so it is never signed here. Needs Windows (the
// Windows SDK's makeappx), so it runs in CI; see docs/windows/MICROSOFT_STORE_RELEASE.md.
//
//   npm run package:windows:store                            # the identity in packaging/windows/store/identity.json
//   node scripts/package-windows-store.js --if-configured    # the same, skipped while identity.json is unfilled
//   npm run package:windows:store:test                       # a placeholder identity, to check the build
//
// The flags are passed in package.json or straight to node: PowerShell drops
// the "--" in "npm run x -- --flag", and npm then takes the flag for itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { build, Platform, Arch } = require('electron-builder');
const { APP_ID, BUILD_VERSION, createWindowsInstallerConfig } = require('./package-windows');

const ROOT_DIR = path.resolve(__dirname, '..');
const STORE_DIR = path.join(ROOT_DIR, 'packaging', 'windows', 'store');
const IDENTITY_FILE = path.join(STORE_DIR, 'identity.json');
const MANIFEST_TEMPLATE = path.join(STORE_DIR, 'appxmanifest.xml');

// Stands in for the Partner Center identity in CI build checks. Partner
// Center rejects a package with any other identity than the reserved one.
const TEST_IDENTITY = {
  displayName: 'StepForge',
  identityName: 'StepForge.BuildCheck',
  publisher: 'CN=StepForge Build Check',
  publisherDisplayName: 'StepForge build check',
  productId: '',
};

/**
 * The name reserved in Partner Center, which the Store requires as the app's
 * display name, and the identity Partner Center assigned with it (Product
 * management → Product identity). Throws with what is missing or malformed.
 */
function validateStoreIdentity(identity) {
  const problems = [];
  const value = (key) => (identity && typeof identity[key] === 'string' ? identity[key].trim() : '');
  if (!value('displayName') || value('displayName').length > 256 || /[<>&]/.test(value('displayName'))) problems.push('displayName (the app name you reserved)');
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(value('identityName'))) problems.push('identityName (Package/Identity/Name)');
  if (!/^CN=[^<>&']+$/.test(value('publisher'))) problems.push('publisher (Package/Identity/Publisher, starts with "CN=")');
  if (!value('publisherDisplayName') || /[<>&]/.test(value('publisherDisplayName'))) problems.push('publisherDisplayName (Package/Properties/PublisherDisplayName)');
  if (value('productId') && !/^[0-9A-Z]{12}$/.test(value('productId'))) problems.push('productId (the 12-character Store ID), or leave it empty');
  if (problems.length) {
    throw new Error(`packaging/windows/store/identity.json is missing or has an invalid ${problems.join(', ')}. Copy the values from Partner Center → Product management → Product identity.`);
  }
  return {
    displayName: value('displayName'),
    identityName: value('identityName'),
    publisher: value('publisher'),
    publisherDisplayName: value('publisherDisplayName'),
    productId: value('productId'),
  };
}

/**
 * The Store version for a StepForge build version. The Store reserves the
 * fourth part and needs it to be 0, and every submission must be newer than
 * the last, so a.b.c.d becomes a.b.(c*100+d).0: 1.5.3 → 1.5.300.0 and
 * 1.5.3.1 → 1.5.301.0. Each part must fit in 16 bits.
 */
function storeVersion(buildVersion) {
  const parts = String(buildVersion || '').split('.');
  if (parts.length < 1 || parts.length > 4 || !parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part))) {
    throw new Error(`Build version ${JSON.stringify(buildVersion)} is not a numeric version.`);
  }
  const [major, minor = 0, patch = 0, revision = 0] = parts.map(Number);
  if (revision > 99) throw new Error(`Build version ${buildVersion}: the fourth part must be below 100 for the Store version.`);
  const build = patch * 100 + revision;
  if ([major, minor, build].some((n) => n > 65535)) throw new Error(`Build version ${buildVersion} does not fit a Store version.`);
  return `${major}.${minor}.${build}.0`;
}

/** The manifest template with the Store version filled in. */
function renderStoreManifest(version, template = fs.readFileSync(MANIFEST_TEMPLATE, 'utf8')) {
  if (!/^\d+\.\d+\.\d+\.0$/.test(version)) throw new Error(`invalid Store version ${version}`);
  return template.replace('Version="@STORE_VERSION@"', `Version="${version}"`);
}

function createStorePackageConfig(outputDir, { identity, manifestPath }) {
  const installer = createWindowsInstallerConfig(outputDir);
  return {
    appId: APP_ID,
    productName: installer.productName,
    buildVersion: installer.buildVersion,
    directories: installer.directories,
    files: installer.files,
    asar: installer.asar,
    compression: installer.compression,
    // The Store ID lets Settings → About open StepForge's Store page
    // (app/windows-store.js).
    extraMetadata: { microsoftStore: { productId: identity.productId } },
    win: {
      icon: installer.win.icon,
      target: ['appx'],
    },
    // Tiles and logos come from build/appx/ (npm run icons).
    appx: {
      identityName: identity.identityName,
      publisher: identity.publisher,
      publisherDisplayName: identity.publisherDisplayName,
      // Fixed: changing it would unpin StepForge from users' Start menus.
      applicationId: 'StepForge',
      // Must be a name reserved in Partner Center, or certification fails.
      displayName: identity.displayName,
      backgroundColor: 'transparent',
      languages: ['en-US'],
      minVersion: '10.0.17763.0',
      maxVersionTested: '10.0.26100.0',
      customManifestPath: manifestPath,
      customExtensionsPath: 'packaging/windows/store/extensions.xml',
      artifactName: '${productName} ${buildVersion} Microsoft Store.${ext}',
    },
  };
}

function createStorePackageBuildOptions(outputDir, options) {
  return {
    targets: Platform.WINDOWS.createTarget('appx', Arch.x64),
    config: createStorePackageConfig(outputDir, options),
    publish: 'never',
  };
}

function findStorePackage(dir) {
  if (!fs.existsSync(dir)) return null;
  const found = fs.readdirSync(dir).find((name) => name.toLowerCase().endsWith('.appx'));
  return found ? path.join(dir, found) : null;
}

/** Nothing filled in yet: the app has not been reserved in Partner Center. */
function isUnconfigured(identity) {
  return Boolean(identity) && Object.values(identity).every((value) => value === '');
}

async function buildStorePackage({ testIdentity = false, ifConfigured = false } = {}) {
  const stored = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  if (!testIdentity && ifConfigured && isUnconfigured(stored)) {
    console.log('packaging/windows/store/identity.json is not filled in yet; skipping the Microsoft Store package.');
    return null;
  }
  const identity = testIdentity ? TEST_IDENTITY : validateStoreIdentity(stored);
  const releaseDir = path.resolve(process.env.STEPFORGE_RELEASE_DIR || path.join(ROOT_DIR, 'releases'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-store-'));
  const outputDir = path.join(workDir, 'output');
  const manifestPath = path.join(workDir, 'appxmanifest.xml');
  const version = storeVersion(BUILD_VERSION);

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(manifestPath, renderStoreManifest(version));
  // The Store signs the package. A certificate for the .exe installer has a
  // different publisher, and electron-builder would sign with it.
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name];

  try {
    await build(createStorePackageBuildOptions(outputDir, { identity, manifestPath }));
  } catch (err) {
    throw new Error(`Microsoft Store package build failed: ${err.message}`);
  }

  const built = findStorePackage(outputDir);
  if (!built) throw new Error(`No .appx package was produced in ${outputDir}`);
  const target = path.join(releaseDir, path.basename(built));
  fs.copyFileSync(built, target);
  console.log(`StepForge ${BUILD_VERSION} Microsoft Store package (Store version ${version}${testIdentity ? ', test identity' : ''}) written to ${target}`);
  return target;
}

if (require.main === module) {
  buildStorePackage({
    testIdentity: process.argv.includes('--test-identity'),
    ifConfigured: process.argv.includes('--if-configured'),
  }).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {
  IDENTITY_FILE,
  TEST_IDENTITY,
  validateStoreIdentity,
  isUnconfigured,
  storeVersion,
  renderStoreManifest,
  createStorePackageConfig,
  createStorePackageBuildOptions,
  findStorePackage,
  buildStorePackage,
};
