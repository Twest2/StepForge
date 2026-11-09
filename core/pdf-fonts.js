'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TrueTypeFont } = require('./ttf');

/**
 * Installed fonts for text the built-in fonts can't show: PDF text outside
 * WinAnsiEncoding, and annotation text outside the Lato atlas that is drawn
 * into screenshots (core/text-raster.js). Candidates are tried in order and
 * only loaded when an earlier one lacks a character, so a Western guide reads
 * no font files at all.
 */

// Windows font files as [regular, bold] pairs, grouped by script. Every file
// is optional: the first installed one with the glyph wins.
const WINDOWS_FONTS = {
  general: [['segoeui.ttf', 'segoeuib.ttf'], ['arial.ttf', 'arialbd.ttf'], ['tahoma.ttf', 'tahomabd.ttf']],
  zh: [['msyh.ttc', 'msyhbd.ttc'], ['msjh.ttc', 'msjhbd.ttc'], ['simsun.ttc', null], ['simhei.ttf', null]],
  ja: [['YuGothR.ttc', 'YuGothB.ttc'], ['meiryo.ttc', 'meiryob.ttc'], ['msgothic.ttc', null]],
  ko: [['malgun.ttf', 'malgunbd.ttf'], ['gulim.ttc', null]],
  other: [['LeelawUI.ttf', 'LeelaUIb.ttf'], ['Nirmala.ttc', null], ['Nirmala.ttf', 'NirmalaB.ttf'], ['seguisym.ttf', null]],
};

const loadFont = (face, options) => new TrueTypeFont(fs.readFileSync(face.file), face.index, options);

const HAN_ORDER = { zh: ['zh', 'ja', 'ko'], ja: ['ja', 'zh', 'ko'], ko: ['ko', 'zh', 'ja'] };

/**
 * Which East Asian fonts to prefer, from the text: Chinese, Japanese and
 * Korean share Han characters but draw them differently.
 */
function hanPreference(text) {
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(text)) return 'ko';
  return 'zh';
}

function windowsCandidates(env, prefer) {
  const dirs = [
    path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'),
  ].filter(Boolean);
  const groups = ['general', ...HAN_ORDER[prefer], 'other'];
  const resolve = (name) => {
    if (!name) return null;
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file, index: 0 };
    }
    return null;
  };
  return groups.flatMap((group) => WINDOWS_FONTS[group])
    .map(([regular, bold]) => ({ regular: resolve(regular), bold: resolve(bold) }))
    .filter((pair) => pair.regular || pair.bold);
}

const FC_LANG = { zh: 'zh-cn', ja: 'ja', ko: 'ko' };

/**
 * fontconfig's fallback list for a pattern, best match first: TrueType faces,
 * plus CFF ones when `cff` (they can be drawn but not embedded in a PDF).
 */
function fcMatch(pattern, run, cff) {
  try {
    const out = run('fc-match', ['-s', '-f', '%{file}\t%{index}\t%{fontformat}\n', pattern], { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map((line) => line.split('\t'))
      .filter(([file, , format]) => file && (format === 'TrueType' || (cff && format === 'CFF')))
      .map(([file, index]) => ({ file, index: Number(index) || 0 }));
  } catch {
    return [];
  }
}

function linuxCandidates(prefer, run, cff) {
  // Western sans first (Latin, Cyrillic, Greek), then fonts for the guide's
  // East Asian language. fc-match -s lists every installed font, so keep the
  // first few dozen: past that a font rarely adds coverage.
  const seen = new Set();
  const unique = (list) => list.filter(({ file, index }) => !seen.has(`${file}#${index}`) && seen.add(`${file}#${index}`));
  const regular = unique([...fcMatch('sans-serif', run, cff).slice(0, 4), ...fcMatch(`sans-serif:lang=${FC_LANG[prefer]}`, run, cff)]).slice(0, 40);
  seen.clear();
  const bold = unique([...fcMatch('sans-serif:weight=bold', run, cff).slice(0, 4), ...fcMatch(`sans-serif:weight=bold:lang=${FC_LANG[prefer]}`, run, cff)]).slice(0, 40);
  return [...regular.map((face) => ({ regular: face, bold: null })), ...bold.map((face) => ({ regular: null, bold: face }))];
}

/**
 * Installed fonts to try, in order, as { regular, bold } face pairs. `cff`
 * also lists CFF-outline fonts (most Linux CJK fonts), for drawing only.
 */
function systemFontCandidates({ text = '', platform = process.platform, env = process.env, run = execFileSync, cff = false } = {}) {
  const prefer = hanPreference(text);
  if (platform === 'win32') return windowsCandidates(env, prefer);
  if (platform === 'linux') return linuxCandidates(prefer, run, cff);
  return [];
}

/**
 * Finds a font for each character. `fontFor(codePoint, bold)` returns
 * { font, glyph } or null when no installed font has the character.
 * `candidates` is a list of { regular, bold } faces, or a function returning
 * one, called only when the first such character turns up.
 */
class FallbackFonts {
  constructor(candidates, { load = loadFont } = {}) {
    this.pending = typeof candidates === 'function' ? candidates : null;
    this.candidates = this.pending ? [] : candidates;
    this.load = load;
    this.fonts = new Map(); // "file#index" -> TrueTypeFont, or null when unusable
    this.cache = new Map();
  }

  face(face) {
    if (!face) return null;
    const key = `${face.file}#${face.index}`;
    if (!this.fonts.has(key)) {
      let font = null;
      try { font = this.load(face); } catch { font = null; } // unreadable, CFF or damaged
      this.fonts.set(key, font);
    }
    return this.fonts.get(key);
  }

  fontFor(codePoint, bold = false) {
    const key = `${codePoint}${bold ? 'b' : ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending) { this.candidates = this.pending(); this.pending = null; }
    // Faces of the asked-for weight first; the other weight beats a "?".
    const regular = this.candidates.map((pair) => pair.regular);
    const heavy = this.candidates.map((pair) => pair.bold);
    let found = null;
    for (const face of bold ? [...heavy, ...regular] : [...regular, ...heavy]) {
      const font = this.face(face);
      const glyph = font ? font.glyphFor(codePoint) : 0;
      if (glyph) { found = { font, glyph }; break; }
    }
    this.cache.set(key, found);
    return found;
  }
}

module.exports = { FallbackFonts, systemFontCandidates, hanPreference, loadFont };
