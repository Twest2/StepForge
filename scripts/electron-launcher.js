'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  const candidatePaths = [];
  const pathHint = packageRoot ? readElectronPathHint(packageRoot) : null;

  if (pathHint) {
    candidatePaths.push(path.join(distDir, pathHint));
  }

  for (const relativePath of platformBinaryCandidates(platform)) {
    candidatePaths.push(path.join(distDir, relativePath));
  }

  const resolved = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(buildMissingElectronError({ packageRoot, distDir, candidatePaths }));
  }

  return resolved;
}

module.exports = {
  buildMissingElectronError,
  readElectronPathHint,
  resolveElectronBinary,
  resolveElectronPackageRoot,
  platformBinaryCandidates,
};
