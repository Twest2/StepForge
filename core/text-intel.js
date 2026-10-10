'use strict';
const { deepClone, htmlToText, escapeHtml } = require('./util');
const { sanitizeHtml } = require('./sanitize');
const {
  TEXTBLOCK_LEVELS,
  TEXTBLOCK_POSITIONS,
  normalizeTextBlock,
  normalizeCodeBlock,
  normalizeTableBlock,
} = require('./schema');
const { blockText, orderedBlocks, nextBlockOrder } = require('./blocks');
const { placeholderPromptLines, substitutePlaceholders } = require('./ai-placeholders');

const DEFAULT_CAPTURE_TITLES = {
  fullscreen: 'Screen capture',
  window: 'Window capture',
  region: 'Region capture',
};

const AI_LEVEL_ALIASES = new Map([
  ['note', 'info'],
  ['info', 'info'],
  ['tip', 'success'],
  ['success', 'success'],
  ['warning', 'warn'],
  ['warn', 'warn'],
  ['important', 'error'],
  ['error', 'error'],
]);

const GENERIC_OCR_PHRASES = new Set([
  'button',
  'click',
  'double click',
  'menu',
  'item',
  'field',
  'text field',
  'search',
  'submit',
  'cancel',
  'ok',
  'open',
  'select',
  'enter',
  'type',
]);

// Generic OS/browser chrome titles that tell us nothing about what the user did.
const GENERIC_WINDOW_TITLES = new Set([
  'new tab', 'new window', 'new incognito window', 'new incognito tab',
  'new document', 'untitled', 'blank page', 'home page', 'homepage',
  'start page', 'speed dial', 'loading', 'loading…', 'loading...',
]);

const BROWSER_NAME_PHRASES = new Set([
  'google chrome',
  'chrome',
  'chromium',
  'microsoft edge',
  'edge',
  'brave',
  'firefox',
  'safari',
  'opera',
  'vivaldi',
]);

// Known search engine page title suffixes (what appears after the query in the window title).
const SEARCH_ENGINE_PAGE_NAMES = new Set([
  'google search',
  'google',
  'bing',
  'duckduckgo',
  'yahoo search',
  'yahoo',
  'startpage',
  'ecosia',
  'brave search',
]);

// Common keyboard shortcuts → short action descriptions used as step titles.
const SHORTCUT_TITLES = {
  'Ctrl+T':          'Open new tab',
  'Ctrl+N':          'Open new window',
  'Ctrl+W':          'Close tab',
  'Ctrl+Shift+T':    'Reopen closed tab',
  'Ctrl+Shift+N':    'Open incognito window',
  'Ctrl+S':          'Save',
  'Ctrl+Shift+S':    'Save as',
  'Ctrl+Z':          'Undo',
  'Ctrl+Y':          'Redo',
  'Ctrl+Shift+Z':    'Redo',
  'Ctrl+C':          'Copy selection',
  'Ctrl+V':          'Paste',
  'Ctrl+X':          'Cut selection',
  'Ctrl+A':          'Select all',
  'Ctrl+F':          'Open Find',
  'Ctrl+H':          'Open Find and Replace',
  'Ctrl+R':          'Reload page',
  'Ctrl+Shift+R':    'Hard reload page',
  'Ctrl+L':          'Focus address bar',
  'Ctrl+D':          'Bookmark page',
  'Ctrl+Tab':        'Switch to next tab',
  'Ctrl+Shift+Tab':  'Switch to previous tab',
  'Ctrl+Plus':       'Zoom in',
  'Ctrl+Minus':      'Zoom out',
  'Ctrl+0':          'Reset zoom',
  'Ctrl+P':          'Print',
  'Ctrl+O':          'Open file',
  'Ctrl+E':          'Focus search bar',
  'Ctrl+K':          'Focus search bar',
  'Ctrl+G':          'Go to line',
  'Ctrl+B':          'Toggle sidebar',
  'Ctrl+Shift+P':    'Open command palette',
  'Ctrl+Shift+E':    'Show file explorer',
  'Ctrl+Shift+G':    'Show source control',
  'Ctrl+Shift+D':    'Show debug panel',
  'Ctrl+Shift+X':    'Show extensions',
  'Alt+F4':          'Close window',
  'Alt+Left':        'Go back',
  'Alt+Right':       'Go forward',
  'Alt+Tab':         'Switch application',
  'F2':              'Rename',
  'F3':              'Find next',
  'F4':              'Open address bar',
  'F5':              'Reload page',
  'F11':             'Toggle fullscreen',
  'F12':             'Open developer tools',
};

// Process name → human-readable display name (used to append "in Chrome" etc. to titles).
const APP_DISPLAY_NAMES = {
  chrome:           'Chrome',
  msedge:           'Edge',
  firefox:          'Firefox',
  safari:           'Safari',
  opera:            'Opera',
  brave:            'Brave',
  vivaldi:          'Vivaldi',
  code:             'VS Code',
  cursor:           'Cursor',
  'sublime_text':   'Sublime Text',
  atom:             'Atom',
  notepad:          'Notepad',
  'notepad++':      'Notepad++',
  winword:          'Word',
  excel:            'Excel',
  powerpnt:         'PowerPoint',
  outlook:          'Outlook',
  teams:            'Teams',
  slack:            'Slack',
  discord:          'Discord',
  zoom:             'Zoom',
  figma:            'Figma',
  postman:          'Postman',
  insomnia:         'Insomnia',
  notion:           'Notion',
  obsidian:         'Obsidian',
  spotify:          'Spotify',
  terminal:         'Terminal',
  cmd:              'Command Prompt',
  powershell:       'PowerShell',
  windowsterminal:  'Windows Terminal',
  wt:               'Windows Terminal',
  iterm2:           'iTerm',
  wezterm:          'WezTerm',
  alacritty:        'Alacritty',
  kitty:            'Kitty',
  'gnome-terminal': 'Terminal',
  konsole:          'Konsole',
  xterm:            'Terminal',
  xfce4terminal:    'Terminal',
  bash:             'Terminal',
  zsh:              'Terminal',
  fish:             'Terminal',
  finder:           'Finder',
  explorer:         'File Explorer',
  'files-uwp':      'File Explorer',
  steam:            'Steam',
  'steamwebhelper': 'Steam',
};

