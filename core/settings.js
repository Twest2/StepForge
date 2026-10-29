'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { writeJsonSync, readJsonIfExists, deepClone } = require('./util');

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  appearance: 'system', // system | light | dark
  language: 'en',
  // Explicit opt-in; credentials live in OS-encrypted storage. `provider` is the
  // service that syncs: google | onedrive | dropbox | webdav.
  cloud: { enabled: false, provider: 'google' },
  spellcheck: true,
  // Private details in screenshots (app/redaction.js). Guides are always
  // checked before publishing; `onCapture` also checks each new capture.
  // `terms` are extra words to always hide, such as names.
  redaction: { onCapture: false, terms: [] },
  capture: {
    delayMs: 0,
    mode: 'fullscreen', // fullscreen | window ('region' in old files loads as fullscreen)
    includeCursor: true,
    clickMarker: true,
    focusAmount: 1.25, // Zoom for new automatically focused captures: 1–2 in 0.05 increments.
    smartCropping: true, // Automatically focus recorded clicks; keep original pixels.
    clickMarkerColor: '#E5484D',
    hotkeyCapture: 'CommandOrControl+Shift+1',
    hotkeyPauseResume: 'CommandOrControl+Shift+2',
    captureOutsideClicks: true,
    confirmSimpleCapture: false,
    // Fallback trigger when click capture is unavailable: keep the old timer
    // fallback by default, but let users switch to hotkey-only recordings.
    fallbackTrigger: 'hotkey', // hotkey | interval
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
    // Raw typed-text capture. When true, printable characters typed between
    // captures are buffered and stored in step capture metadata (and can be
    // sent to a configured AI host). This can record passwords or other
    // secrets, so it is OFF by default and must be explicitly opted into.
    // Shortcut detection (Ctrl+T, Enter, …) is unaffected — only raw
    // character logging is gated here.
    captureTypedText: false,
  },
  editor: {
    focusedViewDefaultForNewSteps: true,
    autoTitleTemplate: '[[Mode]] capture [[Time]]',
  },
  ai: {
    enabled: false,
    // Auto-document captured steps in the background when a session capture
    // lands. Requires enabled + a reachable model.
    autoDoc: false,
    // Local-first: only a loopback Ollama endpoint is contacted unless this
    // is explicitly turned on. Turning it on sends screenshots and text to
    // the configured remote host.
    allowRemoteHost: false,
    // Attach the step screenshot to AI requests (only for vision-capable
    // models). Turning this off keeps requests text-only.
    attachScreenshots: true,
    // Per-request network deadline (ms). A dead endpoint fails fast instead
    // of leaving UI actions pending forever.
    timeoutMs: 60000,
    // Skip attaching a screenshot larger than this many bytes (pre-base64)
    // to avoid multi-hundred-MB request bodies.
    maxImageBytes: 12 * 1024 * 1024,
    ollama: {
      host: 'http://127.0.0.1:11434',
      model: 'llama3.2:1b',
    },
    // AI agents (Claude, Codex, any MCP app) reach guides through
    // `StepForge --mcp`. Off by default: an agent sends what it reads to its
    // own AI provider.
    agents: {
      enabled: false,
      // Agents get each step's screenshot, rendered with blurs filled.
      screenshots: true,
      // Agents may also create and change brand profiles (never delete
      // them). Off by default, separately from guide access.
      branding: false,
    },
  },
  // Settings → Branding: the brand profile (core/branding.js) every export
  // uses unless the Export dialog picks another; '' for no branding.
  branding: { activeProfileId: '' },
  exports: {
    previewStepCount: 3,
    openFolderAfterExport: true,
    // Code block colors: a theme id from core/code-themes.js, or 'plain'.
    codeTheme: 'atom-one-dark',
    lastOutputDirs: {}, // format -> dir
  },
  library: {
    sortBy: 'updatedAt',
    // Trashed guides are deleted for good after this many days; 0 keeps them.
    trashDays: 30,
    // Guides not saved or verified for this many days show "May need
    // review" in the library; 0 turns it off (see core/review.js).
    reviewAfterDays: 180,
  },
  backups: {
    automatic: true,
    keepLast: 10,
    everyNSaves: 25,
  },
};

