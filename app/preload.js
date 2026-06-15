'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The complete privileged API exposed to the sandboxed renderer. Every call
 * is an explicit invoke; no raw ipcRenderer or Node access leaks through.
 */

const invoke = (channel) => (args) => ipcRenderer.invoke(channel, args);

const api = {
  library: {
    list: invoke('library:list'),
    create: invoke('library:create'),
    duplicate: invoke('library:duplicate'),
    delete: invoke('library:delete'),
    setFavorite: invoke('library:setFavorite'),
    trashList: invoke('library:trash:list'),
    trashRestore: invoke('library:trash:restore'),
    trashPurge: invoke('library:trash:purge'),
  },
  folders: {
    create: invoke('folders:create'),
    rename: invoke('folders:rename'),
    delete: invoke('folders:delete'),
    moveGuide: invoke('folders:moveGuide'),
  },
  guide: {
    get: invoke('guide:get'),
    save: invoke('guide:save'),
  },
  step: {
    add: invoke('step:add'),
    save: invoke('step:save'),
    delete: invoke('step:delete'),
    restore: invoke('step:restore'),
    reorder: invoke('steps:reorder'),
    imagePath: invoke('step:imagePath'),
    setWorkingImage: invoke('step:setWorkingImage'),
    resetWorkingImage: invoke('step:resetWorkingImage'),
    fromClipboard: invoke('step:fromClipboard'),
    importImage: invoke('step:importImage'),
  },
  search: {
    query: invoke('search:query'),
    titles: invoke('search:titles'),
  },
  settings: {
    all: invoke('settings:all'),
    set: invoke('settings:set'),
    globalPlaceholders: invoke('placeholders:globals:get'),
    setGlobalPlaceholders: invoke('placeholders:globals:set'),
  },
  capture: {
    shoot: invoke('capture:shoot'),
    region: invoke('capture:region'),
    session: invoke('capture:session'),
    state: invoke('capture:state'),
    onAdded: (fn) => ipcRenderer.on('capture:added', (e, payload) => fn(payload)),
    onState: (fn) => ipcRenderer.on('capture:state', (e, payload) => fn(payload)),
  },
  archive: {
    export: invoke('archive:export'),
    open: invoke('archive:open'),
    saveLinked: invoke('archive:saveLinked'),
  },
  snapshots: {
    list: invoke('snapshots:list'),
    create: invoke('snapshots:create'),
    restore: invoke('snapshots:restore'),
  },
  templates: {
    list: invoke('templates:list'),
    load: invoke('templates:load'),
    save: invoke('templates:save'),
    delete: invoke('templates:delete'),
    rename: invoke('templates:rename'),
    duplicate: invoke('templates:duplicate'),
    export: invoke('templates:export'),
    import: invoke('templates:import'),
  },
  export: {
    formats: invoke('export:formats'),
    defaults: invoke('export:defaults'),
    run: invoke('export:run'),
    chooseDir: invoke('export:chooseDir'),
    preview: invoke('export:preview'),
    cleanupPreviews: invoke('preview:cleanup'),
  },
  shell: {
    openPath: invoke('shell:openPath'),
    showItemInFolder: invoke('shell:showItemInFolder'),
  },
  app: {
    info: invoke('app:info'),
  },
};

contextBridge.exposeInMainWorld('stepforge', api);