function cleanAppName(rawName) {
  if (!rawName) return '';
  const key = normalizeWhitespace(rawName).toLowerCase().replace(/\.exe$/i, '');
  return APP_DISPLAY_NAMES[key] || sentenceCase(rawName.replace(/\.exe$/i, ''));
}

function qualifyTitleWithApp(title, appName) {
  const app = cleanAppName(appName);
  if (!app) return title;
  if (new RegExp(`\\b${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(title)) return title;
  return `${title} in ${app}`;
}

const ACTION_PREFIXES = [
  'click',
  'select',
  'open',
  'choose',
  'enter',
  'type',
  'search',
  'switch to',
  'go to',
  'navigate to',
  'toggle',
  'turn on',
  'turn off',
  'enable',
  'disable',
  'pick',
  'focus',
  'launch',
  'activate',
];

function normalizeWhitespace(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCaseWord(word) {
  if (!word) return word;
  if (/^[A-Z0-9]{2,}$/.test(word)) return word;
  if (/^\d+$/.test(word)) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function displayText(text) {
  const clean = normalizeWhitespace(text)
    .replace(/^[\s"'`([{<]+|[\s"'`)}\]>.,;:!?]+$/g, '')
    .trim();
  if (!clean) return '';
  if (clean === clean.toUpperCase()) {
    return clean.split(/\s+/).map(titleCaseWord).join(' ');
  }
  return clean.replace(/\s+/g, ' ');
}

function sentenceCase(text) {
  const clean = displayText(text);
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function isPathOrUrlLike(text) {
  return /^(?:https?:\/\/|file:\/\/|about:blank|chrome:\/\/|edge:\/\/|moz-extension:\/\/|view-source:|localhost(?:[:/]|$)|www\.)/i.test(text) ||
    /[A-Za-z]:\\/.test(text) ||
    /\/(?:[^/\s]+\/){2,}/.test(text) ||
    /\\/.test(text);
}

function isBrowserNoise(text) {
  const clean = normalizeWhitespace(text).toLowerCase();
  if (!clean) return true;
  if (BROWSER_NAME_PHRASES.has(clean)) return true;
  if (isPathOrUrlLike(clean)) return true;
  let foundBrowserName = false;
  for (const name of BROWSER_NAME_PHRASES) {
    if (clean.includes(name)) {
      foundBrowserName = true;
      break;
    }
  }
  return foundBrowserName && /[\s|•·*]{2,}|[-–—]|\/|\\/.test(clean);
}

function isUsefulTitleCandidate(text, { source = 'ocr' } = {}) {
  const clean = displayText(text);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (GENERIC_OCR_PHRASES.has(lower)) return false;
  if (BROWSER_NAME_PHRASES.has(lower)) return false;
  if (isPathOrUrlLike(clean)) return false;
  if ((source === 'window' || source === 'app') && isBrowserNoise(clean)) return false;
  if (source === 'window' && GENERIC_WINDOW_TITLES.has(lower)) return false;
  if (/^[\p{P}\p{S}0-9]+$/u.test(clean)) return false;
  return true;
}

function splitTitleFragments(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];
  return clean
    .split(/\s*(?:\*\*+|[|•·]+|::|\/+|\\+|\s[-–—]\s|\s{2,})\s*/g)
    .map((part) => displayText(part))
    .filter(Boolean);
}

function candidateWords(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];
  // Exclude standalone punctuation tokens (e.g. "|" in "Oracle | Cloud...") from word count.
  return clean.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w));
}

// Remove trailing "- Google Chrome", "| Firefox", etc. from a window title.
// When appName is supplied, also strips the specific app's display name suffix:
// "Document1 - Word" → "Document1" when appName is "winword".
function stripBrowserNameSuffix(text, appName) {
  let clean = normalizeWhitespace(text);
  // Always strip known browser names first.
  for (const name of BROWSER_NAME_PHRASES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(`\\s*[-–—·|•]\\s*${escaped}\\s*$`, 'i'), '').trim();
  }
  // Also strip the specific app's display name when provided.
  if (appName) {
    const display = cleanAppName(appName);
    const raw = normalizeWhitespace(appName).replace(/\.exe$/i, '');
    for (const name of [display, raw].filter(Boolean)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(`\\s*[-–—·|•]\\s*${escaped}\\s*$`, 'i'), '').trim();
    }
  }
  return clean;
}

// Detect "[query] - Google Search" or "[query] - Bing" patterns in a (already-stripped) page title.
// Returns the query word(s) if found, otherwise ''.
function extractSearchQuery(pageTitle) {
  const frags = splitTitleFragments(pageTitle);
  if (frags.length < 2) return '';
  const last = frags[frags.length - 1].toLowerCase();
  if (SEARCH_ENGINE_PAGE_NAMES.has(last)) {
    const query = frags[0];
    if (query && isUsefulTitleCandidate(query, { source: 'ocr' })) return query;
  }
  return '';
}

