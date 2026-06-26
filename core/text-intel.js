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

function buildCaptureTitle({ mode = 'fullscreen', metadata = {}, ocrText = '', recentTyped = '', recentShortcut = '' } = {}) {
  const app = cleanAppName(metadata.appName);

  // 1. Keyboard shortcut → most reliable signal for "what action did the user take".
  if (recentShortcut && SHORTCUT_TITLES[recentShortcut]) {
    const base = SHORTCUT_TITLES[recentShortcut];
    return app ? qualifyTitleWithApp(base, metadata.appName) : base;
  }

  // 2. UIAutomation element value — what's actually typed inside the clicked field.
  const elementValue = normalizeWhitespace(metadata.elementValue || '');
  if (elementValue) {
    const roleLower = normalizeWhitespace(metadata.elementRole || '').toLowerCase();
    const labelLower = normalizeWhitespace(metadata.elementLabel || '').toLowerCase();
    const looksLikeSearch = /(search|find|query|omnibox|address bar)/.test(roleLower + ' ' + labelLower);
    const action = looksLikeSearch ? 'Search for' : 'Type';
    const base = `${action} "${elementValue}"`;
    return app ? qualifyTitleWithApp(base, metadata.appName) : base;
  }

  // 3. Keyboard-buffer text (typed between captures) + input role context.
  const typed = normalizeWhitespace(recentTyped || '');
  if (typed) {
    const roleLower = normalizeWhitespace(metadata.elementRole || '').toLowerCase();
    const labelLower = normalizeWhitespace(metadata.elementLabel || '').toLowerCase();
    const isSearchRole = /(search box|searchbox|search field|search bar|search input)/.test(roleLower);
    const looksLikeSearch = isSearchRole || /(search|find|query|omnibox|address bar)/.test(roleLower + ' ' + labelLower);
    const isAnyInput = /(text field|edit|input|field|combo box|textbox|text box)/.test(roleLower);
    if (looksLikeSearch) {
      const base = `Search for "${typed}"`;
      return app ? qualifyTitleWithApp(base, metadata.appName) : base;
    }
    if (isAnyInput) {
      const base = `Type "${typed}"`;
      return app ? qualifyTitleWithApp(base, metadata.appName) : base;
    }
  }

  // 4. OCR text around the click — link text, button labels, menu items.
  const ocrPhrase = pickBestOcrPhrase(ocrText);
  if (ocrPhrase) {
    const title = formatCaptureTitle(ocrPhrase, { source: 'ocr', metadata });
    return app ? qualifyTitleWithApp(title, metadata.appName) : title;
  }

  // 5. UIAutomation element label.
  const elementPhrase = pickBestTitleFragment(metadata.elementLabel, { source: 'element', metadata });
  if (elementPhrase) {
    return app ? qualifyTitleWithApp(elementPhrase, metadata.appName) : elementPhrase;
  }

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
  const trimmed = normalizeWhitespace(text);
  if (!trimmed) return '';
  return trimmed
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function normalizeOllamaHost(host) {
  const raw = normalizeWhitespace(host);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

function normalizeAiLevel(level) {
  const key = normalizeWhitespace(level).toLowerCase();
  return AI_LEVEL_ALIASES.get(key) || (TEXTBLOCK_LEVELS.includes(key) ? key : 'info');
}

function normalizeAiPosition(position) {
  const key = normalizeWhitespace(position).toLowerCase();
  return TEXTBLOCK_POSITIONS.includes(key) ? key : 'after-description';
}

function normalizeAiBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const kind = normalizeWhitespace(block.kind).toLowerCase();
  if (kind === 'text') {
    const normalized = normalizeTextBlock({
      id: block.id,
      order: Number.isFinite(block.order) ? block.order : null,
      position: normalizeAiPosition(block.position),
      level: normalizeAiLevel(block.level),
      title: displayText(block.title),
      descriptionHtml: plainTextToHtml(block.body ?? block.description ?? block.text ?? ''),
    }, Number.isFinite(block.order) ? block.order : null);
    return { ...normalized, kind: 'text' };
  }
  if (kind === 'code') {
    return {
      ...normalizeCodeBlock({
        id: block.id,
        order: Number.isFinite(block.order) ? block.order : null,
        language: displayText(block.language).toLowerCase(),
        code: String(block.code ?? ''),
      }, Number.isFinite(block.order) ? block.order : null),
      kind: 'code',
    };
  }
  if (kind === 'table') {
    const rows = Array.isArray(block.rows)
      ? block.rows.map((row) => (Array.isArray(row) ? row.map((cell) => displayText(cell)) : []))
      : [];
    return {
      ...normalizeTableBlock({
        id: block.id,
        order: Number.isFinite(block.order) ? block.order : null,
        rows,
      }, Number.isFinite(block.order) ? block.order : null),
      kind: 'table',
    };
  }
  return null;
}

function normalizeAiPatch(raw) {
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
  const out = {
    title: displayText(data.title),
    descriptionHtml: plainTextToHtml(data.description ?? data.descriptionText ?? ''),
    blocks: Array.isArray(data.blocks)
      ? data.blocks.map((block) => normalizeAiBlock(block)).filter(Boolean)
      : [],
  };
  return out;
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
  const descText = htmlToText(step.descriptionHtml || '');
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
    `Guide description: ${htmlToText(guide.descriptionHtml || '') || '(empty)'}`,
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

function buildAiPrompt({
  target = 'all',
  guide = null,
  step = null,
  captureContext = null,
  block = null,
  screenshotAttached = false,
} = {}) {
  const hasDraftTitle = step && !isPlaceholderTitle(step.title);
  const hasDraftDesc = step && Boolean(htmlToText(step.descriptionHtml || ''));

  const targetText = {
    title: hasDraftTitle
      ? 'improve the user\'s draft step title — keep their intent, make it read like professional documentation'
      : 'write a specific action title for this step using the capture context',
    description: hasDraftDesc
      ? 'improve the user\'s draft description — keep their intent, make it read like professional documentation'
      : 'write a 1–2 sentence description of what the user does in this step, using the capture context',
    block: 'rewrite only the target block',
    all: 'write the step title and description from the capture context',
  }[target] || 'rewrite the step';

  const richContext = hasRichCaptureContext(captureContext);

  const allowedBlockNote = target === 'block' ? [
    'Use block.kind = "text" with level in [info, warn, error, success] for note / warning / important / tip blocks.',
    'Use block.kind = "code" for code snippets.',
    'Use block.kind = "table" for tables, with rows as arrays of strings.',
    'Use block.position values from [before-title, after-title, before-image, after-image, before-description, after-description].',
  ].join(' ') : null;

  // When the user already has a draft, surface it prominently so the model
  // knows exactly what text to polish rather than generating from scratch.
  const descText = htmlToText(step?.descriptionHtml || '');
  const draftTitleLine = hasDraftTitle && (target === 'title' || target === 'all')
    ? `User's draft title (rewrite this): "${step.title}"` : null;
  const draftDescLine = hasDraftDesc && (target === 'description' || target === 'all')
    ? `User's draft description (rewrite this): "${descText}"` : null;

  const contextLines = [
    ...(captureContext ? [
      captureContext.windowTitle ? `Active window: ${captureContext.windowTitle}` : null,
      captureContext.appName ? `App: ${captureContext.appName}` : null,
      captureContext.elementLabel ? `UI element: ${captureContext.elementLabel}${captureContext.elementRole ? ` (${captureContext.elementRole})` : ''}` : null,
      captureContext.elementValue ? `Element content (what was typed): ${captureContext.elementValue}` : null,
      captureContext.recentTyped ? `Keyboard input before this step: ${captureContext.recentTyped}` : null,
      captureContext.recentShortcut ? `Keyboard shortcut used: ${captureContext.recentShortcut}` : null,
      captureContext.ocrText ? `OCR text near click:\n${captureContext.ocrText}` : null,
      (!hasDraftTitle || target === 'description') && captureContext.titleCandidate
        ? `Suggested title: ${captureContext.titleCandidate}` : null,
    ] : []),
    screenshotAttached ? 'Screenshot: attached to this request.' : null,
    draftTitleLine,
    draftDescLine,
  ].filter(Boolean);

  const prompt = [
    'You write concise, action-focused step-by-step documentation for a desktop application guide.',
    'Return JSON only. No markdown fences, no commentary, no extra keys outside the schema below.',
    'Schema:',
    target === 'block' ? [
      '{',
      '  "title": string,',
      '  "description": string,',
      '  "blocks": [{',
      '    "kind": "text" | "code" | "table",',
      '    "position"?: "before-title" | "after-title" | "before-image" | "after-image" | "before-description" | "after-description",',
      '    "level"?: "info" | "warn" | "error" | "success",',
      '    "title"?: string,',
      '    "body"?: string,',
      '    "language"?: string,',
      '    "code"?: string,',
      '    "rows"?: string[][]',
      '  }]',
      '}',
    ].join('\n') : '{ "title": string, "description": string }',
    '',
    `Target: ${targetText}.`,
    allowedBlockNote,
    '',
    guide ? summarizeGuideForAi(guide) : 'Guide: (not provided)',
    '',
    step ? summarizeStepForAi(step) : 'Step: (not provided)',
    '',
    contextLines.length
      ? `Capture context:\n${contextLines.join('\n')}`
      : 'Capture context: (not available)',
    '',
    block ? `Target block:\n${JSON.stringify(block, null, 2)}` : null,
    '',
    'Rules:',
    '- Titles must be short imperative actions: "Click Save", "Select New document", "Open Settings".',
    '- NEVER output "Screen capture", "Window capture", "Region capture", or "Capture" as a title — always produce something specific.',
    hasDraftTitle && (target === 'title' || target === 'all')
      ? '- The user wrote their own title (shown above). Your only job is to polish its grammar and phrasing. Do NOT replace it with something different. Do NOT change what action or subject it describes.'
      : '- No title yet. Use the capture context (OCR text, window, app) to write a specific action title.',
    hasDraftDesc && (target === 'description' || target === 'all')
      ? '- The user wrote their own description (shown above). Polish the wording to sound professional but preserve every fact and intent they stated.'
      : '- No description yet. Write 1–2 sentences describing exactly what the user does.',
    target === 'block'
      ? '- Only include blocks that provide genuinely useful supplemental information (warnings, tips, code).'
      : '- Do NOT add any blocks array. Only output "title" and "description".',
    richContext
      ? '- Use the OCR text, window title, app name, and element info to make the documentation specific.'
      : '- Context is limited. Use the app name or window title if available; generate a reasonable action title.',
    screenshotAttached
      ? '- A screenshot is attached. Use it together with the OCR and metadata to resolve visual details, but do not mention the screenshot in the output.'
      : '- No screenshot is attached. Rely on OCR, the window title, app name, and element info.',
    '- Do NOT generate blocks that describe the technical capture process or mention OCR.',
    '- Do NOT invent details not supported by the capture context.',
    '- If the target is one block, only rewrite that block.',
  ].filter((l) => l !== null).join('\n');

  return {
    systemPrompt: 'You are a technical documentation writer. Emit only valid JSON matching the schema. Never add commentary or markdown.',
    prompt,
  };
}

function applyAiPatchToStep(step, patch, { target = 'all', blockId = null } = {}) {
  const next = deepClone(step);
  if ((target === 'all' || target === 'title') && patch.title) {
    next.title = displayText(patch.title);
  }
  if ((target === 'all' || target === 'description') && patch.descriptionHtml) {
    next.descriptionHtml = sanitizeHtml(patch.descriptionHtml);
  }

  if (target === 'all' && Array.isArray(patch.blocks) && patch.blocks.length) {
    const textBlocks = [];
    const codeBlocks = [];
    const tableBlocks = [];
    let nextOrder = 1;
    for (const block of patch.blocks) {
      const clone = deepClone(block);
      clone.order = nextOrder++;
      if (clone.kind === 'text') textBlocks.push(clone);
      else if (clone.kind === 'code') codeBlocks.push(clone);
      else if (clone.kind === 'table') tableBlocks.push(clone);
    }
    next.textBlocks = textBlocks;
    next.codeBlocks = codeBlocks;
    next.tableBlocks = tableBlocks;
  } else if (target === 'block' && blockId && Array.isArray(patch.blocks) && patch.blocks.length) {
    const replacement = patch.blocks[0];
    const textBlock = (next.textBlocks || []).find((block) => block.id === blockId);
    const codeBlock = (next.codeBlocks || []).find((block) => block.id === blockId);
    const tableBlock = (next.tableBlocks || []).find((block) => block.id === blockId);
    if (textBlock && replacement.kind === 'text') {
      if (replacement.position) textBlock.position = replacement.position;
      if (replacement.level) textBlock.level = replacement.level;
      if (replacement.title) textBlock.title = replacement.title;
      if (replacement.descriptionHtml) textBlock.descriptionHtml = sanitizeHtml(replacement.descriptionHtml);
    } else if (codeBlock && replacement.kind === 'code') {
      if (replacement.language) codeBlock.language = replacement.language;
      if (replacement.code) codeBlock.code = replacement.code;
    } else if (tableBlock && replacement.kind === 'table') {
      if (replacement.rows) tableBlock.rows = replacement.rows;
    }
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

module.exports = {
  DEFAULT_CAPTURE_TITLES,
  buildCaptureTitle,
  plainTextToHtml,
  normalizeOllamaHost,
  normalizeAiPatch,
  buildAiPrompt,
  applyAiPatchToStep,
  summarizeStepForAi,
  summarizeGuideForAi,
  displayText,
  normalizeWhitespace,
  scoreCandidate,
  pickBestOcrPhrase,
};
