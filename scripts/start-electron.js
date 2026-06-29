#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const {
  linuxSandboxLaunchArgs,
  resolveElectronBinary,
  sanitizeElectronEnv,
} = require('./electron-launcher');

let electronPath;
try {
  electronPath = resolveElectronBinary();
} catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
}
const env = sanitizeElectronEnv();
const sandboxArgs = linuxSandboxLaunchArgs({ electronPath });
if (sandboxArgs.includes('--no-sandbox')) {
  console.warn('[stepforge] Electron sandbox helper is not configured for this install; starting with --no-sandbox');
}

// On Linux, prefer the native Ozone path when available and enable PipeWire-
// based screen capture so desktopCapturer can go through the XDG Desktop
// Portal on Wayland without affecting X11.
const extraArgs = process.platform === 'linux'
  ? ['--enable-features=WebRTCPipeWireCapturer', '--ozone-platform-hint=auto', ...sandboxArgs]
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