function scoreCandidate(text, { source = 'ocr' } = {}) {
  const clean = displayText(text);
  if (!clean) return -Infinity;
  const words = candidateWords(clean);
  if (!words.length) return -Infinity;
  let score = 0;
  score += source === 'ocr' ? 140 : source === 'element' ? 95 : source === 'window' ? 35 : source === 'app' ? 25 : 90;
  score += Math.min(words.length, 5) * 10;
  score -= Math.max(0, words.length - 5) * 11;
  score -= Math.max(0, clean.length - 42) * 0.8;
  if (GENERIC_OCR_PHRASES.has(clean.toLowerCase())) score -= 50;
  if (BROWSER_NAME_PHRASES.has(clean.toLowerCase())) score -= 80;
  if (isBrowserNoise(clean)) score -= 60;
  if (clean.length <= 24) score += 10;
  if (/^(click|select|open|choose|enter|type|search|switch to|go to|navigate to|toggle|turn on|turn off|enable|disable|pick|focus|launch|activate)\b/i.test(clean)) score += 12;
  if (/^[\p{P}\p{S}0-9]+$/u.test(clean)) score -= 100;
  return score;
}

function pickBestOcrPhrase(ocrText) {
  const text = normalizeWhitespace(ocrText);
  if (!text) return '';
  let best = '';
  let bestScore = -Infinity;
  for (const rawLine of text.split(/\n+/)) {
    const line = normalizeWhitespace(rawLine);
    if (!line) continue;
    // For short lines (link text, button labels) try the FULL line first before splitting.
    // This preserves "Oracle | Cloud Applications and Cloud Platform" instead of splitting on |.
    // Full-line bonus (+35) nudges it ahead of its own fragments.
    const candidates = line.length <= 80
      ? [[line, 35], ...splitTitleFragments(line).map((f) => [f, 0])]
      : splitTitleFragments(line).map((f) => [f, 0]);
    for (const [part, bonus] of candidates) {
      if (!isUsefulTitleCandidate(part, { source: 'ocr' })) continue;
      const score = scoreCandidate(part, { source: 'ocr' }) + bonus;
      if (score > bestScore) {
        best = part;
        bestScore = score;
      }
    }
  }
  return best;
}

function isShortUiLabel(text) {
  const words = candidateWords(text);
  return words.length > 0 && words.length <= 2 && text.length <= 24;
}

