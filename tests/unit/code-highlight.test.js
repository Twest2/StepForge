'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  CODE_THEME_CHOICES, DEFAULT_CODE_STYLE, resolveCodeStyle, normalizeLanguage, markdownFenceLanguage, highlightCode,
} = require('../../core/code-highlight');
const { CODE_THEMES, BRACKET_COLORS } = require('../../core/code-themes');
const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { exportPdf } = require('../../exporters/pdf');
const { exportDocx } = require('../../exporters/docx');
const { exportHtmlSimple, exportHtmlRich } = require('../../exporters/html');
const { exportConfluence } = require('../../exporters/confluence');
const { exportMarkdown } = require('../../exporters/markdown');
const { unzipSync } = require('../../core/zip');
const { makeTmpDir, rmrf } = require('./helpers');

const TK = 'import tkinter as tk\ntk.Tk()';
const ATOM = CODE_THEMES['atom-one-dark'];

/** Every run as "text=color" (plus /i, /b), lines joined by " | ". */
function describe(hl) {
  return hl.lines.map((line) => line.map((r) => `${r.text}=${r.color}${r.italic ? '/i' : ''}${r.bold ? '/b' : ''}`).join(' ')).join(' | ');
}

/** The color of the first run whose text is exactly `text`. */
function colorOf(hl, text) {
  for (const line of hl.lines) for (const run of line) if (run.text === text) return run.color;
  return undefined;
}

test('Atom One Dark: import/as purple, Tk() a blue call, () yellow brackets', () => {
  const hl = highlightCode(TK, 'python', { theme: 'atom-one-dark' });
  assert.equal(hl.background, '#282c34');
  assert.equal(hl.foreground, '#abb2bf');
  assert.equal(describe(hl),
    'import=#c678dd  tkinter =#abb2bf as=#c678dd  tk=#abb2bf | tk.=#abb2bf Tk=#61aeee ()=#ffd700');
});

test('bracket colors cycle by depth and skip brackets inside strings and comments', () => {
  const hl = highlightCode('f(g(h[1]), "(")  # )', 'python', { theme: 'atom-one-dark' });
  const [dark1, dark2, dark3] = BRACKET_COLORS.dark;
  const runs = hl.lines[0];
  const brackets = runs.filter((r) => /^[()[\]]+$/.test(r.text)).map((r) => `${r.text}${r.color}`);
  assert.deepEqual(brackets, [`(${dark1}`, `(${dark2}`, `[${dark3}`, `]${dark3}`, `)${dark2}`, `)${dark1}`]);
  assert.equal(colorOf(hl, '"("'), '#98c379', 'the ( inside a string keeps the string color');
  const comment = runs[runs.length - 1];
  assert.equal(comment.text, '# )');
  assert.equal(comment.italic, true);
});

test('bracket colors use the light set on light themes', () => {
  const light = highlightCode('f(x)', 'js', { theme: 'atom-one-light' });
  assert.equal(describe(light), `f=#4078f2 (=${BRACKET_COLORS.light[0]} x=#383a42 )=${BRACKET_COLORS.light[0]}`);
});

test('an unmatched closing bracket keeps the token color', () => {
  const hl = highlightCode('a)', 'python', { theme: 'atom-one-dark' });
  assert.equal(describe(hl), 'a)=#abb2bf');
});

test('theme rules apply like CSS: more specific wins, descendants match, unstyled tokens inherit', () => {
  // .hljs-title.class_ (#e6c07b) beats .hljs-title (#61aeee).
  const cls = highlightCode('class Foo:\n  pass', 'python', { theme: 'atom-one-dark' });
  assert.equal(colorOf(cls, 'Foo'), '#e6c07b');
  // GitHub: .hljs-meta .hljs-string is its own color.
  const meta = highlightCode('#include "x.h"', 'c', { theme: 'github-light' });
  assert.equal(colorOf(meta, '"x.h"'), '#032f62');
  // Nord colors CSS keywords through a .language-css ancestor rule.
  const nord = highlightCode('@media screen {}', 'css', { theme: 'nord' });
  assert.equal(colorOf(nord, '@media'), '#d08770');
});

test('Plain returns null; unknown or empty languages get the theme colors and no bracket colors', () => {
  assert.equal(highlightCode(TK, 'python', { theme: 'plain' }), null);
  for (const language of ['', 'not-a-language', undefined]) {
    const hl = highlightCode('import x\nf(y)', language, { theme: 'atom-one-dark' });
    assert.equal(describe(hl), 'import x=#abb2bf | f(y)=#abb2bf');
  }
});

