'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionPicker', {
  done: (rect) => ipcRenderer.send('region:picked', rect),
});