function isDirectiveTitle(text) {
  const clean = displayText(text);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  return ACTION_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function verbForElementRole(role) {
  const clean = normalizeWhitespace(role).toLowerCase();
  if (!clean) return null;
  if (/(tab|menu item|menuitem|option|list item|tree item|radio button|dropdown list|combo box option|hyperlink|link)/.test(clean)) {
    return 'Select';
  }
  if (/(search box|searchbox|search field|search bar|search input)/.test(clean)) {
    return 'Search for';
  }
  if (/(button|check box|checkbox|toggle button|switch|item|command)/.test(clean)) {
    return 'Click';
  }
  if (/(text field|edit|combo box|textbox|text box|input|field)/.test(clean)) {
    return 'Click';
  }
  return null;
}

function formatCaptureTitle(text, { source = 'ocr', metadata = {} } = {}) {
  const clean = displayText(text);
  if (!clean) return '';

  if (isDirectiveTitle(clean)) {
    return sentenceCase(clean);
  }

  const roleVerb = (source === 'ocr' || source === 'element') ? verbForElementRole(metadata.elementRole) : null;
  if (roleVerb) {
    return `${roleVerb} ${sentenceCase(clean)}`;
  }

  if (source === 'window' || source === 'app') {
    return `Open ${sentenceCase(clean)}`;
  }

  if (source === 'ocr' || source === 'element') {
    return isShortUiLabel(clean) ? `Click ${sentenceCase(clean)}` : sentenceCase(clean);
  }

  return sentenceCase(clean);
}

function pickBestTitleFragment(text, { source = 'window', metadata = {} } = {}) {
  const fragments = splitTitleFragments(text).filter((line) => isUsefulTitleCandidate(line, { source }));
  if (!fragments.length) return '';
  let best = '';
  let bestScore = -Infinity;
  for (const part of fragments) {
    const score = scoreCandidate(part, { source });
    if (score > bestScore) {
      best = part;
      bestScore = score;
    }
  }
  return best ? formatCaptureTitle(best, { source, metadata }) : '';
}

function isPasswordField(metadata = {}) {
  const role = normalizeWhitespace(metadata.elementRole || '').toLowerCase();
  return Boolean(metadata.elementIsPassword) ||
    (/^(edit|text field|input|field|textbox|text box)$/.test(role) &&
      /password|passcode|\bpin\b/i.test(metadata.elementLabel || ''));
}

function buildCaptureTitle({ mode = 'fullscreen', metadata = {}, ocrText = '', recentTyped = '', recentShortcut = '' } = {}) {
  const app = cleanAppName(metadata.appName);

  // 1. Keyboard shortcut → most reliable signal for "what action did the user take".
  if (recentShortcut && SHORTCUT_TITLES[recentShortcut]) {
    const base = SHORTCUT_TITLES[recentShortcut];
    return app ? qualifyTitleWithApp(base, metadata.appName) : base;
  }

  const label = displayText(metadata.elementLabel || '');
  const role = normalizeWhitespace(metadata.elementRole || '').toLowerCase();
  const qualify = title => app ? qualifyTitleWithApp(title, metadata.appName) : title;

  // Name the field, never its existing value. A clicked field can contain text
  // from an earlier action (or credentials); that is not evidence of typing.
  if (isPasswordField(metadata)) {
    return qualify('Enter password');
  }
  const isInput = /^(edit|text field|input|field|combo box|textbox|text box)$/.test(role);
  if (isInput) return qualify(label ? `Enter ${label}` : 'Enter text');

  // Close only the target established by accessible ancestry. A generic Close
  // button in a web dialog must not be described as closing the browser.
  const isClose = role === 'button' &&
    (/^close(?: tab| window)?$/i.test(label) || metadata.elementAutomationId === 'Close');
  if (isClose && metadata.parentTabTitle) {
    return qualify(`Close "${displayText(metadata.parentTabTitle)}" tab`);
  }
  if (isClose && metadata.inTitleBar) return app ? `Close ${app}` : 'Close window';

  const typed = normalizeWhitespace(recentTyped || '');
  if (typed && /^(search box|searchbox|search field|search bar|search input)$/.test(role)) {
    return qualify(`Search for "${typed}"`);
  }

  // Accessible control names describe the actual target, unlike a wide OCR
  // crop that can include neighboring buttons. Preserve names containing pipes.
  if (label && !/^(window|pane|document|group|custom)$/.test(role) && !isPathOrUrlLike(label) &&
      (verbForElementRole(role) || isUsefulTitleCandidate(label, { source: 'element' }))) {
    return qualify(formatCaptureTitle(label, { source: 'element', metadata }));
  }

  const ocrPhrase = pickBestOcrPhrase(ocrText);
  if (ocrPhrase) return qualify(formatCaptureTitle(ocrPhrase, { source: 'ocr', metadata }));

  // 6. Window title (browser suffix + app name stripped) → page title or search query.
  const strippedWindowTitle = stripBrowserNameSuffix(metadata.windowTitle || '', metadata.appName);
  if (strippedWindowTitle) {
    const searchQuery = extractSearchQuery(strippedWindowTitle);
    if (searchQuery) {
      // Only claim this step IS the search action when the user was actually typing
      // (recentTyped). Without typing context, the search page title is from the
      // PREVIOUS step — the current step is a click ON the search results page.
      if (recentTyped) {
        const base = `Search for ${sentenceCase(searchQuery)}`;
        return app ? qualifyTitleWithApp(base, metadata.appName) : base;
      }
      // User is clicking something on the search results page — don't claim they searched.
      const base = `Select a ${sentenceCase(searchQuery)} result`;
      return app ? qualifyTitleWithApp(base, metadata.appName) : base;
    }
    const windowPhrase = pickBestTitleFragment(strippedWindowTitle, { source: 'window', metadata });
    if (windowPhrase) return windowPhrase;
  }

  // 7. App name alone as last resort.
  const appPhrase = pickBestTitleFragment(metadata.appName, { source: 'app', metadata });
  if (appPhrase) return appPhrase;

  return DEFAULT_CAPTURE_TITLES[mode] || 'Capture';
}

function plainTextToHtml(text) {
  // Blank lines separate paragraphs; single line breaks stay as <br>.
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map(normalizeWhitespace).filter(Boolean).join('\n'))
    .filter(Boolean)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function normalizeOllamaHost(host) {
  const raw = normalizeWhitespace(host);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

// A hostname/IP that refers to this machine only. StepForge is local-first:
// by default the Ollama endpoint must be loopback so screenshots and text
// never leave the device, unless the user explicitly opts into a remote host.
function isLoopbackHost(host) {
  const normalized = normalizeOllamaHost(host);
  if (!normalized) return false;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  const name = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1' || name === '0.0.0.0' || name === '::') return true;
  // IPv4 loopback block 127.0.0.0/8.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (m && Number(m[1]) === 127 && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255)) {
    return true;
  }
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1.
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  return false;
}

/**
 * Validate a configured Ollama endpoint against the local-first policy.
 * Returns { ok, host, reason }. Remote hosts are rejected unless the caller
 * passes allowRemote: true (the explicit ai.allowRemoteHost opt-in).
 */
function validateOllamaHost(host, { allowRemote = false } = {}) {
  const normalized = normalizeOllamaHost(host);
  if (!normalized) return { ok: false, host: '', reason: 'No Ollama host configured.' };
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return { ok: false, host: normalized, reason: 'Ollama host is not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, host: normalized, reason: 'Ollama host must use http or https.' };
  }
  if (!allowRemote && !isLoopbackHost(normalized)) {
    return {
      ok: false,
      host: normalized,
      reason:
        'Remote Ollama hosts are disabled. StepForge only contacts a local (loopback) ' +
        'Ollama by default. Enable "Allow remote AI host" in AI settings to send ' +
        'screenshots and text to this host.',
    };
  }
  return { ok: true, host: normalized, reason: '' };
}

// What each AI target writes. 'all' (title + description) is what capture
// auto-documentation uses; 'step' also writes the step's blocks.
const AI_TARGETS = ['title', 'description', 'all', 'blocks', 'step'];
const writesTitle = (target) => ['title', 'all', 'step'].includes(target);
const writesDescription = (target) => ['description', 'all', 'step'].includes(target);
const writesBlocks = (target) => ['blocks', 'step'].includes(target);

// AI may add at most this many new blocks to a step in one request, so a
// chatty model cannot bury a step in filler notes.
const MAX_NEW_AI_BLOCKS = 2;

function normalizeAiLevel(level) {
  const key = normalizeWhitespace(level).toLowerCase();
  return AI_LEVEL_ALIASES.get(key) || (TEXTBLOCK_LEVELS.includes(key) ? key : 'info');
}

function normalizeAiPosition(position) {
  const key = normalizeWhitespace(position).toLowerCase();
  return TEXTBLOCK_POSITIONS.includes(key) ? key : 'after-description';
}

// A description paragraph holding nothing but a placeholder (such as a
// [[stepforge]] credit) is never shown to the model. It is kept verbatim at
// the start or end of the description, wherever the user put it.
const PINNED_LEADING_RE = /^<(p|div)>\s*\[\[[A-Za-z0-9_ .-]+\]\]\s*<\/\1>/;
const PINNED_TRAILING_RE = /<(p|div)>\s*\[\[[A-Za-z0-9_ .-]+\]\]\s*<\/\1>$/;

function splitPinnedParagraphs(html) {
  let body = String(html || '').trim();
  const before = [];
  const after = [];
  for (let m = PINNED_LEADING_RE.exec(body); m; m = PINNED_LEADING_RE.exec(body)) {
    before.push(m[0]);
    body = body.slice(m[0].length).trim();
  }
  for (let m = PINNED_TRAILING_RE.exec(body); m; m = PINNED_TRAILING_RE.exec(body)) {
    after.unshift(m[0]);
    body = body.slice(0, m.index).trim();
  }
  return { before, body, after };
}

/** Plain text of a description without its pinned placeholder paragraphs. */
function descriptionForAi(html) {
  return htmlToText(splitPinnedParagraphs(html).body);
}

/** AI-written description HTML, with the original's pinned paragraphs kept in place. */
function withPinnedParagraphs(originalHtml, newHtml) {
  const { before, after } = splitPinnedParagraphs(originalHtml);
  return [...before, newHtml, ...after].join('');
}

/**
 * One block from a model or agent, normalized. `bodyToHtml` converts a text
 * block's body: plain text from local models, Markdown from agents.
 */
function normalizeAiBlock(block, { bodyToHtml = plainTextToHtml } = {}) {
  if (!block || typeof block !== 'object') return null;
  const kind = normalizeWhitespace(block.kind).toLowerCase();
  // The id the model echoed back, if any: it names an existing block to
  // rewrite. The normalized block always gets a fresh id of its own.
  const sourceId = normalizeWhitespace(block.id) || null;
  const order = Number.isFinite(block.order) ? block.order : null;
  if (kind === 'text') {
    return {
      ...normalizeTextBlock({
        order,
        position: normalizeAiPosition(block.position),
        level: normalizeAiLevel(block.level),
        title: displayText(block.title),
        descriptionHtml: bodyToHtml(String(block.body ?? block.description ?? block.text ?? '')),
      }, order),
      kind: 'text',
      sourceId,
      hasLevel: Boolean(normalizeWhitespace(block.level)),
    };
  }
  if (kind === 'code') {
    return {
      ...normalizeCodeBlock({
        order,
        language: displayText(block.language).toLowerCase(),
        code: String(block.code ?? ''),
      }, order),
      kind: 'code',
      sourceId,
    };
  }
  if (kind === 'table') {
    const rows = Array.isArray(block.rows)
      ? block.rows.map((row) => (Array.isArray(row) ? row.map((cell) => normalizeWhitespace(cell)) : []))
      : [];
    return { ...normalizeTableBlock({ order, rows }, order), kind: 'table', sourceId };
  }
  return null;
}

function parseAiJson(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    const jsonText = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    data = JSON.parse(jsonText);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('AI response must be a JSON object');
  }
  return data;
}

