'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
const { highlightCode } = require('../core/code-highlight');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { anchorFor, tocEntries, guideMetaLines } = require('./document-layout');
const { withBrand, imageDataUri, cssFontStack, textOn } = require('./branding');

/**
 * HTML exporters. Both variants are fully self-contained single files:
 * screenshots are embedded as data URIs, styles are inline, and there are
 * no external (network) references of any kind.
 *
 * - simple: a clean, printable document that is easy to share or paste.
 * - rich: an interactive checklist with a sticky contents sidebar, per-step
 *   "done" toggles persisted in the browser's localStorage (local only),
 *   and click-to-zoom screenshots.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  toc: true,
  accentColor: '#2563EB',
  customCss: '',
};

const OPTION_INFO = {
  includeImages: { label: 'Include screenshots' },
  toc: { label: 'Include contents' },
  accentColor: { label: 'Accent color', type: 'color' },
  customCss: { label: 'Custom CSS', type: 'textarea', hint: 'Appended after the built-in styles.' },
};

function dataUri(img) {
  return `data:image/png;base64,${encodePng(img).toString('base64')}`;
}

function stepLinkRewrite(html, ast) {
  // step:<id> hrefs become local anchors when the target step is exported.
  return String(html || '').replace(/href="step:([^"]+)"/g, (m, id) => {
    const target = ast.steps.find((s) => s.stepId === id);
    return target ? `href="#${anchorFor(target)}"` : 'data-missing-step-link="true"';
  });
}

function blockHtml(tb, ast) {
  const level = LEVEL_LABEL[tb.level] ? tb.level : 'info';
  const label = LEVEL_LABEL[level];
  const heading = tb.title ? escapeHtml(tb.title) : label;
  return `<aside class="callout callout-${level}" aria-label="${label}">`
    + `<div class="callout-title">${heading}</div>`
    + `${tb.descriptionHtml ? `<div class="callout-body">${stepLinkRewrite(tb.descriptionHtml, ast)}</div>` : ''}`
    + '</aside>';
}

function tableHtml(rows) {
  const [head, ...body] = rows;
  return '<div class="table-wrap"><table><thead><tr>'
    + head.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
    + '</tr></thead><tbody>'
    + body.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table></div>';
}

function metaLine(ast) {
  const count = ast.steps.length;
  const date = String(ast.generatedAt || '').slice(0, 10);
  return [
    `${count} step${count === 1 ? '' : 's'}`,
    ...guideMetaLines(ast),
    date && `Updated ${date}`,
  ].filter(Boolean).map((part) => `<span>${escapeHtml(part)}</span>`).join('');
}

/** The brand's banner, logo and header text, above the title. */
function brandHeader(brand) {
  if (!brand) return '';
  const parts = [];
  if (brand.banner) {
    parts.push(`<img class="brand-banner" src="${imageDataUri(brand.banner)}" alt=""${brand.banner.width ? ` width="${brand.banner.width}" height="${brand.banner.height}"` : ''}>`);
  }
  const logo = brand.logo
    ? `<img class="brand-logo" src="${imageDataUri(brand.logo)}" alt="Logo"${brand.logo.width ? ` width="${brand.logo.width}" height="${brand.logo.height}"` : ''}>`
    : '';
  const tagline = brand.header.text ? `<p class="brand-tagline">${escapeHtml(brand.header.text)}</p>` : '';
  if (logo || tagline) parts.push(`<div class="brand-bar">${logo}${tagline}</div>`);
  return parts.join('\n  ');
}

function renderHeader(ast) {
  const brand = ast.branding;
  return `
<header class="doc-header${brand ? ` cover-${brand.cover}` : ''}">
  ${brandHeader(brand)}
  <div class="rule"></div>
  <h1>${escapeHtml(ast.guide.title || 'Untitled guide')}</h1>
  ${ast.guide.descriptionHtml ? `<div class="lede">${stepLinkRewrite(ast.guide.descriptionHtml, ast)}</div>` : ''}
  <p class="meta">${metaLine(ast)}</p>
</header>`;
}

function renderTocItems(ast) {
  return tocEntries(ast).map((entry) => `
    <li class="d${entry.depth}">
      <a href="#${entry.anchor}"><span class="num">${escapeHtml(entry.number)}</span><span class="label">${escapeHtml(entry.title)}</span></a>
    </li>`).join('');
}

