'use strict';

/**
 * Privilege-boundary policy for every renderer surface.
 *
 * This module is deliberately loadable under plain Node (no electron
 * require at module scope) so the decision logic is unit-testable:
 *  - which URLs count as our own app pages,
 *  - whether a navigation/popup may proceed (it may not),
 *  - which permission a renderer may be granted (display capture for the
 *    dedicated capture worker only),
 *  - whether an IPC event comes from the trusted main-window frame,
 *  - which external URLs may be handed to shell.openExternal,
 *  - which filesystem paths the renderer may ask the shell to open
 *    (only files the main process itself produced).
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RENDERER_DIR = path.join(__dirname, 'renderer');

const APP_PAGES = {
  main: pathToFileURL(path.join(RENDERER_DIR, 'index.html')).href,
  region: pathToFileURL(path.join(RENDERER_DIR, 'region.html')).href,
  captureWorker: pathToFileURL(path.join(RENDERER_DIR, 'capture-worker.html')).href,
};

/** Normalize a URL for identity comparison: drop query/hash, decode path. */
function normalizeAppUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  // Windows drive letters may differ in case between loadFile and senderFrame.
  if (process.platform === 'win32') pathname = pathname.toLowerCase();
  return pathname;
}

function isAppPageUrl(rawUrl, page) {
  const expected = APP_PAGES[page];
  if (!expected) return false;
  const a = normalizeAppUrl(rawUrl);
  const b = normalizeAppUrl(expected);
  return a !== null && a === b;
}

/**
 * Navigation policy: a privileged window may only ever stay on the exact
 * page it was created with. Everything else — remote URLs, other local
 * files, javascript:, data: — is denied.
 */
function navigationAllowed(targetUrl, page) {
  return isAppPageUrl(targetUrl, page);
}

/**
 * Permission policy for Electron sessions. Display capture (and the media
 * permission that getDisplayMedia consults) is granted only to the dedicated
 * hidden capture-worker page. Everything else is denied for everyone,
 * including our own main window.
 */
function permissionAllowed(permission, requestingUrl) {
  if (permission === 'media' || permission === 'display-capture') {
    return isAppPageUrl(requestingUrl, 'captureWorker');
  }
  return false;
}

/**
 * External-link policy: only well-formed http(s) and mailto URLs may reach
 * shell.openExternal. Returns the normalized URL string or null.
 */
function validateExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (!url.hostname) return null;
    return url.href;
  }
  if (url.protocol === 'mailto:') return url.href;
  return null;
}

/**
 * IPC sender guard: an invoke event is trusted only when it originates from
 * the current main window's top frame, and that frame is our index.html.
 * Destroyed frames, subframes, other windows, and navigated-away frames are
 * all rejected.
 */
function makeIpcSenderGuard({ getMainWebContents }) {
  return function trustedSender(event) {
    if (!event || typeof event !== 'object') return false;
    const expected = getMainWebContents();
    if (!expected || event.sender !== expected) return false;
    const frame = event.senderFrame;
    if (!frame) return false;
    try {
      if (frame.parent) return false; // top frame only
      return isAppPageUrl(frame.url, 'main');
    } catch {
      // Accessing a disposed WebFrameMain throws — reject.
      return false;
    }
  };
}

/**
 * Cheap recursive payload budget: sums string lengths (and key counts) with
 * early exit. Protects handlers from absurd payloads without JSON.stringify
 * on hundred-megabyte image saves.
 */
function payloadWithinBudget(value, maxChars, depth = 0) {
  let budget = maxChars;

  const walk = (v, d) => {
    if (budget < 0 || d > 16) return false;
    if (v == null) return true;
    const t = typeof v;
    if (t === 'string') {
      budget -= v.length;
      return budget >= 0;
    }
    if (t === 'number' || t === 'boolean') {
      budget -= 8;
      return budget >= 0;
    }
    if (t === 'function' || t === 'symbol' || t === 'bigint') return false;
    if (Array.isArray(v)) {
      if (v.length > 100000) return false;
      for (const item of v) if (!walk(item, d + 1)) return false;
      return true;
    }
    if (t === 'object') {
      const keys = Object.keys(v);
      if (keys.length > 4096) return false;
      for (const key of keys) {
        budget -= key.length;
        if (budget < 0) return false;
        if (!walk(v[key], d + 1)) return false;
      }
      return true;
    }
    return false;
  };

  return walk(value, depth);
}