function normalizeAiPatch(raw) {
  const data = parseAiJson(raw);
  return {
    title: displayText(data.title),
    descriptionHtml: plainTextToHtml(data.description ?? data.descriptionText ?? ''),
    blocks: Array.isArray(data.blocks)
      ? data.blocks.map((block) => normalizeAiBlock(block)).filter(Boolean)
      : [],
  };
}

/** Guide-level patch: the guide's title and introduction. */
function normalizeGuidePatch(raw) {
  const data = parseAiJson(raw);
  return {
    title: displayText(data.title),
    descriptionHtml: plainTextToHtml(data.description ?? ''),
  };
}

function summarizeBlocks(step = {}) {
  const parts = [];
  for (const block of step.textBlocks || []) {
    const body = htmlToText(block.descriptionHtml || '');
    parts.push(`- Text (${block.level || 'info'}, ${block.position || 'after-description'}): ${block.title || ''}${body ? ` — ${body}` : ''}`.trim());
  }
  for (const block of step.codeBlocks || []) {
    const code = String(block.code || '').trim();
    parts.push(`- Code (${block.language || 'plain'}):\n${code || '(empty)'}`);
  }
  for (const block of step.tableBlocks || []) {
    const rows = Array.isArray(block.rows) ? block.rows.length : 0;
    const cols = rows > 0 && Array.isArray(block.rows[0]) ? block.rows[0].length : 0;
    parts.push(`- Table (${rows}x${cols})`);
  }
  return parts.length ? parts.join('\n') : '(none)';
}

