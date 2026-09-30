'use strict';

const crypto = require('node:crypto');

/*
 * Finds private details in text: in the words text recognition read from a
 * screenshot, and in a step's own title and description. Everything runs on
 * this computer. Findings become ordinary blur annotations (marked `redact`)
 * that the user can keep, move or remove; removing one remembers the
 * decision so a later scan doesn't add it back.
 *
 * Rules favour catching secrets over avoiding the odd false alarm: a blur
 * that wasn't needed costs a click, a missed password costs much more.
 */

// Bump when the rules change so guides are scanned again.
const RULES_VERSION = 1;

const KINDS = {
  email: 'Email address',
  phone: 'Phone number',
  card: 'Card number',
  ssn: 'Social Security number',
  ip: 'IP address',
  secret: 'Password or key',
  url: 'Link with a private token',
  custom: 'Word you asked to hide',
};

const TOKEN_PREFIXES = [
  /\bAKIA[0-9A-Z]{12,20}\b/g, // AWS access key (text recognition sometimes drops a character)
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JSON web token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

// "password: hunter2", "API key = abc…": hide what follows the label.
const LABELLED = /\b(pass(?:word|wd|code|phrase)?|pwd|pin|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|private[ _-]?key|ssn|social security(?: number)?)\s*[:=]\s*([^\s&]+)/gi;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Long strings mixing letters and digits, like keys, that aren't words.
function looksLikeKey(word) {
  if (word.length < 24 || /\s/.test(word)) return false;
  if (!/[A-Za-z]/.test(word) || !/\d/.test(word)) return false;
  if (/^https?:/i.test(word) || /[\\/]/.test(word)) return false;
  const counts = new Map();
  for (const c of word) counts.set(c, (counts.get(c) || 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) { const p = n / word.length; entropy -= p * Math.log2(p); }
  return entropy >= 3.5;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Private details in `text`: [{ kind, start, end, text }]. `terms` are extra
 * words the user always wants hidden (matched without case).
 */
function findInText(text, { terms = [] } = {}) {
  const found = [];
  const add = (kind, start, end) => {
    if (end <= start) return;
    if (found.some((f) => start < f.end && end > f.start)) return; // first rule wins
    found.push({ kind, start, end, text: text.slice(start, end) });
  };
  const each = (pattern, fn) => { for (const m of text.matchAll(pattern)) fn(m); };

  for (const pattern of TOKEN_PREFIXES) each(pattern, (m) => add('secret', m.index, m.index + m[0].length));
  // A user name and password in a link, or a token in its query string.
  each(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi, (m) => add('url', m.index, m.index + m[0].length));
  each(/(?:access_token|token|api_?key|signature|password|secret|session)=[^&#\s]{6,}/gi,
    (m) => add('url', m.index, m.index + m[0].length));
  each(/[?&#](?:key|sig|code|auth)=[^&#\s]{6,}/gi, (m) => add('url', m.index + 1, m.index + m[0].length));
  each(LABELLED, (m) => {
    const label = m[1].toLowerCase();
    const start = m.index + m[0].length - m[2].length;
    add(/^ssn|social/.test(label) ? 'ssn' : 'secret', start, m.index + m[0].length);
  });
  each(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi, (m) => add('email', m.index, m.index + m[0].length));
  // Text recognition sometimes drops the first dash.
  each(/\b\d{3}-?\d{2}-\d{4}\b/g, (m) => add('ssn', m.index, m.index + m[0].length));
  each(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) add('card', m.index, m.index + m[0].length);
  });
  each(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d|\.\d)/g,
    (m) => add('ip', m.index, m.index + m[0].length));
  // Phone numbers need separators or a leading +, so plain long numbers don't match.
  each(/(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?!\w)/g,
    (m) => add('phone', m.index, m.index + m[0].length));
  for (const term of terms.map((t) => String(t || '').trim()).filter((t) => t.length >= 2)) {
    each(new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, 'gi'), (m) => add('custom', m.index, m.index + m[0].length));
  }
  each(/\S{24,}/g, (m) => { if (looksLikeKey(m[0].replace(/[.,;:)]+$/, ''))) add('secret', m.index, m.index + m[0].length); });
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Private details in recognized text lines. `lines` are
 * [{ words: [{ text, bbox: { x0, y0, x1, y1 } }] }] in image pixels; each
 * finding gets the box around the words it covers.
 */
function findInLines(lines, options = {}) {
  const findings = [];
  for (const line of lines || []) {
    const words = (line.words || []).filter((w) => w && typeof w.text === 'string' && w.text.trim() && w.bbox);
    if (!words.length) continue;
    let text = '';
    const spans = words.map((word) => {
      const start = text.length;
      text += word.text.trim();
      const span = { start, end: text.length, bbox: word.bbox };
      text += ' ';
      return span;
    });
    for (const match of findInText(text, options)) {
      const covered = spans.filter((s) => s.start < match.end && s.end > match.start);
      if (!covered.length) continue;
      // Within one word (e.g. "Password:hunter2"), take only the matching part of its width.
      let x0 = Math.min(...covered.map((s) => s.bbox.x0));
      let x1 = Math.max(...covered.map((s) => s.bbox.x1));
      const first = covered[0];
      const last = covered[covered.length - 1];
      const fraction = (s, at) => (at - s.start) / Math.max(1, s.end - s.start);
      if (match.start > first.start) x0 = first.bbox.x0 + (first.bbox.x1 - first.bbox.x0) * fraction(first, match.start);
      if (match.end < last.end) x1 = last.bbox.x0 + (last.bbox.x1 - last.bbox.x0) * fraction(last, match.end);
      const y0 = Math.min(...covered.map((s) => s.bbox.y0));
      const y1 = Math.max(...covered.map((s) => s.bbox.y1));
      findings.push({ kind: match.kind, text: match.text, box: { x0, y0, x1, y1 } });
    }
  }
  return findings;
}

/** A stable key for a finding, so "not private" can be remembered without storing the text. */
function findingKey(kind, text) {
  const clean = String(text).toLowerCase().replace(/\s+/g, '');
  return `${kind}:${crypto.createHash('sha256').update(clean).digest('hex').slice(0, 16)}`;
}

/** Text safe to show in a review list: enough to recognize it, not enough to leak it. */
function maskText(kind, text) {
  const value = String(text).trim();
  if (kind === 'email') {
    const [user, domain = ''] = value.split('@');
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  if (kind === 'card' || kind === 'phone' || kind === 'ssn') {
    const digits = value.replace(/\D/g, '');
    return `•••${digits.slice(-2)}`;
  }
  if (kind === 'ip') return value.replace(/\.\d+$/, '.•••');
  if (kind === 'custom') return value;
  return `${value.slice(0, 3)}•••`;
}

/**
 * A blur annotation for a finding, in the step's 0–1 image coordinates.
 * The box is padded a little, and the blur is strong enough to flatten the
 * text rather than just soften it.
 */
function blurFor(finding, size) {
  const padX = (finding.box.y1 - finding.box.y0) * 0.35;
  const padY = (finding.box.y1 - finding.box.y0) * 0.3;
  const x0 = Math.max(0, finding.box.x0 - padX);
  const y0 = Math.max(0, finding.box.y0 - padY);
  const x1 = Math.min(size.width, finding.box.x1 + padX);
  const y1 = Math.min(size.height, finding.box.y1 + padY);
  return {
    type: 'blur',
    x: x0 / size.width,
    y: y0 / size.height,
    w: Math.max(1, x1 - x0) / size.width,
    h: Math.max(1, y1 - y0) / size.height,
    radius: Math.min(40, Math.max(10, Math.round((y1 - y0) * 0.9))),
    redact: { kind: finding.kind, key: findingKey(finding.kind, finding.text) },
  };
}

// How much of box `a` lies inside box `b` (both in 0–1 coordinates).
function coverage(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1e-9, a.w * a.h) : 0;
}

/**
 * The blurs to add to a step for `findings`: skips anything the user said
 * isn't private and anything an existing blur already hides.
 */
function newBlurs(step, findings, size) {
  const dismissed = new Set(step.redaction?.dismissed || []);
  const blurs = [];
  const existing = (step.annotations || []).filter((a) => a.type === 'blur');
  for (const finding of findings) {
    const blur = blurFor(finding, size);
    if (dismissed.has(blur.redact.key)) continue;
    if ([...existing, ...blurs].some((b) => coverage(blur, b) >= 0.8)) continue;
    blurs.push(blur);
  }
  return blurs;
}

/** Private details in a step's title and description. */
function findInStepText(step, options = {}) {
  const found = [];
  const description = String(step.descriptionHtml || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const dismissed = new Set(step.redaction?.dismissed || []);
  for (const [field, text] of [['title', step.title || ''], ['description', description]]) {
    for (const match of findInText(text, options)) {
      const key = findingKey(match.kind, match.text);
      if (!dismissed.has(key)) found.push({ field, kind: match.kind, text: match.text, key });
    }
  }
  return found;
}

/** Replace private details in a step's title and description with "[hidden]". */
function hideInStepText(step, options = {}) {
  const hide = (text) => {
    const matches = findInText(text, options);
    let out = text;
    for (const m of matches.reverse()) out = `${out.slice(0, m.start)}[hidden]${out.slice(m.end)}`;
    return out;
  };
  // Only text between tags is changed, so the description's formatting stays.
  const wrapped = `>${String(step.descriptionHtml || '')}<`.replace(/>([^<]+)</g, (all, inner) => `>${hide(inner)}<`);
  return { title: hide(step.title || ''), descriptionHtml: wrapped.slice(1, -1) };
}

module.exports = {
  RULES_VERSION, KINDS, findInText, findInLines, findingKey, maskText, blurFor, newBlurs, coverage,
  findInStepText, hideInStepText, luhn, looksLikeKey,
};