/** A code block in the chosen code theme, or the page's own code colors for Plain. */
function codeHtml(block, ast) {
  const text = codeBlockText(block);
  const hl = highlightCode(text, block.language, ast.codeStyle);
  if (!hl) return `<pre class="code"><code>${escapeHtml(text)}</code></pre>`;
  const lines = hl.lines.map((line) => line.map((run) => {
    const style = [run.color !== hl.foreground ? `color:${run.color}` : '', run.italic ? 'font-style:italic' : '', run.bold ? 'font-weight:bold' : '']
      .filter(Boolean).join(';');
    return style ? `<span style="${style}">${escapeHtml(run.text)}</span>` : escapeHtml(run.text);
  }).join(''));
  return `<pre class="code themed${hl.dark ? '' : ' light'}" style="background:${hl.background};color:${hl.foreground}"><code>${lines.join('\n')}</code></pre>`;
}

function renderStep(step, ast, images, tpl, { rich = false } = {}) {
  const groups = stepContentGroups(step);
  const blocks = (list) => list.map((tb) => blockHtml(tb, ast)).join('\n');
  const parts = [];
  parts.push(blocks(groups.beforeDescription));
  if (step.descriptionHtml) parts.push(`<div class="desc">${stepLinkRewrite(step.descriptionHtml, ast)}</div>`);
  parts.push(blocks(groups.afterDescription));
  parts.push(blocks(groups.beforeImage));
  const img = images.get(step.stepId);
  if (img && tpl.includeImages) {
    parts.push(`<figure class="shot"><img alt="${escapeHtml(step.altText)}" src="${dataUri(img)}" width="${img.width}" height="${img.height}"${rich ? ' tabindex="0"' : ''}></figure>`);
  }
  parts.push(blocks(groups.afterImage));
  for (const block of groups.rest) {
    if (block.kind === 'text') parts.push(blockHtml(block, ast));
    else if (block.kind === 'code') parts.push(codeHtml(block, ast));
    else if (block.kind === 'table' && block.rows && block.rows.length) parts.push(tableHtml(block.rows));
  }

  const toggle = rich
    ? `<label class="done-toggle" title="Mark step as done"><input type="checkbox" class="step-done" data-step="${escapeHtml(step.stepId)}"><span>Done</span></label>`
    : '';
  const skipped = step.skipped ? '<span class="pill">Skipped</span>' : '';
  return `
<section class="step depth-${Math.min(step.depth || 0, 3)}${step.skipped ? ' skipped' : ''}" id="${anchorFor(step)}">
  ${blocks(groups.beforeTitle)}
  <div class="step-head">
    <span class="step-num">${escapeHtml(step.number)}</span>
    <h2>${escapeHtml(step.title || 'Untitled step')}</h2>
    ${skipped}${toggle}
  </div>
  ${blocks(groups.afterTitle)}
  <div class="step-body">
    ${parts.filter(Boolean).join('\n    ')}
  </div>
</section>`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [37, 99, 235];
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rootStyle(tpl) {
  const [r, g, b] = hexToRgb(tpl.accentColor);
  return `--accent:rgb(${r},${g},${b});--accent-rgb:${r},${g},${b};`;
}

function footer(ast) {
  const date = escapeHtml(String(ast.generatedAt || '').slice(0, 10));
  const text = ast.branding?.footer.text;
  return `<footer class="doc-footer">${text ? `${escapeHtml(text)} · ${date}` : `Made with StepForge · ${date}`}</footer>`;
}

const BASE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --soft: #f6f8fa;
  --text: #18212b;
  --muted: #5b6776;
  --border: #e1e6ec;
  --code-bg: #0f172a;
  --code-fg: #e2e8f0;
  --info: var(--accent); --info-bg: rgba(var(--accent-rgb), .07);
  --success: #0f8a5f; --success-bg: #ecf8f2;
  --warn: #b45309; --warn-bg: #fff8eb;
  --error: #c2362f; --error-bg: #fdf1f0;
  --link: var(--accent);
  --font-body: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  --font-heading: var(--font-body);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.65 var(--font-body);
}
h1, h2, h3, h4 { font-family: var(--font-heading); }
a { color: var(--link); text-underline-offset: 2px; }
.page { max-width: 880px; margin: 0 auto; padding: 56px 24px 48px; }
.doc-header { margin-bottom: 36px; }
.doc-header .rule { width: 56px; height: 4px; border-radius: 4px; background: var(--accent); margin-bottom: 20px; }
.doc-header h1 { font-size: clamp(1.9rem, 4vw, 2.6rem); line-height: 1.15; letter-spacing: -.02em; margin: 0 0 12px; }
.doc-header .lede { color: var(--muted); font-size: 1.08rem; max-width: 68ch; }
.doc-header .lede > :first-child { margin-top: 0; }
.doc-header .meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 14px 0 0; color: var(--muted); font-size: .88rem; }
.contents { border: 1px solid var(--border); border-radius: 10px; padding: 18px 22px; margin-bottom: 40px; background: var(--soft); }
.contents h2, .toc h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 10px; }
.toc-list { list-style: none; margin: 0; padding: 0; }
.toc-list a { display: flex; gap: 10px; padding: 4px 0; color: var(--text); text-decoration: none; }
.toc-list a:hover .label { color: var(--accent); }
.toc-list .num { min-width: 2.2em; color: var(--muted); font-variant-numeric: tabular-nums; }
.toc-list .d1 a { padding-left: 1.4em; } .toc-list .d2 a { padding-left: 2.8em; } .toc-list .d3 a { padding-left: 4.2em; }
.step { padding: 28px 0 8px; border-top: 1px solid var(--border); scroll-margin-top: 16px; }
.step.depth-1, .step.depth-2, .step.depth-3 { margin-left: 44px; border-top-style: dashed; }
.step-head { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; }
.step-head h2 { flex: 1; min-width: 0; font-size: 1.3rem; line-height: 1.3; margin: 0; letter-spacing: -.01em; }
.step-num {
  flex: none; display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 8px;
  border-radius: 999px; background: var(--accent); color: var(--on-primary, #fff); font-size: .85rem; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.depth-1 .step-num, .depth-2 .step-num, .depth-3 .step-num { background: rgba(var(--accent-rgb), .12); color: var(--accent); }
.step-body { padding-left: 44px; }
.step.depth-1 .step-body, .step.depth-2 .step-body, .step.depth-3 .step-body { padding-left: 44px; }
.desc > :first-child { margin-top: 0; }
.shot { margin: 16px 0 20px; }
.shot img { display: block; max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 4px 16px rgba(16,24,40,.06); }
.callout { border-left: 3px solid var(--info); background: var(--info-bg); border-radius: 0 8px 8px 0; padding: 12px 16px; margin: 14px 0; }
.callout-title { font-weight: 650; color: var(--info); }
.callout-body > :first-child { margin-top: 4px; } .callout-body > :last-child { margin-bottom: 0; }
.callout-success { border-color: var(--success); background: var(--success-bg); } .callout-success .callout-title { color: var(--success); }
.callout-warn { border-color: var(--warn); background: var(--warn-bg); } .callout-warn .callout-title { color: var(--warn); }
.callout-error { border-color: var(--error); background: var(--error-bg); } .callout-error .callout-title { color: var(--error); }
.code-block { position: relative; margin: 1em 0; }
.code-block > pre.code { margin: 0; }
.copy-code { position: absolute; top: 8px; right: 8px; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  color: rgba(255,255,255,.85); background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18); border-radius: 6px;
  cursor: pointer; opacity: .75; transition: opacity .15s, background .15s; }
.code-block:hover .copy-code, .copy-code:focus-visible { opacity: 1; background: rgba(255,255,255,.16); }
.code-block.light .copy-code { color: rgba(0,0,0,.7); background: rgba(0,0,0,.04); border-color: rgba(0,0,0,.15); }
.code-block.light:hover .copy-code, .code-block.light .copy-code:focus-visible { background: rgba(0,0,0,.08); }
pre.code { background: var(--code-bg); color: var(--code-fg); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: .88rem; line-height: 1.55; }
code { font-family: ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
:not(pre) > code { background: var(--soft); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; font-size: .9em; }
.table-wrap { overflow-x: auto; margin: 14px 0; border: 1px solid var(--border); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: .94rem; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); }
th { background: var(--soft); font-weight: 650; }
tbody tr:last-child td { border-bottom: 0; }
.pill { font-size: .75rem; font-weight: 600; color: var(--warn); background: var(--warn-bg); border-radius: 999px; padding: 2px 10px; }
.step.skipped h2, .step.skipped .step-body { opacity: .6; }
.doc-footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: .82rem; }
@media (max-width: 640px) {
  .page { padding: 32px 16px; }
  .step-body, .step.depth-1 .step-body, .step.depth-2 .step-body, .step.depth-3 .step-body { padding-left: 0; }
  .step.depth-1, .step.depth-2, .step.depth-3 { margin-left: 16px; }
}
@media print {
  body { font-size: 11pt; background: #fff; color: #000; }
  .page { max-width: none; padding: 0; }
  .contents, .toc, .done-toggle, .progress, .lightbox { display: none !important; }
  .step { break-inside: avoid-page; }
  .shot img { box-shadow: none; max-height: 85vh; width: auto; }
  .copy-code { display: none; }
  pre.code.themed { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: inherit; }
}
`;

// Readers in dark mode get dark colors, unless a brand profile keeps its guides light.
const DARK_CSS = `
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111418; --soft: #181c22; --text: #e6e9ee; --muted: #9aa4b1; --border: #2a313a;
    --code-bg: #0b0e12; --info-bg: rgba(var(--accent-rgb), .14);
    --success: #4cc79a; --success-bg: rgba(76,199,154,.12);
    --warn: #f0b458; --warn-bg: rgba(240,180,88,.12);
    --error: #f07b73; --error-bg: rgba(240,123,115,.12);
  }
}
`;

// Classes only a brand profile's header uses.
const BRAND_CSS = `
.brand-banner { display: block; width: 100%; height: auto; max-height: 240px; object-fit: cover; border-radius: 10px; margin-bottom: 24px; }
.brand-bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.brand-logo { display: block; width: auto; height: auto; max-width: 260px; max-height: 64px; }
.brand-tagline { margin: 0; color: var(--muted); font-size: .9rem; }
.doc-header.cover-band { background: var(--brand-primary); color: var(--on-primary); padding: 32px 32px 28px; border-radius: 12px; }
.doc-header.cover-band .rule { background: var(--on-primary); opacity: .7; }
.doc-header.cover-band .lede, .doc-header.cover-band .meta, .doc-header.cover-band .brand-tagline { color: var(--on-primary); opacity: .88; }
.doc-header.cover-band a { color: inherit; }
.doc-header.cover-centered { text-align: center; }
.doc-header.cover-centered .rule, .doc-header.cover-centered .brand-logo, .doc-header.cover-centered .lede { margin-left: auto; margin-right: auto; }
.doc-header.cover-centered .brand-bar { flex-direction: column; justify-content: center; }
.doc-header.cover-centered .meta { justify-content: center; }
@media print { .doc-header.cover-band { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;

/**
 * Keep author CSS inside its <style> element: "</style" would end the
 * element early and let the rest of the text run as page markup.
 */
function styleText(css) {
  return String(css || '').replace(/<\/(style)/gi, '<\\/$1');
}

/** The brand's colors, fonts and embedded font files, as CSS after the base styles. */
function brandCss(brand) {
  if (!brand) return DARK_CSS;
  const { primary, accent, text } = brand.colors;
  const faces = [];
  const declared = new Set();
  for (const role of ['heading', 'body']) {
    const { name, file } = brand.fonts[role];
    if (!name || !file || declared.has(name)) continue;
    declared.add(name);
    faces.push(`@font-face { font-family: "${name}"; src: url(data:${file.mime};base64,${file.data.toString('base64')}) format("${file.format}"); font-display: swap; }`);
  }
  const fonts = [
    brand.fonts.body.name ? `--font-body: ${cssFontStack(brand.fonts.body.name)};` : '',
    brand.fonts.heading.name ? `--font-heading: ${cssFontStack(brand.fonts.heading.name)};` : '',
  ].join(' ');
  const vars = `:root { --brand-primary: ${primary}; --brand-accent: ${accent}; --brand-text: ${text}; --on-primary: ${textOn(primary)}; --link: ${accent}; ${fonts} }`;
  // A light-only profile keeps its own text color; one that follows the
  // reader's dark mode uses it in light mode only.
  const scheme = brand.html.colorScheme === 'auto'
    ? `${DARK_CSS}@media (prefers-color-scheme: light) { :root { --text: ${text}; } }`
    : `:root { color-scheme: light; --text: ${text}; }`;
  return `\n${faces.join('\n')}\n${vars}\n${scheme}\n${BRAND_CSS}${styleText(brand.html.css)}\n`;
}

const RICH_CSS = `
.page.rich { max-width: 1180px; display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 56px; align-items: start; }
.toc { position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow: auto; padding-right: 4px; }
.toc-list a { border-radius: 6px; padding: 5px 8px; font-size: .92rem; line-height: 1.4; }
.toc-list a:hover { background: var(--soft); }
.toc-list a.active { background: rgba(var(--accent-rgb), .09); }
.toc-list a.active .label { color: var(--accent); font-weight: 600; }
.toc-list a.done .num { color: var(--success); }
.toc-list a.done .num::before { content: "✓ "; }
.progress { margin: 0 0 18px; }
.progress .label { display: flex; justify-content: space-between; font-size: .82rem; color: var(--muted); margin-bottom: 6px; }
.progress .bar { height: 6px; border-radius: 6px; background: var(--border); overflow: hidden; }
.progress .fill { height: 100%; width: 0; background: var(--success); transition: width .25s ease; }
.progress button { border: 0; background: none; color: var(--muted); font: inherit; font-size: .82rem; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.progress button:hover { color: var(--text); }
.done-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: var(--muted); cursor: pointer; user-select: none; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; }
.done-toggle input { accent-color: var(--success); margin: 0; }
.step.done .done-toggle { color: var(--success); border-color: var(--success); background: var(--success-bg); }
.step.done .step-num { background: var(--success); color: #fff; }
.shot img { cursor: zoom-in; }
.lightbox { position: fixed; inset: 0; z-index: 10; display: none; place-items: center; padding: 24px; background: rgba(10, 14, 20, .82); cursor: zoom-out; }
.lightbox.open { display: grid; }
.lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
@media (max-width: 960px) {
  .page.rich { display: block; }
  .toc { position: static; max-height: none; border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 32px; background: var(--soft); }
}
`;

// Adds a copy button (two overlapping squares, a check once copied) to each code block. Script-added, so a page opened
// with scripts off shows no button that can't work. Copies the code's plain
// text, never the colors.
const COPY_SCRIPT = `
(function () {
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    area.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }
  var SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICONS = {
    copy: SVG + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
      '<path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
    copied: SVG + '<path d="M3 8.5l3 3 7-7"/></svg>',
    failed: SVG + '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  };
  document.querySelectorAll('pre.code').forEach(function (pre) {
    var wrap = document.createElement('div');
    wrap.className = 'code-block' + (pre.classList.contains('light') ? ' light' : '');
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code';
    var timer;
    function show(icon, label) {
      button.innerHTML = ICONS[icon];
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    function flash(icon, label) {
      show(icon, label);
      clearTimeout(timer);
      timer = setTimeout(function () { show('copy', 'Copy code'); }, 1500);
    }
    show('copy', 'Copy code');
    button.addEventListener('click', function () {
      copyText(pre.querySelector('code').textContent).then(function () { flash('copied', 'Copied'); }, function () { flash('failed', 'Copy failed'); });
    });
    wrap.appendChild(button);
  });
})();
`;

const RICH_SCRIPT = `
(function () {
  var key = __KEY__;
  var state = {};
  try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
  var boxes = Array.prototype.slice.call(document.querySelectorAll('input.step-done'));
  var links = {};
  document.querySelectorAll('.toc-list a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
  function refresh() {
    var done = 0;
    boxes.forEach(function (b) {
      var section = b.closest('section');
      section.classList.toggle('done', b.checked);
      if (links[section.id]) links[section.id].classList.toggle('done', b.checked);
      if (b.checked) done++;
    });
    var fill = document.querySelector('.progress .fill');
    if (fill) fill.style.width = (boxes.length ? (100 * done / boxes.length) : 0) + '%';
    var label = document.querySelector('.progress .count');
    if (label) label.textContent = done + ' of ' + boxes.length + ' done';
  }
  boxes.forEach(function (b) {
    b.checked = !!state[b.dataset.step];
    b.addEventListener('change', function () {
      state[b.dataset.step] = b.checked;
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
      refresh();
    });
  });
  var reset = document.querySelector('.progress button');
  if (reset) reset.addEventListener('click', function () {
    state = {};
    boxes.forEach(function (b) { b.checked = false; });
    try { localStorage.removeItem(key); } catch (e) {}
    refresh();
  });
  refresh();

  // Highlight the step being read: the last one whose top has scrolled past
  // a line 30% down the window, or the last step once the page is scrolled
  // to the bottom. A step picked in Contents stays highlighted until the
  // reader scrolls by hand, because steps near the end of a page (or every
  // step of a short guide) can't scroll up far enough to reach the line.
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.step'));
  var picked = null;
  function setActive(id) {
    Object.keys(links).forEach(function (k) { links[k].classList.toggle('active', k === id); });
  }
  function spy() {
    if (picked) { setActive(picked); return; }
    if (!sections.length) return;
    var current = sections[0].id;
    var line = window.innerHeight * 0.3;
    sections.forEach(function (s) { if (s.getBoundingClientRect().top <= line) current = s.id; });
    var root = document.documentElement;
    if (window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) current = sections[sections.length - 1].id;
    setActive(current);
  }
  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; spy(); });
  }, { passive: true });
  window.addEventListener('resize', spy);
  function pick(id) { if (links[id]) { picked = id; spy(); } }
  Object.keys(links).forEach(function (id) { links[id].addEventListener('click', function () { pick(id); }); });
  window.addEventListener('hashchange', function () { pick(location.hash.slice(1)); });
  ['wheel', 'touchmove'].forEach(function (type) {
    window.addEventListener(type, function () { picked = null; }, { passive: true });
  });
  // Dragging the page's scrollbar.
  window.addEventListener('mousedown', function (e) {
    if (e.target === document.documentElement && e.clientX >= document.documentElement.clientWidth) picked = null;
  });
  window.addEventListener('keydown', function (e) {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(e.key) >= 0) picked = null;
  });
  if (location.hash) pick(location.hash.slice(1));
  spy();

  // Click a screenshot to view it full size.
  var box = document.querySelector('.lightbox');
  var big = box && box.querySelector('img');
  function close() { box.classList.remove('open'); big.removeAttribute('src'); }
  document.querySelectorAll('.shot img').forEach(function (img) {
    function open() { big.src = img.src; big.alt = img.alt; box.classList.add('open'); }
    img.addEventListener('click', open);
    img.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  if (box) box.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.classList.contains('open')) close(); });
})();
`;

function page(ast, tpl, css, body, script = '') {
  return `<!DOCTYPE html>
<html lang="en" style="${rootStyle(tpl)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="StepForge">
<title>${escapeHtml(ast.guide.title || 'Untitled guide')}</title>
<style>${css}${brandCss(ast.branding)}${styleText(tpl.customCss)}</style>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>
`;
}

function exportHtmlSimple(ast, outDir, template = {}) {
  const tpl = withBrand('html-simple', DEFAULT_TEMPLATE, ast, template);
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  const toc = tpl.toc && ast.steps.length > 1
    ? `<nav class="contents" aria-label="Contents"><h2>Contents</h2><ul class="toc-list">${renderTocItems(ast)}</ul></nav>`
    : '';
  const body = `<div class="page">
${renderHeader(ast)}
${toc}
<main>
${ast.steps.map((step) => renderStep(step, ast, images, tpl)).join('\n')}
</main>
${footer(ast)}
</div>`;
  const file = path.join(outDir, `${guideSlug(ast)}.html`);
  fs.writeFileSync(file, page(ast, tpl, BASE_CSS, body, body.includes('<pre class="code') ? COPY_SCRIPT : ''));
  return { file, imageCount: images.size };
}

function exportHtmlRich(ast, outDir, template = {}) {
  const tpl = withBrand('html-rich', DEFAULT_TEMPLATE, ast, template);
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  const storageKey = `stepforge-progress-${ast.guide.id}`;
  const progress = `<div class="progress">
    <div class="label"><span class="count"></span><button type="button">Reset</button></div>
    <div class="bar"><div class="fill"></div></div>
  </div>`;
  const toc = tpl.toc && ast.steps.length > 1
    ? `<nav class="toc" aria-label="Contents">${progress}<h2>Contents</h2><ul class="toc-list">${renderTocItems(ast)}</ul></nav>`
    : `<nav class="toc" aria-label="Progress">${progress}</nav>`;
  const body = `<div class="page rich">
${toc}
<div class="content">
${renderHeader(ast)}
<main>
${ast.steps.map((step) => renderStep(step, ast, images, tpl, { rich: true })).join('\n')}
</main>
${footer(ast)}
</div>
</div>
<div class="lightbox" role="dialog" aria-label="Screenshot"><img alt=""></div>`;
  const file = path.join(outDir, `${guideSlug(ast)}-rich.html`);
  const script = RICH_SCRIPT.replace('__KEY__', JSON.stringify(storageKey)) + (body.includes('<pre class="code') ? COPY_SCRIPT : '');
  fs.writeFileSync(file, page(ast, tpl, BASE_CSS + RICH_CSS, body, script));
  return { file, imageCount: images.size };
}

module.exports = { exportHtmlSimple, exportHtmlRich, DEFAULT_TEMPLATE, OPTION_INFO, anchorFor };
