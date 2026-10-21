'use strict';

const { CODE_THEMES, BRACKET_COLORS } = require('./code-themes');

/**
 * Syntax highlighting for exported code blocks. highlight.js finds the
 * tokens; this module turns them into colored runs, one array per line, that
 * each exporter draws in its own format (PDF text, Word runs, HTML spans).
 */

// Settings → General → Exports → Code theme. 'plain' keeps code blocks uncolored.
const DEFAULT_CODE_THEME = 'atom-one-dark';
const PLAIN = 'plain';
const CODE_THEME_CHOICES = [
  ...Object.entries(CODE_THEMES).map(([value, theme]) => ({ value, label: theme.label })),
  { value: PLAIN, label: 'Plain (no highlighting)' },
];

// What exports use when no settings reach them (scripts, tests, the CLI).
const DEFAULT_CODE_STYLE = { theme: DEFAULT_CODE_THEME };

/** The Code theme setting -> the style exporters use; anything unknown gets the default. */
function resolveCodeStyle(theme) {
  return { theme: theme === PLAIN || CODE_THEMES[theme] ? theme : DEFAULT_CODE_THEME };
}

let hljs = null;
let aliasToId = null;

// Loading every grammar takes a moment, so only exports that have code pay it.
function loadHljs() {
  if (!hljs) {
    hljs = require('highlight.js');
    aliasToId = new Map();
    for (const id of hljs.listLanguages()) {
      aliasToId.set(id, id);
      for (const alias of hljs.getLanguage(id).aliases || []) aliasToId.set(alias.toLowerCase(), id);
    }
  }
  return hljs;
}

/**
 * The highlight.js language for what someone typed in a code block's
 * Language box ("Python", "py", "python3", "Python 3", "C#"), or null.
 */
function normalizeLanguage(raw) {
  const typed = String(raw || '').trim().toLowerCase();
  if (!typed) return null;
  loadHljs();
  for (const candidate of [typed, typed.replace(/\s+/g, ''), typed.replace(/[\s\d.]+$/, '')]) {
    if (candidate && aliasToId.has(candidate)) return aliasToId.get(candidate);
  }
  return null;
}

/**
 * The info string for a Markdown fence: a name every Markdown editor knows
 * ("Python 3" -> "python"), or what was typed when it isn't a known language.
 */
function markdownFenceLanguage(raw) {
  const typed = String(raw || '').trim();
  if (!typed) return '';
  loadHljs();
  if (aliasToId.has(typed.toLowerCase())) return typed.toLowerCase();
  return normalizeLanguage(typed) || typed;
}

// Formats where "name(" isn't a function call, so calls aren't marked.
const NO_CALLS = new Set(['plaintext', 'markdown', 'xml', 'json', 'yaml', 'ini', 'diff', 'css', 'scss', 'less', 'properties']);
// Brackets inside these read as text, so they keep the token's color.
const TEXT_SCOPES = new Set(['string', 'comment', 'quote', 'regexp', 'doctag']);
const CALL_CLASSES = ['title', 'function_', 'invoke__'];
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m, name) => ENTITIES[name]);

/** highlight.js HTML -> [{ text, stack }] where stack lists each enclosing span's classes. */
function parseHljsHtml(html) {
  const segments = [];
  const stack = [];
  for (const [, open, close, text] of html.matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/g)) {
    if (open !== undefined) stack.push(open.split(/\s+/).map((c) => c.replace(/^hljs-/, '')));
    else if (close) stack.pop();
    else segments.push({ text: decode(text), stack: [...stack] });
  }
  return segments;
}

/** Split plain text so `name(` becomes a function-call token, as editors color it. */
function markCalls(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg.stack.length) { out.push(seg); continue; }
    let last = 0;
    for (const m of seg.text.matchAll(/[A-Za-z_$][\w$]*(?=\s*\()/g)) {
      if (m.index > last) out.push({ text: seg.text.slice(last, m.index), stack: [] });
      out.push({ text: m[0], stack: [CALL_CLASSES] });
      last = m.index + m[0].length;
    }
    if (last < seg.text.length) out.push({ text: seg.text.slice(last), stack: [] });
  }
  return out;
}

/** Does a compound selector (classes on one token) match this token's classes? */
const compoundMatches = (compound, classes) => compound.every((c) => classes.includes(c));

/** Does a rule selector match the element at the end of `chain` (root first)? */
function selectorMatches(parts, chain) {
  if (!compoundMatches(parts[parts.length - 1], chain[chain.length - 1])) return false;
  let at = chain.length - 2;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (at >= 0 && !compoundMatches(parts[p], chain[at])) at--;
    if (at < 0) return false;
    at--;
  }
  return true;
}