// Values that sync independently; changing a whole capture/branding object
// still records clocks only for the shared fields that actually changed.
const SHARED_SETTING_PATHS = Object.freeze({
  language: 'language', activeProfileId: 'branding.activeProfileId',
  hotkeyCapture: 'capture.hotkeyCapture', hotkeyPauseResume: 'capture.hotkeyPauseResume',
});
const valueAt = (data, keyPath) => keyPath.split('.').reduce((value, key) => value?.[key], data);
const sharedValues = (data) => Object.fromEntries(Object.entries(SHARED_SETTING_PATHS)
  .map(([key, keyPath]) => [key, valueAt(data, keyPath)]));

class Settings {
  constructor(settingsDir) {
    this.file = path.join(settingsDir, 'app-settings.json');
    this.globalPlaceholdersFile = path.join(settingsDir, 'placeholders.json');
    this.sharedTimesFile = path.join(settingsDir, 'shared-settings-times.json');
    this.data = this.load();
    // Seed legacy values (including newly shared keys) before an unrelated
    // save changes the file's time. Existing per-value clocks stay intact.
    {
      const time = (file) => { try { return fs.statSync(file).mtime.toISOString(); } catch { return ''; } };
      const times = this.getSharedChangeTimes();
      for (const [key, keyPath] of Object.entries(SHARED_SETTING_PATHS)) {
        if (!Object.hasOwn(times, `setting:${key}`) && !isDeepStrictEqual(this.get(keyPath), valueAt(DEFAULT_SETTINGS, keyPath)) && time(this.file)) times[`setting:${key}`] = time(this.file);
      }
      for (const name of Object.keys(this.getGlobalPlaceholders() || {})) {
        if (!Object.hasOwn(times, `placeholder:${name}`) && time(this.globalPlaceholdersFile)) times[`placeholder:${name}`] = time(this.globalPlaceholdersFile);
      }
      if (Object.keys(times).length) this.setSharedChangeTimes(times);
    }
  }

  load() {
    const stored = readJsonIfExists(this.file, {});
    const data = mergeDeep(deepClone(DEFAULT_SETTINGS), stored);
    // 'region' (and anything else unknown) was offered once but always
    // recorded the full screen; say so in the file too.
    if (data.capture && !['fullscreen', 'window'].includes(data.capture.mode)) data.capture.mode = 'fullscreen';
    return data;
  }

  save() {
    writeJsonSync(this.file, this.data);
    return this.data;
  }

  get(keyPath) {
    return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  getSharedChangeTimes() { return readJsonIfExists(this.sharedTimesFile, {}); }

  setSharedChangeTimes(times) {
    if (!isDeepStrictEqual(this.getSharedChangeTimes(), times)) writeJsonSync(this.sharedTimesFile, times);
  }

  set(keyPath, value) {
    const before = sharedValues(this.data);
    const keys = keyPath.split('.');
    let obj = this.data;
    for (const k of keys.slice(0, -1)) {
      if (typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
      obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
    const saved = this.save();
    const after = sharedValues(this.data);
    const times = this.getSharedChangeTimes();
    for (const key of Object.keys(before)) {
      if (!isDeepStrictEqual(before[key], after[key])) times[`setting:${key}`] = new Date().toISOString();
    }
    this.setSharedChangeTimes(times);
    return saved;
  }

  getGlobalPlaceholders() {
    return readJsonIfExists(this.globalPlaceholdersFile, {});
  }

  setGlobalPlaceholders(values) {
    const before = this.getGlobalPlaceholders() || {};
    const times = this.getSharedChangeTimes();
    for (const name of new Set([...Object.keys(before), ...Object.keys(values)])) {
      if (!isDeepStrictEqual(before[name], values[name])) times[`placeholder:${name}`] = new Date().toISOString();
    }
    writeJsonSync(this.globalPlaceholdersFile, values);
    this.setSharedChangeTimes(times);
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

module.exports = { Settings, DEFAULT_SETTINGS, SHARED_SETTING_PATHS };