test('code text: CRLF is normalized and blank lines survive', () => {
  const hl = highlightCode('a = 1\r\n\r\nb = 2', 'python', DEFAULT_CODE_STYLE);
  assert.equal(hl.lines.length, 3);
  assert.deepEqual(hl.lines[1], []);
});

test('language names: aliases, versions, spacing and case', () => {
  const cases = { Python: 'python', py: 'python', python3: 'python', 'Python 3': 'python', 'C#': 'csharp', 'c++': 'cpp',
    sh: 'bash', JS: 'javascript', PowerShell: 'powershell', HTML: 'xml', cron: null, '': null };
  for (const [typed, id] of Object.entries(cases)) assert.equal(normalizeLanguage(typed), id, typed);
  // Markdown keeps a known tag as typed (lowercased) and fixes the rest.
  assert.equal(markdownFenceLanguage('Python 3'), 'python');
  assert.equal(markdownFenceLanguage('HTML'), 'html');
  assert.equal(markdownFenceLanguage('py'), 'py');
  assert.equal(markdownFenceLanguage('cron'), 'cron');
  assert.equal(markdownFenceLanguage(''), '');
});

test('resolveCodeStyle: a named theme or Plain sticks; anything else is Atom One Dark', () => {
  assert.deepEqual(resolveCodeStyle('dracula'), { theme: 'dracula' });
  assert.deepEqual(resolveCodeStyle('atom-one-light'), { theme: 'atom-one-light' });
  assert.deepEqual(resolveCodeStyle('plain'), { theme: 'plain' });
  for (const junk of ['match-app', 'nope', undefined, null]) assert.deepEqual(resolveCodeStyle(junk), { theme: 'atom-one-dark' });
  assert.deepEqual(resolveCodeStyle(), DEFAULT_CODE_STYLE);
});

test('themes: eight of them, each with valid colors and a dark flag that matches its background', () => {
  assert.equal(Object.keys(CODE_THEMES).length, 8);
  const hex = /^#[0-9a-f]{6}$/;
  for (const [id, theme] of Object.entries(CODE_THEMES)) {
    assert.match(theme.background, hex, id);
    assert.match(theme.foreground, hex, id);
    for (const [selector, color] of theme.rules) assert.ok(color === null || hex.test(color), `${id} ${selector}`);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.background.slice(i, i + 2), 16));
    assert.equal(theme.dark, 0.299 * r + 0.587 * g + 0.114 * b < 128, `${id} dark flag`);
  }
});

test('the settings dialog offers exactly the code themes core knows', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8');
  const block = src.match(/const CODE_THEME_CHOICES = \[([\s\S]*?)\];/)[1];
  const offered = [...block.matchAll(/value: '([^']+)', label: '([^']+)'/g)].map((m) => ({ value: m[1], label: m[2] }));
  assert.deepEqual(offered, CODE_THEME_CHOICES);
});

// --- exporters -------------------------------------------------------------

function codeGuide(t, code = TK, language = 'Python') {
  const root = makeTmpDir('codehl');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Code guide' });
  const step = store.addStep(guide.guideId, { kind: 'empty', title: 'Run it' });
  const saved = store.getStep(guide.guideId, step.stepId);
  saved.codeBlocks = [{ id: 'c1', order: 0, language, code }];
  store.saveStep(guide.guideId, saved);
  const ast = (codeStyle) => buildRenderAst(store, guide.guideId, codeStyle ? { codeStyle } : {});
  return { root, ast, out: (name) => path.join(root, name) };
}

function pdfPages(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  const pages = [];
  const re = /\d+ 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    pages.push(zlib.inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1'));
  }
  return { text, pages };
}

test('render AST carries the code style, defaulting to Atom One Dark', (t) => {
  const { ast } = codeGuide(t);
  assert.deepEqual(ast().codeStyle, DEFAULT_CODE_STYLE);
  assert.deepEqual(ast({ theme: 'nord' }).codeStyle, { theme: 'nord' });
});