/** The step's blocks as the JSON the model reads and echoes back by id. */
function blocksForAi(step = {}) {
  return orderedBlocks(step).map((block) => {
    if (block.kind === 'text') {
      return {
        id: block.id,
        kind: 'text',
        level: block.level || 'info',
        title: block.title || '',
        body: descriptionForAi(block.descriptionHtml),
      };
    }
    if (block.kind === 'code') {
      return { id: block.id, kind: 'code', language: block.language || '', code: blockText(block) };
    }
    return { id: block.id, kind: 'table', rows: Array.isArray(block.rows) ? block.rows : [] };
  });
}

const DEFAULT_PLACEHOLDER_TITLES = new Set(
  Object.values(DEFAULT_CAPTURE_TITLES).concat(['Capture', 'Untitled step']),
);

function isPlaceholderTitle(title) {
  return !title || DEFAULT_PLACEHOLDER_TITLES.has(title);
}

function summarizeStepForAi(step = {}) {
  const titleLine = isPlaceholderTitle(step.title)
    ? 'Step title: (not set — generate a specific action title from the capture context)'
    : `Step title: ${step.title}`;
  const descText = descriptionForAi(step.descriptionHtml);
  return [
    titleLine,
    `Step description: ${descText || '(empty)'}`,
    `Step status: ${step.status || 'todo'}`,
    `Blocks:\n${summarizeBlocks(step)}`,
  ].join('\n');
}

function summarizeGuideForAi(guide = {}) {
  return [
    `Guide title: ${guide.title || '(untitled)'}`,
    `Guide description: ${descriptionForAi(guide.descriptionHtml) || '(empty)'}`,
  ].join('\n');
}

function hasRichCaptureContext(captureContext) {
  if (!captureContext) return false;
  const ocr = normalizeWhitespace(captureContext.ocrText || '');
  const win = normalizeWhitespace(captureContext.windowTitle || '');
  const app = normalizeWhitespace(captureContext.appName || '');
  const element = normalizeWhitespace(captureContext.elementLabel || '');
  // Any non-trivial context signal is enough — even just an app name.
  return ocr.length > 3 || win.length > 2 || app.length > 1 || element.length > 1;
}

function hasBlur(step) {
  return Boolean(step && (step.annotations || []).some((ann) => ann.type === 'blur'));
}

