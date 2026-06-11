'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON_SKIP_ENV_KEYS = [
  'ELECTRON_SKIP_BINARY_DOWNLOAD',
  'npm_config_electron_skip_binary_download',
  'NPM_CONFIG_ELECTRON_SKIP_BINARY_DOWNLOAD',
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

  return env;
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

function runNpmRebuild({
  packageRoot,
  npmExecPath = process.env.npm_execpath || null,
  npmNodeExecPath = process.env.npm_node_execpath || process.execPath,
}) {
  if (!npmExecPath) {
    return false;
  }

  const result = spawnSync(
    npmNodeExecPath,
    [npmExecPath, 'rebuild', 'electron', '--force', '--foreground-scripts'],
    {
      cwd: packageRoot,
      env: sanitizeElectronEnv(),
      stdio: 'inherit',
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`Electron repair was interrupted by ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`Electron rebuild failed with exit code ${result.status ?? 1}`);
  }

  return true;
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
  platform = process.platform,
  overrideDistPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || null,
} = {}) {
  if (!packageRoot && !overrideDistPath) {
    throw new Error(
      'Electron could not be started because node_modules/electron is not installed.\n\n' +
        'Run `npm install` from the repo root, then try `npm start` again.'
    );
  }

  const distDir = overrideDistPath || path.join(packageRoot, 'dist');
  const candidatePaths = electronBinaryCandidates({ packageRoot, distDir, platform });

  const resolved = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    if (packageRoot) {
      if (runNpmRebuild({ packageRoot })) {
        const rebuilt = electronBinaryCandidates({ packageRoot, distDir, platform }).find((candidate) =>
          fs.existsSync(candidate)
        );
        if (rebuilt) {
          return rebuilt;
        }
      }

      if (repairElectronInstall({ packageRoot })) {
        const repaired = electronBinaryCandidates({ packageRoot, distDir, platform }).find((candidate) =>
          fs.existsSync(candidate)
        );
        if (repaired) {
          return repaired;
        }
      }
    }

    throw new Error(buildMissingElectronError({ packageRoot, distDir, candidatePaths }));
  }

  return resolved;
}

module.exports = {
  buildMissingElectronError,
  electronBinaryCandidates,
  readElectronPathHint,
  repairElectronInstall,
  runNpmRebuild,
  sanitizeElectronEnv,
  resolveElectronBinary,
  resolveElectronPackageRoot,
  platformBinaryCandidates,
};
