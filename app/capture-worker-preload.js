'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the hidden capture-worker window. The worker only ever talks to
 * the StreamCaptureBackend in the main process: commands in (start streams,
 * frame requests), events out (stream health, PNG-encoded frames).
 */
contextBridge.exposeInMainWorld('captureWorkerBridge', {
  onCommand(fn) {
    ipcRenderer.on('capture-worker:command', (_event, msg) => fn(msg));
  },
  send(msg) {
    ipcRenderer.send('capture-worker:event', msg);
  },
});