function buildAiPrompt({
  target = 'all',
  guide = null,
  step = null,
  captureContext = null,
  screenshotAttached = false,
  placeholders = [],
} = {}) {
  const title = writesTitle(target);
  const description = writesDescription(target);
  const blocks = writesBlocks(target);
  const hasDraftTitle = step && !isPlaceholderTitle(step.title);
  const descText = descriptionForAi(step?.descriptionHtml);
  const hasDraftDesc = Boolean(descText);
  const existingBlocks = step ? blocksForAi(step) : [];
  // OCR read the screen before any blur was drawn, so it may hold exactly
  // what the user blurred. Steps with blurs never send OCR text.
  const ocrText = captureContext && !hasBlur(step) ? captureContext.ocrText : '';

  const titleTask = hasDraftTitle
    ? 'improve the user\'s draft step title — keep their intent, make it read like professional documentation'
    : 'write a specific action title for this step using the capture context';
  const descriptionTask = hasDraftDesc
    ? 'improve the user\'s draft description — keep their intent, make it read like professional documentation'
    : 'write a 1–2 sentence description of what the user does in this step, using the capture context';
  const blocksTask = existingBlocks.length
    ? 'rewrite the step\'s blocks, and add a block only where the reader needs one'
    : 'add a block only where the reader needs one (warnings, tips, commands to type)';
  const targetText = [title && titleTask, description && descriptionTask, blocks && blocksTask]
    .filter(Boolean).join('; then ');

  const richContext = hasRichCaptureContext(captureContext ? { ...captureContext, ocrText } : null);

  // When the user already has a draft, surface it prominently so the model
  // knows exactly what text to polish rather than generating from scratch.
  const draftTitleLine = hasDraftTitle && title ? `User's draft title (rewrite this): "${step.title}"` : null;
  const draftDescLine = hasDraftDesc && description ? `User's draft description (rewrite this): "${descText}"` : null;

  const contextLines = [
    ...(captureContext ? [
      captureContext.windowTitle ? `Active window: ${captureContext.windowTitle}` : null,
      captureContext.appName ? `App: ${captureContext.appName}` : null,
      captureContext.elementLabel ? `UI element: ${captureContext.elementLabel}${captureContext.elementRole ? ` (${captureContext.elementRole})` : ''}` : null,
      captureContext.elementValue ? `Element content (what was typed): ${captureContext.elementValue}` : null,
      captureContext.recentTyped ? `Keyboard input before this step: ${captureContext.recentTyped}` : null,
      captureContext.recentShortcut ? `Keyboard shortcut used: ${captureContext.recentShortcut}` : null,
      ocrText ? `OCR text near click:\n${ocrText}` : null,
      (!hasDraftTitle || !title) && captureContext.titleCandidate
        ? `Suggested title: ${captureContext.titleCandidate}` : null,
    ] : []),
    screenshotAttached ? 'Screenshot: attached to this request.' : null,
    draftTitleLine,
    draftDescLine,
  ].filter(Boolean);

  const schema = [
    '{',
    title ? '  "title": string, // this step\'s title' : null,
    description ? '  "description": string, // this step\'s description' : null,
    blocks ? [
      '  "blocks": [{',
      '    "id"?: string,',
      '    "kind": "text" | "code" | "table",',
      '    "level"?: "info" | "warn" | "error" | "success",',
      '    "title"?: string,',
      '    "body"?: string,',
      '    "language"?: string,',
      '    "code"?: string,',
      '    "rows"?: string[][]',
      '  }]',
    ].join('\n') : null,
    '}',
  ].filter(Boolean).join('\n');

  const prompt = [
    'You write concise, action-focused step-by-step documentation for a desktop application guide.',
    'Return JSON only. No markdown fences, no commentary, no extra keys outside the schema below.',
    'Schema:',
    schema,
    '',
    `Target: ${targetText}.`,
    '',
    guide ? `The guide this step belongs to (context only — never copy it into the step):\n${summarizeGuideForAi(guide)}` : 'Guide: (not provided)',
    '',
    step ? `The step to write:\n${summarizeStepForAi(step)}` : 'Step: (not provided)',
    '',
    contextLines.length
      ? `Capture context:\n${contextLines.join('\n')}`
      : 'Capture context: (not available)',
    blocks ? `\nExisting blocks (JSON):\n${JSON.stringify(existingBlocks, null, 2)}` : null,
    (description || blocks) && placeholders.length ? `\n${placeholderPromptLines(placeholders).join('\n')}` : null,
    '',
    'Rules:',
    title ? '- "title" is this step\'s title, never the guide\'s title. Titles must be short imperative actions: "Click Save", "Select New document", "Open Settings".' : null,
    title ? '- NEVER output "Screen capture", "Window capture", "Region capture", or "Capture" as a title — always produce something specific.' : null,
    title ? (hasDraftTitle
      ? '- The user wrote their own title (shown above). Your only job is to polish its grammar and phrasing. Do NOT replace it with something different. Do NOT change what action or subject it describes.'
      : '- No title yet. Use the capture context (OCR text, window, app) to write a specific action title.') : null,
    description ? (hasDraftDesc
      ? '- The user wrote their own description (shown above). Polish the wording to sound professional but preserve every fact and intent they stated.'
      : '- No description yet. Write 1–2 sentences describing exactly what the user does.') : null,
    blocks && existingBlocks.length
      ? '- Rewrite every existing block listed above. Copy its "id" and "kind" so it is updated in place, and keep its meaning.'
      : null,
    blocks
      ? `- Add a new block (with no "id") only when the reader truly needs it: a warning before a risky action, a tip that saves time, or a command or value to type. Add at most ${MAX_NEW_AI_BLOCKS} new blocks; adding none is fine.`
      : null,
    blocks ? '- Block levels: "warn" for warnings, "error" for must-know information, "success" for tips, "info" for notes.' : null,
    blocks ? '- Never repeat the step description in a block.' : null,
    blocks ? null : '- Do NOT include a "blocks" key.',
    '- Keep every [[placeholder]] token (such as [[Product]]) exactly as written.',
    richContext
      ? '- Use the OCR text, window title, app name, and element info to make the documentation specific.'
      : '- Context is limited. Use the app name or window title if available; generate a reasonable action title.',
    screenshotAttached
      ? '- A screenshot is attached. Marks drawn on it, such as a circle or a number, show where the user clicked. Use it to resolve visual details, but do not mention the screenshot in the output.'
      : '- No screenshot is attached. Rely on OCR, the window title, app name, and element info.',
    '- Do NOT generate blocks that describe the technical capture process or mention OCR.',
    '- Do NOT invent details not supported by the capture context.',
  ].filter((l) => l !== null).join('\n');

  return {
    systemPrompt: 'You are a technical documentation writer. Emit only valid JSON matching the schema. Never add commentary or markdown.',
    prompt,
  };
}

// Long guides are summarized for the guide-level prompt: each step's text is
// clipped and only the first steps are listed, so the prompt stays small.
const GUIDE_PROMPT_MAX_STEPS = 80;
const GUIDE_PROMPT_MAX_STEP_CHARS = 240;

/**
 * Prompt for the guide's own title and introduction, written from its steps.
 * `steps` are in guide order: { number, title, descriptionHtml }.
 */
function buildGuideAiPrompt({ guide = {}, steps = [], placeholders = [] } = {}) {
  const clip = (text) => (text.length > GUIDE_PROMPT_MAX_STEP_CHARS
    ? `${text.slice(0, GUIDE_PROMPT_MAX_STEP_CHARS - 1)}…` : text);
  const outline = steps.slice(0, GUIDE_PROMPT_MAX_STEPS).map((step) => {
    const text = descriptionForAi(step.descriptionHtml);
    return `${step.number}. ${isPlaceholderTitle(step.title) ? '(untitled)' : step.title}${text ? ` — ${clip(text)}` : ''}`;
  });
  if (steps.length > GUIDE_PROMPT_MAX_STEPS) outline.push(`… and ${steps.length - GUIDE_PROMPT_MAX_STEPS} more steps`);
  const descText = descriptionForAi(guide.descriptionHtml);

  const prompt = [
    'You write the title and introduction of a step-by-step guide.',
    'Return JSON only. No markdown fences, no commentary, no extra keys outside the schema below.',
    'Schema:',
    '{ "title": string, "description": string }',
    '',
    `Current guide title: ${guide.title || '(none)'}`,
    `Current guide description: ${descText || '(empty)'}`,
    '',
    `Steps:\n${outline.join('\n') || '(none)'}`,
    ...(placeholders.length ? ['', ...placeholderPromptLines(placeholders)] : []),
    '',
    'Rules:',
    '- The title is short and says what the reader will get done, for example "Submit a lab in Canvas" or "Set up SSH keys on Ubuntu".',
    '- If the current title already says what the guide does, keep it and only fix its grammar. If it is generic, such as "Untitled guide" or a capture time, replace it.',
    descText
      ? '- The user wrote their own description (shown above). Polish the wording but keep every fact and intent they stated.'
      : '- Write a 1–3 sentence description of what the guide helps the reader do.',
    '- Mention something the reader needs before starting only if a step shows it. Never add generic requirements such as an internet connection or administrator rights.',
    '- Do not list the steps in the description.',
    '- Keep every [[placeholder]] token (such as [[Product]]) exactly as written.',
    '- Do NOT invent details the steps do not support.',
  ].join('\n');

  return {
    systemPrompt: 'You are a technical documentation writer. Emit only valid JSON matching the schema. Never add commentary or markdown.',
    prompt,
  };
}

