#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { build, Platform } = require('electron-builder');

const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_JSON = require(path.join(ROOT_DIR, 'package.json'));
const APP_ID = 'com.stepforge.app';

function findInstallerExe(dir) {
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

function createWindowsInstallerConfig(outputDir) {
  return {
    appId: APP_ID,
    productName: 'StepForge',
    directories: {
      output: outputDir,
    },
    files: [
      'app/**/*',
      'core/**/*',
      'exporters/**/*',
      'package.json',
    ],
    asar: true,
    compression: 'normal',
    win: {
      target: ['nsis'],
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'StepForge',
    },
  };
}

function createWindowsInstallerBuildOptions(outputDir) {
  return {
    targets: Platform.WINDOWS.createTarget('nsis'),
    config: createWindowsInstallerConfig(outputDir),
    publish: 'never',
  };
}

async function buildWindowsInstaller() {
  const releaseDir = path.resolve(process.env.STEPFORGE_RELEASE_DIR || path.join(ROOT_DIR, 'releases'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-win-'));
  const outputDir = path.join(workDir, 'output');

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.rmSync(outputDir, { recursive: true, force: true });

  try {
    await build(createWindowsInstallerBuildOptions(outputDir));
  } catch (err) {
    throw new Error(`Windows installer build failed: ${err.message}`);
  }

  const builtInstaller = findInstallerExe(outputDir);
  if (!builtInstaller) {
    throw new Error(`No installer .exe artifact was produced in ${outputDir}`);
  }

  const releaseInstaller = path.join(releaseDir, path.basename(builtInstaller));
  fs.copyFileSync(builtInstaller, releaseInstaller);

  console.log(`StepForge ${PACKAGE_JSON.version} Windows installer written to ${releaseInstaller}`);
}

if (require.main === module) {
  buildWindowsInstaller().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {
  APP_ID,
  createWindowsInstallerConfig,
  createWindowsInstallerBuildOptions,
  findInstallerExe,
  buildWindowsInstaller,
};