/** True for plain-object argument bags (what every IPC channel expects). */
function isPlainArgs(args) {
  if (args === undefined || args === null) return true;
  if (typeof args !== 'object' || Array.isArray(args)) return false;
  const proto = Object.getPrototypeOf(args);
  return proto === Object.prototype || proto === null;
}

// ---- field validators (used by main.js per-channel checks) ----------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const check = {
  /** Guide/step/folder/template identifiers and snapshot/trash entry names:
   *  single path segment, no separators, no dot-dot, sane length. */
  id(v) {
    return typeof v === 'string' && ID_RE.test(v) && !v.includes('..');
  },
  optionalId(v) {
    return v === null || v === undefined || check.id(v);
  },
  string(v, max = 4096) {
    return typeof v === 'string' && v.length <= max;
  },
  optionalString(v, max = 4096) {
    return v === null || v === undefined || check.string(v, max);
  },
  bool(v) {
    return typeof v === 'boolean';
  },
  number(v, min = -1e15, max = 1e15) {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  },
  optionalNumber(v, min, max) {
    return v === null || v === undefined || check.number(v, min, max);
  },
  oneOf(v, values) {
    return values.includes(v);
  },
  base64(v, maxChars = 192 * 1024 * 1024) {
    return typeof v === 'string' && v.length <= maxChars && /^[A-Za-z0-9+/=\r\n]*$/.test(v.slice(0, 4096));
  },
  optionalBase64(v, maxChars) {
    return v === null || v === undefined || check.base64(v, maxChars);
  },
  /** Single filesystem name (template/snapshot/trash entries): no path
   *  separators, no traversal, no NUL, printable, bounded length. */
  fileName(v, max = 160) {
    return (
      typeof v === 'string' &&
      v.trim().length > 0 &&
      v.length <= max &&
      !/[/\\\0]/.test(v) &&
      !v.includes('..') &&
      v !== '.' &&
      // eslint-disable-next-line no-control-regex
      !/[\x00-\x1f]/.test(v)
    );
  },
  optionalFileName(v, max) {
    return v === null || v === undefined || check.fileName(v, max);
  },
  /** settings keyPath: dotted segments, no prototype-pollution segments. */
  settingsKeyPath(v) {
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) return false;
    const segments = v.split('.');
    return segments.every(
      (segment) =>
        /^[A-Za-z0-9_-]+$/.test(segment) &&
        !['__proto__', 'constructor', 'prototype'].includes(segment)
    );
  },
};

/**
 * Registry of files the main process itself produced (export outputs,
 * previews) and may therefore re-open on renderer request. Bounded LRU.
 */
class ProducedFiles {
  constructor(limit = 256) {
    this.limit = limit;
    this.paths = new Set();
  }

  key(p) {
    const resolved = path.resolve(String(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  add(p) {
    if (!p || typeof p !== 'string') return;
    const key = this.key(p);
    this.paths.delete(key);
    this.paths.add(key);
    while (this.paths.size > this.limit) {
      this.paths.delete(this.paths.values().next().value);
    }
  }

  has(p) {
    if (!p || typeof p !== 'string') return false;
    return this.paths.has(this.key(p));
  }
}

/**
 * Attach the navigation/popup policy to a BrowserWindow. `page` names the
 * app page this window is allowed to display (key of APP_PAGES).
 */
function installWindowSecurity(win, page) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!navigationAllowed(url, page)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (details) => {
    if (!navigationAllowed(details.url, page) && typeof details.preventDefault === 'function') {
      details.preventDefault();
    }
  });
  // Defense in depth: if a disallowed document somehow starts loading,
  // never let it attach webviews either.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

module.exports = {
  APP_PAGES,
  ProducedFiles,
  check,
  installWindowSecurity,
  isAppPageUrl,
  isPlainArgs,
  makeIpcSenderGuard,
  navigationAllowed,
  normalizeAppUrl,
  payloadWithinBudget,
  permissionAllowed,
  validateExternalUrl,
};