/**
 * Rewrite existing blocks matched by id, and append at most `maxNew` new ones.
 * Never deletes. Text block bodies get `placeholders` tokens for their values.
 */
function mergeAiBlocks(step, blocks, { maxNew = MAX_NEW_AI_BLOCKS, placeholders = [] } = {}) {
  const lists = {
    text: step.textBlocks || (step.textBlocks = []),
    code: step.codeBlocks || (step.codeBlocks = []),
    table: step.tableBlocks || (step.tableBlocks = []),
  };
  let order = nextBlockOrder(step);
  let added = 0;
  for (const block of blocks) {
    const list = lists[block.kind];
    if (!list) continue;
    const existing = block.sourceId ? list.find((candidate) => candidate.id === block.sourceId) : null;
    if (existing) {
      if (block.kind === 'text') {
        if (block.title) existing.title = block.title;
        if (htmlToText(block.descriptionHtml)) {
          existing.descriptionHtml = sanitizeHtml(withPinnedParagraphs(existing.descriptionHtml,
            substitutePlaceholders(block.descriptionHtml, placeholders)));
        }
        if (block.hasLevel) existing.level = block.level;
      } else if (block.kind === 'code') {
        if (block.code) existing.code = block.code;
        if (block.language) existing.language = block.language;
      } else if (block.rows.length) {
        existing.rows = block.rows;
      }
      continue;
    }
    if (added >= maxNew) continue;
    const { kind, sourceId, hasLevel, ...fields } = block;
    if (kind === 'text' && !fields.title && !htmlToText(fields.descriptionHtml)) continue;
    if (kind === 'code' && !fields.code) continue;
    if (kind === 'table' && !fields.rows.length) continue;
    if (kind === 'text') fields.descriptionHtml = substitutePlaceholders(fields.descriptionHtml, placeholders);
    list.push({ ...fields, order: order++ });
    added += 1;
  }
}

/**
 * Apply a model's patch to a step. `placeholders` (usable ones, see
 * core/ai-placeholders.js) replace their values with [[tokens]] in the
 * AI-written description and block text.
 */
function applyAiPatchToStep(step, patch, { target = 'all', guideTitle = '', placeholders = [] } = {}) {
  const next = deepClone(step);
  // Small models sometimes answer with the guide's title. A step that already
  // has a real title keeps it rather than taking the guide's.
  const copiedGuideTitle = Boolean(guideTitle) && !isPlaceholderTitle(step.title)
    && normalizeWhitespace(patch.title).toLowerCase() === normalizeWhitespace(guideTitle).toLowerCase();
  if (writesTitle(target) && patch.title && !copiedGuideTitle) {
    next.title = displayText(patch.title);
  }
  if (writesDescription(target) && patch.descriptionHtml) {
    next.descriptionHtml = sanitizeHtml(withPinnedParagraphs(step.descriptionHtml,
      substitutePlaceholders(patch.descriptionHtml, placeholders)));
  }
  if (writesBlocks(target) && Array.isArray(patch.blocks) && patch.blocks.length) {
    mergeAiBlocks(next, patch.blocks, { placeholders });
  }
  if (!next.image) {
    const hasBody = Boolean(
      next.title ||
      htmlToText(next.descriptionHtml || '') ||
      (next.textBlocks || []).length ||
      (next.codeBlocks || []).length ||
      (next.tableBlocks || []).length,
    );
    if (hasBody) next.kind = 'content';
  }
  return next;
}

function applyGuidePatch(guide, patch, { placeholders = [] } = {}) {
  const next = deepClone(guide);
  if (patch.title) next.title = displayText(patch.title);
  if (patch.descriptionHtml) {
    next.descriptionHtml = sanitizeHtml(withPinnedParagraphs(guide.descriptionHtml,
      substitutePlaceholders(patch.descriptionHtml, placeholders)));
  }
  return next;
}

module.exports = {
  AI_TARGETS,
  DEFAULT_CAPTURE_TITLES,
  buildCaptureTitle,
  isPasswordField,
  plainTextToHtml,
  normalizeOllamaHost,
  isLoopbackHost,
  validateOllamaHost,
  normalizeAiPatch,
  normalizeGuidePatch,
  buildAiPrompt,
  buildGuideAiPrompt,
  applyAiPatchToStep,
  applyGuidePatch,
  normalizeAiBlock,
  mergeAiBlocks,
  splitPinnedParagraphs,
  withPinnedParagraphs,
  isPlaceholderTitle,
  descriptionForAi,
  blocksForAi,
  summarizeStepForAi,
  summarizeGuideForAi,
  displayText,
  normalizeWhitespace,
  scoreCandidate,
  pickBestOcrPhrase,
};
