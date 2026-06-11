#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const { resolveElectronBinary, sanitizeElectronEnv } = require('./electron-launcher');

let electronPath;
try {
  electronPath = resolveElectronBinary();
} catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
}
const env = sanitizeElectronEnv();

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

let closed = false;
child.on('close', (code, signal) => {
  closed = true;
  if (code === null) {
    process.exit(signal ? 1 : 0);
    return;
  }
  process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(signal, () => {
    if (!closed) child.kill(signal);
  });
}