function compileTheme(theme) {
  if (theme.compiled) return theme.compiled;
  theme.compiled = theme.rules.map(([selector, color, flags = ''], index) => {
    const parts = selector.split(' ').map((p) => p.split('.'));
    return {
      parts,
      specificity: parts.reduce((n, p) => n + p.length, 0),
      index,
      color,
      italic: flags.includes('i') ? true : flags.includes('n') ? false : undefined,
      bold: flags.includes('b') ? true : flags.includes('r') ? false : undefined,
    };
  });
  return theme.compiled;
}

/**
 * The color/italic/bold for a token, worked out the way a browser applies
 * the theme's CSS: the most specific matching rule sets each property, and
 * anything no rule sets is inherited from the enclosing token.
 */
function styleFor(theme, rootClasses, stack, cache) {
  const key = stack.map((c) => c.join('.')).join(' ');
  if (cache.has(key)) return cache.get(key);
  const rules = compileTheme(theme);
  const chain = [rootClasses];
  let style = { color: theme.foreground, italic: false, bold: false };
  for (const classes of stack) {
    chain.push(classes);
    const next = { ...style };
    const best = {};
    for (const rule of rules) {
      if (!selectorMatches(rule.parts, chain)) continue;
      for (const prop of ['color', 'italic', 'bold']) {
        if (rule[prop] == null) continue;
        const prev = best[prop];
        if (!prev || rule.specificity > prev.specificity || (rule.specificity === prev.specificity && rule.index > prev.index)) best[prop] = rule;
      }
    }
    for (const prop of Object.keys(best)) next[prop] = best[prop][prop];
    style = next;
  }
  cache.set(key, style);
  return style;
}

/**
 * Highlight one code block. Returns null for the Plain theme (exporters keep
 * their uncolored look); otherwise the theme's background/foreground and
 * `lines`, each an array of { text, color, italic, bold } runs.
 */
function highlightCode(code, language, codeStyle = DEFAULT_CODE_STYLE) {
  const style = codeStyle || DEFAULT_CODE_STYLE;
  if (style.theme === PLAIN) return null;
  const theme = CODE_THEMES[style.theme] || CODE_THEMES[DEFAULT_CODE_THEME];
  const text = String(code || '').replace(/\r\n?/g, '\n');
  const lang = normalizeLanguage(language);

  let segments = [{ text, stack: [] }];
  if (lang) {
    try {
      segments = parseHljsHtml(loadHljs().highlight(text, { language: lang, ignoreIllegals: true }).value);
      if (!NO_CALLS.has(lang)) segments = markCalls(segments);
    } catch {
      segments = [{ text, stack: [] }];
    }
  }

  const rootClasses = lang ? [`language-${lang}`] : [];
  const cache = new Map();
  // Matching brackets are colored by depth, as VS Code does, for any known language.
  const brackets = lang ? BRACKET_COLORS[theme.dark ? 'dark' : 'light'] : null;
  const open = [];
  const lines = [[]];
  const push = (piece, run) => {
    const parts = piece.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1];
      const prev = line[line.length - 1];
      if (prev && prev.color === run.color && prev.italic === run.italic && prev.bold === run.bold) prev.text += part;
      else line.push({ text: part, color: run.color, italic: run.italic, bold: run.bold });
    });
  };

  for (const seg of segments) {
    const tokenStyle = styleFor(theme, rootClasses, seg.stack, cache);
    if (!brackets || seg.stack.some((classes) => TEXT_SCOPES.has(classes[0]))) {
      push(seg.text, tokenStyle);
      continue;
    }
    let last = 0;
    for (const m of seg.text.matchAll(/[()[\]{}]/g)) {
      const ch = m[0];
      let color = null;
      if (OPENERS[ch]) {
        color = brackets[open.length % brackets.length];
        open.push(OPENERS[ch]);
      } else if (CLOSERS.has(ch) && open[open.length - 1] === ch) {
        open.pop();
        color = brackets[open.length % brackets.length];
      }
      if (!color) continue; // an unmatched closer keeps the token's color
      if (m.index > last) push(seg.text.slice(last, m.index), tokenStyle);
      push(ch, { ...tokenStyle, color });
      last = m.index + 1;
    }
    if (last < seg.text.length) push(seg.text.slice(last), tokenStyle);
  }

  return { background: theme.background, foreground: theme.foreground, dark: theme.dark, lines };
}

module.exports = {
  CODE_THEME_CHOICES,
  DEFAULT_CODE_THEME,
  DEFAULT_CODE_STYLE,
  PLAIN,
  resolveCodeStyle,
  normalizeLanguage,
  markdownFenceLanguage,
  highlightCode,
};
