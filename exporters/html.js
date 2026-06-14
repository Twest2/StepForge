'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');

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
  accentColor: '#2563eb',
  customCss: '',
};

function anchorFor(step) {
  return `step-${step.number.replace(/\./g, '-')}`;
}

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
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 860px;
         padding: 24px; color: #1f2937; background: #ffffff; line-height: 1.55; }
  h1 { font-size: 1.7em; margin-bottom: .2em; }
  h2 { font-size: 1.2em; margin-top: 1.6em; border-bottom: 1px solid #e5e7eb; padding-bottom: .25em; }
  img.shot { max-width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 6px; margin: .6em 0; }
  pre.code { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; }
  table { border-collapse: collapse; margin: .6em 0; }
  th, td { border: 1px solid #d1d5db; padding: 4px 10px; text-align: left; }
  .block { border-left: 4px solid #3b82f6; background: #eff6ff; padding: 8px 12px; margin: .6em 0; border-radius: 0 6px 6px 0; }
  .block strong { color: #1d4ed8; }
  .block-warn { border-color: #f59e0b; background: #fffbeb; }
  .block-warn strong { color: #b45309; }
  .block-error { border-color: #ef4444; background: #fef2f2; }
  .block-error strong { color: #b91c1c; }
  .block-success { border-color: #10b981; background: #ecfdf5; }
  .block-success strong { color: #047857; }
  .skipped { opacity: .55; }
  @media (prefers-color-scheme: dark) {
    body { background: #111827; color: #e5e7eb; }
    h2 { border-color: #374151; }
    pre.code, .block { background: #1f2937; }
    th, td { border-color: #4b5563; }
  }
`;

function exportHtmlSimple(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  const stepsHtml = ast.steps.map((step) => `
<section class="step${step.skipped ? ' skipped' : ''}" id="${anchorFor(step)}">
  <h2>${escapeHtml(step.number)}. ${escapeHtml(step.title || 'Untitled step')}</h2>
  ${stepBodyHtml(step, ast, images, tpl)}
</section>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ast.guide.title)}</title>
<style>${BASE_CSS}${tpl.customCss}</style>
</head>
<body>
<h1>${escapeHtml(ast.guide.title)}</h1>
${ast.guide.descriptionHtml ? `<div class="desc">${ast.guide.descriptionHtml}</div>` : ''}
${stepsHtml}
<footer><small>Generated by StepForge on ${escapeHtml(ast.generatedAt)} — ${ast.steps.length} steps</small></footer>
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

  const tocHtml = ast.steps.map((step) =>
    `<li class="d${step.depth}"><a href="#${anchorFor(step)}">${escapeHtml(step.number)}. ${escapeHtml(step.title || 'Untitled step')}</a></li>`
  ).join('\n');

  const stepsHtml = ast.steps.map((step) => `
<section class="step${step.skipped ? ' skipped' : ''}" id="${anchorFor(step)}">
  <h2>
    <label class="check"><input type="checkbox" class="step-done" data-step="${escapeHtml(step.stepId)}"></label>
    ${escapeHtml(step.number)}. ${escapeHtml(step.title || 'Untitled step')}
  </h2>
  ${stepBodyHtml(step, ast, images, tpl)}
</section>`).join('\n');

  const richCss = `
  .layout { display: flex; gap: 28px; max-width: 1180px; margin: 0 auto; }
  nav.toc { position: sticky; top: 16px; align-self: flex-start; min-width: 220px; max-width: 280px;
            max-height: calc(100vh - 32px); overflow-y: auto; font-size: .92em;
            border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
  nav.toc ul { list-style: none; margin: 0; padding: 0; }
  nav.toc li { margin: .25em 0; }
  nav.toc li.d1 { padding-left: 14px; } nav.toc li.d2 { padding-left: 28px; }
  nav.toc a { color: inherit; text-decoration: none; }
  nav.toc a:hover { color: ${tpl.accentColor}; }
  main { flex: 1; min-width: 0; }
  .progress { position: sticky; top: 0; background: inherit; padding: 8px 0; z-index: 2; }
  .progress .bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
  .progress .fill { height: 100%; width: 0; background: ${tpl.accentColor}; transition: width .2s; }
  label.check { margin-right: 8px; }
  section.step.done h2 { text-decoration: line-through; opacity: .6; }
  @media (max-width: 900px) { .layout { flex-direction: column; } nav.toc { position: static; max-width: none; } }
  @media (prefers-color-scheme: dark) { nav.toc { border-color: #374151; } .progress .bar { background: #374151; } }
`;

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
<style>${BASE_CSS}${richCss}${tpl.customCss}</style>
</head>
<body>
<div class="layout">
<nav class="toc"><strong>Contents</strong><ul>
${tocHtml}
</ul></nav>
<main>
<h1>${escapeHtml(ast.guide.title)}</h1>
${ast.guide.descriptionHtml ? `<div class="desc">${ast.guide.descriptionHtml}</div>` : ''}
<div class="progress"><div class="label"></div><div class="bar"><div class="fill"></div></div></div>
${stepsHtml}
<footer><small>Generated by StepForge on ${escapeHtml(ast.generatedAt)} — ${ast.steps.length} steps</small></footer>
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
