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

// On Linux/Wayland, enable PipeWire-based screen capture so desktopCapturer
// can go through the XDG Desktop Portal when XWayland isn't the only option.
const extraArgs = process.platform === 'linux'
  ? ['--enable-features=WebRTCPipeWireCapturer']
  : [];

const child = spawn(electronPath, [...extraArgs, '.'], {
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
