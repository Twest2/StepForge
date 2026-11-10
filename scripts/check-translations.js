#!/usr/bin/env node
'use strict';

// Lists interface text that a translation in core/locales/ doesn't have yet,
// and translations whose {placeholders} differ from the English text.
// Untranslated text shows in English, so this is a to-do list, not a failure.
//
//   npm run translations           # every language
//   npm run translations -- fr     # one language
//   npm run translations -- --same # also list translations identical to the English
//                                  # (often right: "Description", "Logo", "OK")
//
// It finds text in t('…') and tn(count, '…', '…') calls with plain string
// literals, and in index.html's data-i18n-* attributes. Text built at run
// time can't be found, so keep each message one literal.

const fs = require('node:fs');
const path = require('node:path');
const { LANGUAGES } = require('../core/i18n');
const LOCALES = require('../core/locales');

const ROOT = path.resolve(__dirname, '..');
/** Every .js file under `dir`, as paths from the repository root. */
const jsFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = `${dir}/${entry.name}`;
  if (entry.isDirectory()) return entry.name === 'locales' ? [] : jsFiles(rel);
  return entry.name.endsWith('.js') ? [rel] : [];
});
// The interface (renderer and main process), the main-process modules' messages
// (core/ui-text.js) and the text StepForge writes into exported guides (core/export-text.js).
const SOURCES = [...jsFiles('app'), ...jsFiles('core'), ...jsFiles('exporters')];

const LITERAL = String.raw`'((?:[^'\\\n]|\\.)*)'`;
const CALLS = [
  { re: new RegExp(String.raw`(?<![\w.])t\(\s*${LITERAL}`, 'g'), plural: false },
  { re: new RegExp(String.raw`(?<![\w.])tn\([^,]+,\s*${LITERAL},\s*${LITERAL}`, 'g'), plural: true },
  // tc('context', 'text'): the catalog key is "context|text".
  { re: new RegExp(String.raw`(?<![\w.])tc\(\s*${LITERAL},\s*${LITERAL}`, 'g'), plural: false, context: true },
];

// Format names that stay as they are in every language.
const EXPORT_NAMES = new Set(['Markdown', 'Wiki.js', 'Confluence', 'GitHub Markdown', 'GitHub', 'MkDocs', 'Docusaurus', 'JSON', 'PDF', 'GIF', 'DOCX', 'PPTX', 'px']);

const unescape = (text) => text.replace(/\\(.)/g, (whole, ch) => (ch === 'n' ? '\n' : ch));
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** Map of English text → { plural, singular?, where }. */
function findMessages() {
  const found = new Map();
  for (const file of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const { re, plural, context } of CALLS) {
      for (const match of source.matchAll(re)) {
        const line = source.slice(0, match.index).split('\n').length;
        const key = context ? `${unescape(match[1])}|${unescape(match[2])}` : unescape(plural ? match[2] : match[1]);
        if (!found.has(key)) found.set(key, { plural, singular: plural ? unescape(match[1]) : null, where: `${file}:${line}` });
      }
    }
  }
  // The Export dialog's format names, descriptions and option text, which
  // app/main.js translates when it sends them (export:formats).
  const { FORMAT_INFO } = require('../exporters');
  const { FORMAT_LABELS } = require('../core/templates');
  const exportText = [...Object.values(FORMAT_LABELS)];
  for (const info of Object.values(FORMAT_INFO)) {
    exportText.push(info.description);
    for (const option of Object.values(info.options || {})) {
      exportText.push(option.label, option.hint, option.unit, option.group);
      for (const choice of option.choices || []) exportText.push(choice.label);
    }
  }
  for (const text of exportText) {
    // Leave out names and units that read the same in every language (PDF, px).
    if (text && /[A-Za-z]/.test(text) && !EXPORT_NAMES.has(text) && !found.has(text)) found.set(text, { plural: false, where: 'exporters (Export dialog)' });
  }
  // Titles StepForge gives new captures ("Click {target}", "Undo").
  for (const text of require('../core/text-intel').CAPTURE_TITLE_TEXTS) {
    if (!found.has(text)) found.set(text, { plural: false, where: 'core/text-intel.js (capture titles)' });
  }
  const html = fs.readFileSync(path.join(ROOT, 'app/renderer/index.html'), 'utf8');
  for (const match of html.matchAll(/(title|placeholder|aria-label)="([^"]+)"([^>]*?)data-i18n-(title|placeholder|label)/g)) {
    found.set(match[2], { plural: false, where: 'app/renderer/index.html' });
  }
  return found;
}

function check(codes, { same = false } = {}) {
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
    const identical = same ? [...messages].filter(([key, info]) => {
      const value = catalog[key];
      const forms = value && typeof value === 'object' ? Object.values(value) : [value];
      return forms.some((form) => form === key || (info.plural && form === info.singular));
    }).map(([key]) => key) : [];
    problems += missing.length + wrong.length;
    console.log(`${code}: ${messages.size - missing.length} of ${messages.size} translated`);
    for (const line of missing) console.log(`  missing  ${line}`);
    for (const line of wrong) console.log(`  check    ${line}`);
    for (const key of unused) console.log(`  unused   ${key}`);
    for (const key of identical) console.log(`  same     ${key}`);
  }
  return problems;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const asked = args.filter((arg) => !arg.startsWith('--'));
  const codes = asked.length ? asked : LANGUAGES.map((l) => l.code).filter((code) => code !== 'en');
  process.exitCode = check(codes, { same: args.includes('--same') }) ? 1 : 0;
}

module.exports = { findMessages };
