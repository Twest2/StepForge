'use strict';

// Hard prerequisite check for the supported Node toolchain.
//
// The locked dependency graph (notably the electron-builder packaging
// toolchain) requires Node >= 22.12. Older Nodes fail late with confusing
// errors (ERR_REQUIRE_ESM deep inside dependencies) instead of a clear
// message, so every entry point calls this first.

const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function requiredNodeVersion(projectRoot = path.join(__dirname, '..')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const range = pkg.engines && pkg.engines.node ? String(pkg.engines.node) : null;
  if (!range) return null;
  const match = /(\d+\.\d+\.\d+)/.exec(range);
  return match ? match[1] : null;
}

function checkNodeVersion({
  currentVersion = process.versions.node,
  projectRoot = path.join(__dirname, '..'),
} = {}) {
  const required = requiredNodeVersion(projectRoot);
  if (!required) return { ok: true, required: null, current: currentVersion };

  const current = parseVersion(currentVersion);
  const minimum = parseVersion(required);
  if (!current || !minimum) return { ok: true, required, current: currentVersion };

  return {
    ok: compareVersions(current, minimum) >= 0,
    required,
    current: currentVersion,
  };
}

function assertSupportedNode(options = {}) {
  const result = checkNodeVersion(options);
  if (result.ok) return result;

  const message = [
    `StepForge requires Node ${result.required} or newer; this is Node ${result.current}.`,
    '',
    'Install the pinned toolchain (see .nvmrc) and reinstall dependencies:',
    '',
    '  nvm install && nvm use    # or install Node 22 LTS another way',
    '  npm ci',
    '',
    'Older Nodes fail unpredictably inside the packaging dependency graph,',
    'so this check stops early instead.',
  ].join('\n');

  const error = new Error(message);
  error.code = 'STEPFORGE_UNSUPPORTED_NODE';
  throw error;
}

module.exports = {
  assertSupportedNode,
  checkNodeVersion,
  compareVersions,
  parseVersion,
  requiredNodeVersion,
};
