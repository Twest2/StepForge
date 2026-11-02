'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recordingControls', {
  action: (action) => { if (['gesture', 'pause', 'finish'].includes(action)) ipcRenderer.send('recording-controls:action', action); },
  onState: (callback) => ipcRenderer.on('recording-controls:state', (_event, state) => callback(state)),
});
