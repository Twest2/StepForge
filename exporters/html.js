'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { anchorFor, tocEntries, guideMetaLines, guideSummary } = require('./document-layout');

/**
 * HTML exporters. Both variants are fully self-contained single files:
 * screenshots are embedded as data URIs, styles are inline, and there are
 * no external (network) references of any kind.
 *
 * - simple: lightweight, copy-paste friendly markup.
 * - rich: floating TOC, per-step checkboxes with progress persisted in the
 *   browser's localStorage (local only), and a progress bar.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  toc: true,
  accentColor: '#2563eb',
  customCss: '',
};

function dataUri(img) {
  return `data:image/png;base64,${encodePng(img).toString('base64')}`;
}

function stepLinkRewrite(html, ast) {
  // step:<id> hrefs become local anchors when the target step is exported.
  return html.replace(/href="step:([^"]+)"/g, (m, id) => {
    const target = ast.steps.find((s) => s.stepId === id);
    return target ? `href="#${anchorFor(target)}"` : 'data-missing-step-link="true"';
  });
}

function blockHtml(tb) {
  return `<div class="block block-${tb.level}"><strong>${escapeHtml(LEVEL_LABEL[tb.level] || 'Note')}${tb.title ? `: ${escapeHtml(tb.title)}` : ''}</strong>${tb.descriptionHtml ? `<div>${tb.descriptionHtml}</div>` : ''}</div>`;
}

function renderMetaChips(ast) {
  return [
    ...guideMetaLines(ast).map((line) => `<span class="chip">${escapeHtml(line)}</span>`),
    `<span class="chip muted">${escapeHtml(guideSummary(ast))}</span>`,
  ].join('');
}

function renderTocList(ast) {
  return tocEntries(ast).map((entry) => `
    <li class="d${entry.depth}">
      <a href="#${entry.anchor}">
        <span class="num">${escapeHtml(entry.number)}</span>
        <span class="label">${escapeHtml(entry.title)}</span>
      </a>
    </li>
  `).join('');
}

function renderCover(ast, tpl) {
  return `
  <section class="cover">
    <div class="eyebrow">StepForge export</div>
    <h1>${escapeHtml(ast.guide.title)}</h1>
    <div class="rule" style="background:${tpl.accentColor}"></div>
    ${ast.guide.descriptionHtml ? `<div class="desc">${stepLinkRewrite(ast.guide.descriptionHtml, ast)}</div>` : ''}
    <div class="meta">${renderMetaChips(ast)}</div>
  </section>`;
}

function renderStepCard(step, ast, images, tpl, { rich = false, selected = false } = {}) {
  const title = `${escapeHtml(step.number)}. ${escapeHtml(step.title || 'Untitled step')}`;
  const statusText = step.skipped
    ? 'Skipped'
    : step.status === 'in-progress'
      ? 'In progress'
      : step.status === 'done'
        ? 'Done'
        : 'Todo';
  const head = rich ? `
    <h2>
      <label class="check"><input type="checkbox" class="step-done" data-step="${escapeHtml(step.stepId)}"></label>
      <span class="step-num">${escapeHtml(step.number)}</span>
      <span class="step-title">${escapeHtml(step.title || 'Untitled step')}</span>
      <span class="status-chip status-${step.status || 'todo'}${step.skipped ? ' skipped' : ''}">${escapeHtml(statusText)}</span>
    </h2>` : `<h2>${title}</h2>`;
  return `
  <section class="step-card${step.skipped ? ' skipped' : ''}${rich && selected ? ' selected' : ''}" id="${anchorFor(step)}">
    ${head}
    <div class="step-body">
      ${stepBodyHtml(step, ast, images, tpl)}
    </div>
  </section>`;
}

function renderRichToc(ast) {
  return tocEntries(ast).map((entry) => `
    <li class="d${entry.depth}">
      <a href="#${entry.anchor}">
        <span class="num">${escapeHtml(entry.number)}</span>
        <span class="label">${escapeHtml(entry.title)}</span>
      </a>
    </li>
  `).join('');
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [37, 99, 235];
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function bodyStyle(tpl) {
  const [r, g, b] = hexToRgb(tpl.accentColor);
  return `--accent:${tpl.accentColor};--accent-rgb:${r},${g},${b};`;
}

function stepBodyHtml(step, ast, images, tpl) {
  const parts = [];
  const { before, rest } = stepContentGroups(step);
  for (const tb of before) parts.push(blockHtml(tb));
  if (step.descriptionHtml) parts.push(`<div class="desc">${stepLinkRewrite(step.descriptionHtml, ast)}</div>`);
  const img = images.get(step.stepId);
  if (img && tpl.includeImages) {
    parts.push(`<img class="shot" alt="Step ${escapeHtml(step.number)}" src="${dataUri(img)}" width="${img.width}">`);
  }
  for (const block of rest) {
    if (block.kind === 'text') {
      parts.push(blockHtml(block));
    } else if (block.kind === 'code') {
      parts.push(`<pre class="code"><code>${escapeHtml(codeBlockText(block))}</code></pre>`);
    } else if (block.kind === 'table') {
      if (!block.rows || !block.rows.length) continue;
      const [head, ...bodyRows] = block.rows;
      parts.push('<table><thead><tr>' + head.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>'
        + bodyRows.map((r) => '<tr>' + r.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
    }
  }
  return parts.filter(Boolean).join('\n');
}

const BASE_CSS = `
  :root {
    --bg: #f4f7fb;
    --bg-2: #eef3f9;
    --panel: rgba(255, 255, 255, 0.92);
    --panel-strong: #ffffff;
    --panel-soft: #f8fbff;
    --text: #152033;
    --muted: #637084;
    --border: rgba(119, 134, 156, 0.22);
    --shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
  }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--text);
    background:
      radial-gradient(circle at top right, rgba(var(--accent-rgb), 0.16), transparent 26%),
      radial-gradient(circle at bottom left, rgba(14, 165, 233, 0.11), transparent 22%),
      linear-gradient(180deg, var(--bg), var(--bg-2));
    line-height: 1.6;
    font-family: "Aptos", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  img.shot {
    max-width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: 18px;
    margin: 16px 0;
    box-shadow: var(--shadow);
  }
  pre.code {
    background: #0f172a;
    color: #e2e8f0;
    padding: 16px 18px;
    border-radius: 18px;
    overflow-x: auto;
    box-shadow: var(--shadow);
  }
  pre.code code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 14px 0;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  th, td {
    border-bottom: 1px solid rgba(119, 134, 156, 0.16);
    padding: 10px 12px;
    text-align: left;
  }
  thead th {
    background: var(--panel-soft);
    color: var(--text);
    font-size: .88rem;
    letter-spacing: .02em;
    text-transform: uppercase;
  }
  tbody tr:last-child td { border-bottom: 0; }
  .doc { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 40px; }
  .cover, .toc-card, .step-card, .progress-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 24px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
  }
  .cover {
    padding: 34px 36px 28px;
    margin-bottom: 22px;
  }
  .cover .eyebrow {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: .16em;
    font-size: .74rem;
    font-weight: 800;
    margin-bottom: 14px;
  }
  .cover h1 {
    font-size: clamp(2rem, 4vw, 3.6rem);
    line-height: 1.02;
    margin: 0;
    letter-spacing: -0.04em;
  }
  .cover .rule {
    width: 132px;
    height: 6px;
    margin: 18px 0 16px;
    border-radius: 999px;
    box-shadow: 0 10px 24px rgba(var(--accent-rgb), 0.22);
  }
  .cover .desc {
    max-width: 76ch;
    color: var(--muted);
    font-size: 1.02rem;
  }
  .cover .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 11px;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.10);
    color: var(--accent);
    border: 1px solid rgba(var(--accent-rgb), 0.14);
    font-size: .86rem;
    font-weight: 650;
  }
  .chip.muted {
    background: rgba(255, 255, 255, 0.55);
    color: var(--muted);
    border-color: rgba(119, 134, 156, 0.16);
  }
  .toc-card {
    padding: 20px 22px;
    margin-bottom: 24px;
  }
  .toc-card h2 {
    margin: 0 0 16px;
    font-size: 1.08rem;
    letter-spacing: .02em;
  }
  .toc-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .toc-list li { margin: 0; }
  .toc-list a {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 9px 12px;
    border-radius: 14px;
    color: inherit;
  }
  .toc-list a:hover {
    background: rgba(var(--accent-rgb), 0.08);
    text-decoration: none;
  }
  .toc-list .num {
    min-width: 44px;
    color: var(--accent);
    font-weight: 800;
  }
  .toc-list .label { flex: 1; }
  .toc-list li.d1 a { padding-left: 24px; }
  .toc-list li.d2 a { padding-left: 44px; }
  .toc-list li.d3 a { padding-left: 64px; }
  .step-card {
    margin: 20px 0;
    padding: 22px 24px 18px;
    border-left: 6px solid var(--accent);
  }
  .step-card h2 {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 0 0 16px;
    font-size: 1.28rem;
    line-height: 1.15;
  }
  .step-card h2 .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.1rem;
    height: 2.1rem;
    padding: 0 10px;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.11);
    color: var(--accent);
    font-size: .9rem;
    font-weight: 800;
    letter-spacing: .02em;
    flex: none;
  }
  .step-card h2 .step-title { flex: 1; }
  .status-chip {
    display: inline-flex;
    align-items: center;
    height: 1.65rem;
    padding: 0 9px;
    border-radius: 999px;
    font-size: .72rem;
    letter-spacing: .08em;
    text-transform: uppercase;
    font-weight: 800;
    color: #334155;
    background: var(--panel-soft);
    border: 1px solid rgba(119, 134, 156, 0.18);
  }
  .status-chip.status-done {
    color: #047857;
    background: #ecfdf5;
    border-color: rgba(16, 185, 129, 0.22);
  }
  .status-chip.status-in-progress {
    color: #b45309;
    background: #fffbeb;
    border-color: rgba(245, 158, 11, 0.22);
  }
  .status-chip.status-todo {
    color: #475569;
  }
  .status-chip.skipped {
    color: #92400e;
    background: #fffbeb;
    border-color: rgba(245, 158, 11, 0.24);
  }
  .step-card.skipped { opacity: .76; }
  .step-body > .desc {
    color: #243044;
  }
  .block {
    position: relative;
    border-left: 4px solid var(--accent);
    background: rgba(var(--accent-rgb), 0.08);
    padding: 14px 16px 14px 54px;
    margin: 14px 0;
    border-radius: 18px;
    overflow: hidden;
  }
  .block::before {
    content: 'i';
    position: absolute;
    left: 16px;
    top: 14px;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--accent);
    font-weight: 900;
    font-size: 13px;
  }
  .block strong { color: var(--text); }
  .block-warn { border-color: #f59e0b; background: #fffbeb; }
  .block-warn::before { content: '!'; background: rgba(245, 158, 11, 0.16); color: #b45309; }
  .block-warn strong { color: #92400e; }
  .block-error { border-color: #ef4444; background: #fef2f2; }
  .block-error::before { content: '!'; background: rgba(239, 68, 68, 0.14); color: #b91c1c; }
  .block-error strong { color: #b91c1c; }
  .block-success { border-color: #10b981; background: #ecfdf5; }
  .block-success::before { content: '✓'; background: rgba(16, 185, 129, 0.14); color: #047857; }
  .block-success strong { color: #047857; }
  .footer-note {
    margin-top: 20px;
    color: var(--muted);
    font-size: .84rem;
  }
  .skipped { opacity: .55; }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1220;
      --bg-2: #0f172a;
      --panel: rgba(17, 24, 39, 0.9);
      --panel-strong: #111827;
      --panel-soft: #162033;
      --text: #e5e7eb;
      --muted: #98a2b3;
      --border: rgba(148, 163, 184, 0.18);
      --shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
    }
    .status-chip { color: #d1d5db; }
    .status-chip.skipped { color: #fbbf24; background: rgba(245, 158, 11, 0.12); }
    .cover .desc, .step-body > .desc { color: #cbd5e1; }
    .chip.muted { background: rgba(15, 23, 42, 0.75); color: #cbd5e1; }
    .block { background: rgba(37, 99, 235, 0.12); }
    .block-warn { background: rgba(245, 158, 11, 0.12); }
    .block-error { background: rgba(239, 68, 68, 0.12); }
    .block-success { background: rgba(16, 185, 129, 0.12); }
    table { background: var(--panel-strong); }
    th, td { border-bottom-color: rgba(148, 163, 184, 0.12); }
  }
`;

const RICH_CSS = `
  .layout-rich {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }
  .toc-panel {
    position: sticky;
    top: 20px;
    align-self: start;
  }
  .toc-card {
    margin: 0;
    max-height: calc(100vh - 40px);
    overflow: auto;
  }
  .progress-card {
    margin-bottom: 22px;
    padding: 14px 18px;
  }
  .progress {
    position: sticky;
    top: 0;
    z-index: 2;
    background: transparent;
  }
  .progress .label {
    font-size: .86rem;
    font-weight: 700;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .progress .bar {
    height: 8px;
    background: rgba(148, 163, 184, 0.18);
    border-radius: 999px;
    overflow: hidden;
  }
  .progress .fill {
    height: 100%;
    width: 0;
    background: var(--accent);
    transition: width .2s ease;
  }
  label.check { margin-right: 0; }
  label.check input { transform: translateY(1px); }
  .step-card h2 .step-title { min-width: 0; }
  @media (max-width: 960px) {
    .layout-rich { grid-template-columns: 1fr; }
    .toc-panel { position: static; }
    .toc-card { max-height: none; }
  }
`;

function exportHtmlSimple(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  const toc = tpl.toc && ast.steps.length > 1
    ? `
    <section class="toc-card">
      <h2>Contents</h2>
      <ul class="toc-list">
        ${renderTocList(ast)}
      </ul>
    </section>`
    : '';
  const stepsHtml = ast.steps.map((step) => renderStepCard(step, ast, images, tpl)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ast.guide.title)}</title>
<style>${BASE_CSS}${tpl.customCss}</style>
</head>
<body style="${bodyStyle(tpl)}">
<div class="doc doc-simple">
${renderCover(ast, tpl)}
${toc}
${stepsHtml}
<footer class="footer-note">Generated by StepForge on ${escapeHtml(ast.generatedAt)} · ${ast.steps.length} step${ast.steps.length === 1 ? '' : 's'}</footer>
</div>
</body>
</html>
`;
  const file = path.join(outDir, `${guideSlug(ast)}.html`);
  fs.writeFileSync(file, html);
  return { file, imageCount: images.size };
}

function exportHtmlRich(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  const storageKey = `stepforge-progress-${ast.guide.id}`;
  const tocHtml = tpl.toc && ast.steps.length > 1
    ? `
      <aside class="toc-panel">
        <section class="toc-card">
          <h2>Contents</h2>
          <ul class="toc-list">
            ${renderRichToc(ast)}
          </ul>
        </section>
      </aside>`
    : '';

  const stepsHtml = ast.steps.map((step) => renderStepCard(step, ast, images, tpl, { rich: true })).join('\n');

  const script = `
(function () {
  var key = ${JSON.stringify(storageKey)};
  var state = {};
  try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
  var boxes = document.querySelectorAll('input.step-done');
  function refresh() {
    var done = 0;
    boxes.forEach(function (b) {
      b.closest('section').classList.toggle('done', b.checked);
      if (b.checked) done++;
    });
    var fill = document.querySelector('.progress .fill');
    if (fill) fill.style.width = (boxes.length ? (100 * done / boxes.length) : 0) + '%';
    var label = document.querySelector('.progress .label');
    if (label) label.textContent = done + ' / ' + boxes.length + ' steps done';
  }
  boxes.forEach(function (b) {
    b.checked = !!state[b.dataset.step];
    b.addEventListener('change', function () {
      state[b.dataset.step] = b.checked;
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
      refresh();
    });
  });
  refresh();
})();
`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ast.guide.title)}</title>
<style>${BASE_CSS}${RICH_CSS}${tpl.customCss}</style>
</head>
<body style="${bodyStyle(tpl)}">
<div class="doc layout-rich">
${tocHtml}
<main>
${renderCover(ast, tpl)}
<div class="progress progress-card">
  <div class="label"></div>
  <div class="bar"><div class="fill"></div></div>
</div>
${stepsHtml}
<footer class="footer-note">Generated by StepForge on ${escapeHtml(ast.generatedAt)} · ${ast.steps.length} step${ast.steps.length === 1 ? '' : 's'}</footer>
</main>
</div>
<script>${script}</script>
</body>
</html>
`;
  const file = path.join(outDir, `${guideSlug(ast)}-rich.html`);
  fs.writeFileSync(file, html);
  return { file, imageCount: images.size };
}

module.exports = { exportHtmlSimple, exportHtmlRich, DEFAULT_TEMPLATE, anchorFor };
