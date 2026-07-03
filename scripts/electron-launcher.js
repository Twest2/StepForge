'use strict';

// Diagnostics-only Electron launcher helpers.
//
// This module never installs, rebuilds, or repairs dependencies at runtime.
// The only supported dependency installation path is `npm ci` on the pinned
// Node toolchain (see .nvmrc / package.json engines). A desktop launcher that
// mutates node_modules silently drifts away from package-lock.json and can
// download code at runtime; when the runtime is missing we fail with
// actionable diagnostics instead.

const fs = require('node:fs');
const path = require('node:path');

const ELECTRON_SKIP_ENV_KEYS = [
  'ELECTRON_SKIP_BINARY_DOWNLOAD',
  'npm_config_electron_skip_binary_download',
  'NPM_CONFIG_ELECTRON_SKIP_BINARY_DOWNLOAD',
];

const NPM_IGNORE_SCRIPTS_ENV_KEYS = [
  'npm_config_ignore_scripts',
  'NPM_CONFIG_IGNORE_SCRIPTS',
];

function resolveElectronPackageRoot() {
  try {
    return path.dirname(require.resolve('electron/package.json'));
  } catch {
    return null;
  }
}

function readElectronPathHint(packageRoot) {
  const pathFile = path.join(packageRoot, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;

  const hint = fs.readFileSync(pathFile, 'utf8').trim();
  return hint || null;
}

function platformBinaryCandidates(platform) {
  switch (platform) {
    case 'win32':
      return ['electron.exe'];
    case 'darwin':
      return ['Electron.app/Contents/MacOS/Electron'];
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return ['electron'];
    default:
      return ['electron'];
  }
}

function sanitizeElectronEnv(baseEnv = process.env) {
  const env = { ...baseEnv };

  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of ELECTRON_SKIP_ENV_KEYS) {
    delete env[key];
  }
  for (const key of NPM_IGNORE_SCRIPTS_ENV_KEYS) {
    delete env[key];
  }

  return env;
}

// True only when the caller has explicitly marked this as a development or
// CI environment where launching without the Chromium sandbox is acceptable.
function noSandboxExplicitlyAllowed(env = process.env) {
  return env.STEPFORGE_ALLOW_NO_SANDBOX === '1' || env.ELECTRON_DISABLE_SANDBOX === '1';
}

function sandboxHelperUsable(electronPath, statSync = fs.statSync) {
  if (!electronPath) return false;
  const helperPath = path.join(path.dirname(electronPath), 'chrome-sandbox');
  try {
    const stat = statSync(helperPath);
    return stat.uid === 0 && Boolean(stat.mode & 0o4000);
  } catch {
    return false;
  }
}

// Decide how to launch on Linux with respect to the Chromium sandbox.
//   { args: [] }                    sandbox is available, launch normally
//   { args: ['--no-sandbox'] }      explicitly allowed dev/CI launch
//   throws                          sandbox unavailable and not explicitly
//                                   allowed: refuse to normalize an
//                                   unsandboxed launch, explain how to fix it
function linuxSandboxLaunchArgs({
  electronPath,
  platform = process.platform,
  statSync = fs.statSync,
  env = process.env,
  userNamespaces = userNamespacesAvailable,
} = {}) {
  if (platform !== 'linux') return [];

  // Modern kernels with unprivileged user namespaces do not need the setuid
  // helper; Chromium falls back to the namespace sandbox on its own. The
  // setuid helper check below covers kernels where that is disabled.
  if (sandboxHelperUsable(electronPath, statSync)) return [];
  if (userNamespaces()) return [];

  if (noSandboxExplicitlyAllowed(env)) return ['--no-sandbox'];

  const helperPath = electronPath
    ? path.join(path.dirname(electronPath), 'chrome-sandbox')
    : '<node_modules/electron/dist>/chrome-sandbox';
  throw new Error(
    [
      'The Chromium sandbox is not available on this system, and StepForge',
      'refuses to silently launch unsandboxed.',
      '',
      'Fix one of the following:',
      `  1. Make the setuid sandbox helper usable:`,
      `       sudo chown root:root "${helperPath}"`,
      `       sudo chmod 4755 "${helperPath}"`,
      '  2. Enable unprivileged user namespaces (kernel/sysctl dependent):',
      '       sudo sysctl -w kernel.unprivileged_userns_clone=1',
      '',
      'For development or CI only, you may explicitly opt in to an',
      'unsandboxed launch with STEPFORGE_ALLOW_NO_SANDBOX=1.',
    ].join('\n')
  );
}

