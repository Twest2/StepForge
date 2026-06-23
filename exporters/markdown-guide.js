'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
const { guideSlug, writeStepImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { htmlToMarkdown } = require('./htmlmd');
const { tocEntries, guideMetaLines, guideSummary } = require('./document-layout');

const DEFAULT_TEMPLATE = {
  toc: true,
  includeImages: true,
  azureWiki: false,
  imageMaxWidth: 0, // 0 = natural size
};

const WIKIJS_CALLOUT_CLASS = {
  info: 'is-info',
  success: 'is-success',
  warn: 'is-warning',
  error: 'is-danger',
};

const HTML_CALLOUT_THEME = {
  info: { label: 'Note', border: '#2563eb', fg: '#1d4ed8', kind: 'note' },
  success: { label: 'Tip', border: '#10b981', fg: '#047857', kind: 'tip' },
  warn: { label: 'Warning', border: '#f59e0b', fg: '#b45309', kind: 'warning' },
  error: { label: 'Important', border: '#ef4444', fg: '#b91c1c', kind: 'important' },
};

function anchorFor(step) {
  return `step-${step.number.replace(/\./g, '-')}`;
}

function quoteBody(text) {
  return text ? text.replace(/\n/g, '\n> ') : '';
}

function emitBlock(lines, tb, { alertStyle = 'gfm' } = {}) {
  const body = htmlToMarkdown(tb.descriptionHtml);
  if (alertStyle === 'html') {
    const theme = HTML_CALLOUT_THEME[tb.level] || HTML_CALLOUT_THEME.info;
    const label = theme.label;
    const title = tb.title ? `${label}: ${tb.title}` : label;
    const style = `border-left: 4px solid ${theme.border}; padding: 14px 16px; margin: 14px 0; border-radius: 0 16px 16px 0;`;
    lines.push(
      `<div class="sf-callout sf-callout-${theme.kind}" style="${style}">`,
      `<div style="font-weight: 700; color: ${theme.fg}; margin-bottom: ${body ? '6px' : '0'};">${escapeHtml(title)}</div>`,
    );
    if (body) lines.push(`<div style="color: inherit;">${tb.descriptionHtml || ''}</div>`);
    lines.push('</div>', '');
    return;
  }
  if (alertStyle === 'wikijs') {
    const label = tb.title || LEVEL_LABEL[tb.level] || 'Note';
    const className = WIKIJS_CALLOUT_CLASS[tb.level] || 'is-info';
    lines.push(`> **${label}**`);
    if (body) lines.push(`> ${quoteBody(body)}`);
    lines.push(`{.${className}}`, '');
    return;
  }

  const label = LEVEL_LABEL[tb.level] || 'Note';
  lines.push(`> [!${label.toUpperCase()}]`);
  if (tb.title) lines.push(`> **${tb.title}**`);
  if (body) lines.push(`> ${quoteBody(body)}`);
  lines.push('');
}

function renderMarkdownGuide(ast, outDir, template = {}, {
  defaults = DEFAULT_TEMPLATE,
  alertStyle = 'gfm',
  tocTitle = 'Contents',
  fileExt = '.md',
} = {}) {
  const tpl = { ...defaults, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? writeStepImages(ast, outDir) : new Map();
  const lines = [];

  lines.push(`# ${ast.guide.title}`, '');
  lines.push('<div style="height:4px;background:#2563eb;border-radius:999px;margin:12px 0 18px;"></div>', '');
  const metaLines = guideMetaLines(ast);
  if (metaLines.length) lines.push(metaLines.join(' · '), '');
  lines.push(`*${guideSummary(ast)}*`, '');
  if (ast.guide.descriptionHtml) lines.push(htmlToMarkdown(ast.guide.descriptionHtml), '');

  if (tpl.toc && ast.steps.length > 1) {
    lines.push(`## ${tocTitle}`, '');
    for (const entry of tocEntries(ast)) {
      const indent = '  '.repeat(entry.depth);
      lines.push(`${indent}- [${entry.number}. ${entry.title}](#${entry.anchor})`);
    }
    lines.push('');
  }

  for (const step of ast.steps) {
    const heading = step.depth > 0 ? '###' : '##';
    const {
      beforeTitle,
      afterTitle,
      beforeDescription,
      afterDescription,
      beforeImage,
      afterImage,
      rest,
    } = stepContentGroups(step);
    lines.push(`<a id="${anchorFor(step)}"></a>`, '');
    for (const tb of beforeTitle) emitBlock(lines, tb, { alertStyle });
    lines.push(`${heading} ${step.number}. ${step.title || 'Untitled step'}`, '');
    if (step.skipped) lines.push('*(skipped)*', '');
    for (const tb of afterTitle) emitBlock(lines, tb, { alertStyle });
    for (const tb of beforeDescription) emitBlock(lines, tb, { alertStyle });
    if (step.descriptionHtml) lines.push(htmlToMarkdown(step.descriptionHtml), '');
    for (const tb of afterDescription) emitBlock(lines, tb, { alertStyle });

    for (const tb of beforeImage) emitBlock(lines, tb, { alertStyle });
    const img = images.get(step.stepId);
    if (img) {
      if (tpl.azureWiki && tpl.imageMaxWidth > 0) {
        lines.push(`![Step ${step.number}](${img.relPath} =${tpl.imageMaxWidth}x)`, '');
      } else {
        lines.push(`![Step ${step.number}](${img.relPath})`, '');
      }
    }
    for (const tb of afterImage) emitBlock(lines, tb, { alertStyle });

    for (const block of rest) {
      if (block.kind === 'text') {
        emitBlock(lines, block, { alertStyle });
      } else if (block.kind === 'code') {
        lines.push(`\`\`\`${block.language || ''}`, codeBlockText(block), '```', '');
      } else if (block.kind === 'table') {
        if (!block.rows || !block.rows.length) continue;
        const width = Math.max(...block.rows.map((r) => r.length));
        const pad = (r) => { const c = [...r]; while (c.length < width) c.push(''); return c; };
        lines.push(`| ${pad(block.rows[0]).join(' | ')} |`);
        lines.push(`|${' --- |'.repeat(width)}`);
        for (const row of block.rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
        lines.push('');
      }
    }
  }

  const file = path.join(outDir, `${guideSlug(ast)}${fileExt}`);
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  return { file, imageCount: images.size };
}

module.exports = {
  DEFAULT_TEMPLATE,
  anchorFor,
  renderMarkdownGuide,
};
