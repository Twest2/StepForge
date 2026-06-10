#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { build, Platform } = require('electron-builder');

const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_JSON = require(path.join(ROOT_DIR, 'package.json'));
const RELEASE_DIR = path.resolve(process.env.STEPFORGE_RELEASE_DIR || path.join(ROOT_DIR, 'releases'));
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-win-'));
const OUTPUT_DIR = path.join(WORK_DIR, 'output');
const ARTIFACT_NAME = 'stepforge-windows-x64-portable.exe';

function findPortableExe(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) return abs;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });

  const config = {
    appId: 'com.stepforge.app',
    productName: 'StepForge',
    directories: {
      output: OUTPUT_DIR,
    },
    files: [
      'app/**/*',
      'core/**/*',
      'exporters/**/*',
      'package.json',
    ],
    asar: true,
    compression: 'normal',
    artifactName: ARTIFACT_NAME,
    win: {
      target: ['portable'],
    },
  };

  try {
    await build({
      targets: Platform.WINDOWS.createTarget('portable'),
      config,
    });
  } catch (err) {
    throw new Error(`Windows portable build failed: ${err.message}`);
  }

  const builtExe = findPortableExe(OUTPUT_DIR);
  if (!builtExe) {
    throw new Error(`No .exe artifact was produced in ${OUTPUT_DIR}`);
  }

  const releaseExe = path.join(RELEASE_DIR, path.basename(builtExe));
  fs.copyFileSync(builtExe, releaseExe);

  console.log(`StepForge ${PACKAGE_JSON.version} Windows portable build written to ${releaseExe}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