function userNamespacesAvailable() {
  try {
    // Debian/Ubuntu specific knob; absent elsewhere (treated as enabled).
    const knob = '/proc/sys/kernel/unprivileged_userns_clone';
    if (fs.existsSync(knob)) {
      return fs.readFileSync(knob, 'utf8').trim() === '1';
    }
    // Ubuntu 23.10+ AppArmor restriction on unprivileged user namespaces.
    const apparmorKnob = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
    if (fs.existsSync(apparmorKnob)) {
      return fs.readFileSync(apparmorKnob, 'utf8').trim() === '0';
    }
    return fs.existsSync('/proc/self/ns/user');
  } catch {
    return false;
  }
}

function electronBinaryCandidates({ packageRoot, distDir, platform }) {
  const candidatePaths = [];
  const pathHint = packageRoot ? readElectronPathHint(packageRoot) : null;

  if (pathHint) {
    candidatePaths.push(path.join(distDir, pathHint));
  }

  for (const relativePath of platformBinaryCandidates(platform)) {
    candidatePaths.push(path.join(distDir, relativePath));
  }

  return candidatePaths;
}

function buildMissingElectronError({ packageRoot, distDir, candidatePaths }) {
  const tried = (candidatePaths || []).map((candidate) => `  - ${candidate}`).join('\n');
  return [
    'Electron could not be started because the desktop runtime is missing.',
    '',
    `Looked under: ${packageRoot || '(electron package not installed)'}`,
    `Expected the binary in: ${distDir || '(unknown)'}`,
    '',
    'StepForge never installs dependencies at runtime. Reinstall them from',
    'the repo root on the pinned Node toolchain (see .nvmrc):',
    '',
    '  npm ci',
    '',
    'Make sure ELECTRON_SKIP_BINARY_DOWNLOAD is not set while installing.',
    'If the problem persists, delete node_modules entirely and run npm ci again.',
    '',
    'Searched:',
    tried,
  ].join('\n');
}

function resolveElectronBinary({
  packageRoot = resolveElectronPackageRoot(),
  projectRoot = process.cwd(),
  platform = process.platform,
  overrideDistPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || null,
} = {}) {
  if (!packageRoot) {
    const conventionalRoot = path.join(projectRoot, 'node_modules', 'electron');
    if (fs.existsSync(path.join(conventionalRoot, 'package.json'))) {
      packageRoot = conventionalRoot;
    }
  }

  if (!packageRoot && !overrideDistPath) {
    throw new Error(
      'Electron could not be started because node_modules/electron is not installed.\n\n' +
        'StepForge never installs dependencies at runtime. Run `npm ci` from the\n' +
        'repo root on the pinned Node toolchain (see .nvmrc), then try again.'
    );
  }

  const distDir = overrideDistPath || path.join(packageRoot, 'dist');
  const candidatePaths = electronBinaryCandidates({ packageRoot, distDir, platform });
  const resolved = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    return resolved;
  }

  throw new Error(buildMissingElectronError({ packageRoot, distDir, candidatePaths }));
}

module.exports = {
  buildMissingElectronError,
  electronBinaryCandidates,
  readElectronPathHint,
  sanitizeElectronEnv,
  noSandboxExplicitlyAllowed,
  linuxSandboxLaunchArgs,
  resolveElectronBinary,
  resolveElectronPackageRoot,
  platformBinaryCandidates,
};
