'use strict';

const { spawnSync } = require('node:child_process');
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

function linuxSandboxLaunchArgs({
  electronPath,
  platform = process.platform,
  statSync = fs.statSync,
} = {}) {
  if (platform !== 'linux') return [];
  if (!electronPath) return ['--no-sandbox'];

  const helperPath = path.join(path.dirname(electronPath), 'chrome-sandbox');
  try {
    const stat = statSync(helperPath);
    const ownedByRoot = stat.uid === 0;
    const hasSetuid = Boolean(stat.mode & 0o4000);
    if (ownedByRoot && hasSetuid) return [];
  } catch {
    // Missing or unreadable helper: fall back to the unsandboxed launcher.
  }
  return ['--no-sandbox'];
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

function runNpmCommand({
  packageRoot,
  npmArgs,
  errorLabel,
  npmExecPath = process.env.npm_execpath || null,
  npmNodeExecPath = process.env.npm_node_execpath || process.execPath,
}) {
  if (!npmExecPath) {
    return false;
  }

  const result = spawnSync(npmNodeExecPath, [npmExecPath, ...npmArgs], {
    cwd: packageRoot,
    env: sanitizeElectronEnv(),
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`${errorLabel} was interrupted by ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`${errorLabel} failed with exit code ${result.status ?? 1}`);
  }

  return true;
}

function runNpmRebuild({
  packageRoot,
  npmExecPath = process.env.npm_execpath || null,
  npmNodeExecPath = process.env.npm_node_execpath || process.execPath,
}) {
  return runNpmCommand({
    packageRoot,
    npmArgs: ['rebuild', 'electron', '--force', '--foreground-scripts'],
    errorLabel: 'Electron rebuild',
    npmExecPath,
    npmNodeExecPath,
  });
}

function runNpmInstall({
  packageRoot,
  npmExecPath = process.env.npm_execpath || null,
  npmNodeExecPath = process.env.npm_node_execpath || process.execPath,
}) {
  return runNpmCommand({
    packageRoot,
    npmArgs: [
      'install',
      '--include=dev',
      '--ignore-scripts=false',
      '--foreground-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    errorLabel: 'Electron dependency install',
    npmExecPath,
    npmNodeExecPath,
  });
}

function repairElectronInstall({
  packageRoot,
}) {
  const installScript = path.join(packageRoot, 'install.js');
  if (!fs.existsSync(installScript)) {
    return false;
  }

  const result = spawnSync(process.execPath, [installScript], {
    cwd: packageRoot,
    env: sanitizeElectronEnv(),
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`Electron repair was interrupted by ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`Electron repair failed with exit code ${result.status ?? 1}`);
  }

  return true;
}

function buildMissingElectronError({ packageRoot, distDir, candidatePaths }) {
  const tried = candidatePaths.map((candidate) => `  - ${candidate}`).join('\n');
  return [
    'Electron could not be started because the desktop runtime is missing.',
    '',
    `Looked under: ${packageRoot}`,
    `Expected the binary in: ${distDir}`,
    '',
    'Try reinstalling dependencies from the repo root:',
    '',
    '  npm install',
    '  npm rebuild electron --force --foreground-scripts',
    '  make sure ELECTRON_SKIP_BINARY_DOWNLOAD is not set',
    '',
    'If that does not help, delete node_modules/electron and install again.',
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
  const repairErrors = [];

  function resolveCurrentPackageRoot() {
    if (packageRoot) return packageRoot;
    const conventionalRoot = path.join(projectRoot, 'node_modules', 'electron');
    if (fs.existsSync(path.join(conventionalRoot, 'package.json'))) {
      packageRoot = conventionalRoot;
      return packageRoot;
    }
    packageRoot = resolveElectronPackageRoot();
    return packageRoot;
  }

  function tryRepair(label, repairFn) {
    try {
      if (!repairFn()) {
        return null;
      }
    } catch (error) {
      repairErrors.push(`${label}: ${error && error.message ? error.message : String(error)}`);
      return null;
    }

    const currentPackageRoot = resolveCurrentPackageRoot();
    if (!currentPackageRoot && !overrideDistPath) {
      return null;
    }

    const distDir = overrideDistPath || path.join(currentPackageRoot, 'dist');
    return electronBinaryCandidates({ packageRoot: currentPackageRoot, distDir, platform }).find((candidate) =>
      fs.existsSync(candidate)
    );
  }

  let currentPackageRoot = resolveCurrentPackageRoot();
  if (!currentPackageRoot && !overrideDistPath) {
    const installed = tryRepair('Electron dependency install', () =>
      runNpmInstall({ packageRoot: projectRoot })
    );
    if (installed) {
      return installed;
    }

    currentPackageRoot = resolveCurrentPackageRoot();
  }

  if (!currentPackageRoot && !overrideDistPath) {
    throw new Error(
      'Electron could not be started because node_modules/electron is not installed.\n\n' +
        'Run `npm install` from the repo root, then try `npm start` again.'
    );
  }

  const distDir = overrideDistPath || path.join(currentPackageRoot, 'dist');
  let candidatePaths = electronBinaryCandidates({ packageRoot: currentPackageRoot, distDir, platform });
  let resolved = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (resolved) {
    return resolved;
  }

  const repairAttempts = [
    ['Electron rebuild', () => runNpmRebuild({ packageRoot: currentPackageRoot })],
    ['Electron install repair', () => repairElectronInstall({ packageRoot: currentPackageRoot })],
    ['Electron dependency install', () => runNpmInstall({ packageRoot: projectRoot })],
  ];

  for (const [label, repairFn] of repairAttempts) {
    const repaired = tryRepair(label, repairFn);
    if (repaired) {
      return repaired;
    }
  }

  throw new Error(
    buildMissingElectronError({
      packageRoot: currentPackageRoot,
      distDir,
      candidatePaths,
    }) +
      (repairErrors.length
        ? `\n\nAutomatic repair attempts failed:\n${repairErrors.map((error) => `  - ${error}`).join('\n')}`
        : '')
  );
}

module.exports = {
  buildMissingElectronError,
  electronBinaryCandidates,
  readElectronPathHint,
  repairElectronInstall,
  runNpmRebuild,
  runNpmInstall,
  sanitizeElectronEnv,
  linuxSandboxLaunchArgs,
  resolveElectronBinary,
  resolveElectronPackageRoot,
  platformBinaryCandidates,
};
