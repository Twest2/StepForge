#!/usr/bin/env node
'use strict';

// Lists interface text that a translation in core/locales/ doesn't have yet,
// and translations whose {placeholders} differ from the English text.
// Untranslated text shows in English, so this is a to-do list, not a failure.
//
//   npm run translations           # every language
//   npm run translations -- fr     # one language
//
// It finds text in t('…') and tn(count, '…', '…') calls with plain string
// literals, and in index.html's data-i18n-* attributes. Text built at run
// time can't be found, so keep each message one literal.

const fs = require('node:fs');
const path = require('node:path');
const { LANGUAGES } = require('../core/i18n');
const LOCALES = require('../core/locales');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = ['app/main.js', ...fs.readdirSync(path.join(ROOT, 'app/renderer'))
  .filter((name) => name.endsWith('.js')).map((name) => `app/renderer/${name}`)];

const LITERAL = String.raw`'((?:[^'\\\n]|\\.)*)'`;
const CALLS = [
  { re: new RegExp(String.raw`(?<![\w.])t\(\s*${LITERAL}`, 'g'), plural: false },
  { re: new RegExp(String.raw`(?<![\w.])tn\([^,]+,\s*${LITERAL},\s*${LITERAL}`, 'g'), plural: true },
];

const unescape = (text) => text.replace(/\\(.)/g, '$1');
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** Map of English text → { plural, singular?, where }. */
function findMessages() {
  const found = new Map();
  for (const file of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const { re, plural } of CALLS) {
      for (const match of source.matchAll(re)) {
        const line = source.slice(0, match.index).split('\n').length;
        const key = unescape(plural ? match[2] : match[1]);
        if (!found.has(key)) found.set(key, { plural, singular: plural ? unescape(match[1]) : null, where: `${file}:${line}` });
      }
    }
  }
  const html = fs.readFileSync(path.join(ROOT, 'app/renderer/index.html'), 'utf8');
  for (const match of html.matchAll(/(title|placeholder|aria-label)="([^"]+)"([^>]*?)data-i18n-(title|placeholder|label)/g)) {
    found.set(match[2], { plural: false, where: 'app/renderer/index.html' });
  }
  return found;
}

function check(codes) {
  const messages = findMessages();
  let problems = 0;
  for (const code of codes) {
    const catalog = LOCALES[code] || {};
    const missing = [];
    const wrong = [];
    for (const [key, info] of messages) {
      const value = catalog[key];
      if (value == null || value === '') { missing.push(`${info.where}  ${key}`); continue; }
      const forms = typeof value === 'object' ? Object.values(value) : [value];
      if (info.plural !== (typeof value === 'object')) wrong.push(`${key}  (${info.plural ? 'needs plural forms' : 'is not plural'})`);
      for (const form of forms) {
        const expected = placeholders(key);
        // A plural form may leave out {count}, as "one" forms often do.
        if (placeholders(form) !== expected && placeholders(form) !== expected.replace(/(^|,)count(,|$)/, '$1').replace(/^,|,$/, '')) {
          wrong.push(`${key}  (placeholders differ: ${form})`);
        }
      }
    }
    const unused = Object.keys(catalog).filter((key) => !messages.has(key));
    problems += missing.length + wrong.length;
    console.log(`${code}: ${messages.size - missing.length} of ${messages.size} translated`);
    for (const line of missing) console.log(`  missing  ${line}`);
    for (const line of wrong) console.log(`  check    ${line}`);
    for (const key of unused) console.log(`  unused   ${key}`);
  }
  return problems;
}

if (require.main === module) {
  const asked = process.argv.slice(2);
  const codes = asked.length ? asked : LANGUAGES.map((l) => l.code).filter((code) => code !== 'en');
  process.exitCode = check(codes) ? 1 : 0;
}

module.exports = { findMessages };
