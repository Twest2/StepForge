#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const { resolveElectronBinary } = require('./electron-launcher');

const electronPath = resolveElectronBinary();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