test('PDF: themed background and colored runs; Plain keeps the gray box', (t) => {
  const { ast, out } = codeGuide(t);
  const opts = { includeCover: false, includeToc: false };
  const { pages, text } = pdfPages(exportPdf(ast(), out('themed'), opts).file);
  const page = pages.join('\n');
  assert.ok(page.includes('0.157 0.173 0.204 rg'), 'Atom One Dark background #282c34');
  assert.ok(/0\.776 0\.471 0\.867 rg \(import\) Tj/.test(page), 'import in #c678dd');
  assert.ok(/0\.380 0\.682 0\.933 rg \(Tk\) Tj/.test(page), 'Tk in #61aeee');
  assert.ok(/1\.000 0\.843 0\.000 rg \(\\\(\\\)\) Tj/.test(page), '() in #ffd700');
  assert.ok(text.includes('/BaseFont /Courier-Oblique'));

  const plain = pdfPages(exportPdf(ast({ theme: 'plain' }), out('plain'), opts).file).pages.join('\n');
  assert.ok(plain.includes('0.953 0.957 0.965 rg'), 'Plain keeps #f3f4f6');
  assert.ok(!plain.includes('0.157 0.173 0.204 rg'));
});

test('PDF: long code lines wrap instead of being cut off', (t) => {
  const long = `x = ${Array.from({ length: 40 }, (_, i) => `item${i}`).join(' + ')}`;
  const { ast, out } = codeGuide(t, long);
  const page = pdfPages(exportPdf(ast(), out('o'), { includeCover: false, includeToc: false }).file).pages.join('\n');
  const shown = [...page.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)].map((m) => m[1]).join('');
  for (let i = 0; i < 40; i++) assert.ok(shown.includes(`item${i}`), `item${i} is drawn`);
});

test('PDF: a code block that continues onto the next page repaints its background there', (t) => {
  const code = Array.from({ length: 120 }, (_, i) => `print(${i})`).join('\n');
  const { ast, out } = codeGuide(t, code);
  const { pages } = pdfPages(exportPdf(ast(), out('o'), { includeCover: false, includeToc: false }).file);
  const codePages = pages.filter((p) => p.includes('(print) Tj'));
  assert.ok(codePages.length >= 2, 'the block spans pages');
  for (const p of codePages) assert.ok(p.includes('0.157 0.173 0.204 rg'), 'each page has the dark background');
});

test('HTML: themed <pre> with inline colors; Plain keeps the page code style', (t) => {
  const { ast, out } = codeGuide(t);
  for (const exporter of [exportHtmlSimple, exportHtmlRich]) {
    const html = fs.readFileSync(exporter(ast(), out(exporter.name)).file, 'utf8');
    assert.ok(html.includes('<pre class="code themed" style="background:#282c34;color:#abb2bf"><code>'));
    assert.ok(html.includes('<span style="color:#c678dd">import</span>'));
    assert.ok(html.includes('<span style="color:#61aeee">Tk</span><span style="color:#ffd700">()</span>'));
  }
  const plain = fs.readFileSync(exportHtmlSimple(ast({ theme: 'plain' }), out('plain')).file, 'utf8');
  assert.ok(plain.includes('<pre class="code"><code>import tkinter as tk\ntk.Tk()</code></pre>'));
});

const documentXml = (file) => unzipSync(fs.readFileSync(file)).find((e) => e.name === 'word/document.xml').data.toString('utf8');

test('DOCX and Confluence Word: colored runs on a theme-shaded paragraph', (t) => {
  const { ast, out } = codeGuide(t);
  const docx = documentXml(exportDocx(ast(), out('docx')).file);
  const confluence = documentXml(exportConfluence(ast(), out('conf')).file);
  for (const [name, xml] of [['docx', docx], ['confluence', confluence]]) {
    assert.ok(xml.includes('w:fill="282C34"'), `${name} background`);
    assert.ok(/<w:color w:val="C678DD"\/>(<w:sz w:val="\d+"\/>)?<\/w:rPr><w:t xml:space="preserve">import<\/w:t>/.test(xml), `${name} import`);
    assert.ok(xml.includes('<w:t xml:space="preserve">Tk</w:t>'), `${name} Tk run`);
  }
  const plain = documentXml(exportDocx(ast({ theme: 'plain' }), out('docx-plain')).file);
  assert.ok(plain.includes('w:fill="F3F4F6"'));
  assert.ok(!plain.includes('C678DD'));
});

test('Markdown: the fence names the language editors know', (t) => {
  const { ast, out } = codeGuide(t, TK, 'Python 3');
  const md = fs.readFileSync(exportMarkdown(ast(), out('md')).file, 'utf8');
  assert.ok(md.includes('```python\nimport tkinter as tk\ntk.Tk()\n```'));
});
