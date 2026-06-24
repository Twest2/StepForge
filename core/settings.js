'use strict';

const path = require('node:path');
const { writeJsonSync, readJsonIfExists, deepClone } = require('./util');

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  appearance: 'system', // system | light | dark
  language: 'en',
  spellcheck: true,
  capture: {
    delayMs: 0,
    mode: 'fullscreen', // fullscreen | window | region
    includeCursor: true,
    clickMarker: true,
    clickMarkerColor: '#E5484D',
    hotkeyCapture: 'CommandOrControl+Shift+1',
    hotkeyPauseResume: 'CommandOrControl+Shift+2',
    captureOutsideClicks: true,
    confirmSimpleCapture: false,
    // Leading-edge click debounce (ms): clicks of the same button closer
    // together than this collapse into one step, so accidental fast/double
    // clicks don't each become a step. Clicks spaced further apart always
    // register. Set to 0 to capture every click.
    clickDebounceMs: 200,
    autoIntervalSec: 5, // session fallback when click capture is unavailable
    // Strict click timing: a step never uses a frame whose grab started
    // after the click. Turn off only if captures are too slow to keep a
    // pre-click frame buffered (re-enables the legacy slack heuristics).
    strictClickFrames: true,
    // Off-main-process frame recorder (hidden worker window sampling a
    // desktop media stream). Falls back to the in-process loop when false
    // or when streams cannot start on this desktop.
    streamCapture: true,
    frameSampleMs: 50, // stream backend sampling cadence (finer = fresher frames)
    // Target the screen this many ms *before* each click. The hook fires on
    // button-down but the UI/cursor often start reacting within a frame, and
    // stream pixels lag slightly; a small lead keeps the saved screenshot
    // clear of the click's onset. Raise it if screenshots still feel late.
    clickLeadMs: 120,
    // After the window hides at recording start, wait this long before the
    // user is likely to click so the buffer holds frames of the now-visible
    // screen rather than the just-dismissed app window.
    postHideSettleMs: 150,
  },
  editor: {
    focusedViewDefaultForNewSteps: false,
    autoTitleTemplate: '[[Mode]] capture [[Time]]',
  },
  ai: {
    enabled: false,
    ollama: {
      host: 'http://127.0.0.1:11434',
      model: 'llama3.2:1b',
    },
  },
  exports: {
    previewStepCount: 3,
    openFolderAfterExport: true,
    lastOutputDirs: {}, // format -> dir
  },
  library: {
    sortBy: 'updatedAt',
  },
  backups: {
    automatic: true,
    keepLast: 10,
    everyNSaves: 25,
  },
};

class Settings {
  constructor(settingsDir) {
    this.file = path.join(settingsDir, 'app-settings.json');
    this.globalPlaceholdersFile = path.join(settingsDir, 'placeholders.json');
    this.data = this.load();
  }

  load() {
    const stored = readJsonIfExists(this.file, {});
    return mergeDeep(deepClone(DEFAULT_SETTINGS), stored);
  }

  save() {
    writeJsonSync(this.file, this.data);
    return this.data;
  }

  get(keyPath) {
    return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    let obj = this.data;
    for (const k of keys.slice(0, -1)) {
      if (typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
      obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
    return this.save();
  }

  getGlobalPlaceholders() {
    return readJsonIfExists(this.globalPlaceholdersFile, {});
  }

  setGlobalPlaceholders(values) {
    writeJsonSync(this.globalPlaceholdersFile, values);
    return values;
  }
}

function mergeDeep(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      mergeDeep(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { Settings, DEFAULT_SETTINGS };
