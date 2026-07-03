'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { assertSupportedNode } = require('./check-node-version');

try {
  assertSupportedNode();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function collectTestFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(test|spec)\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
    }
  };

  walk(rootDir);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

const root = path.join(process.cwd(), 'tests', 'unit');
const tests = collectTestFiles(root);

if (!tests.length) {
  console.log('No unit test files found under tests/unit, skipping unit tests.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
