'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { guideSlug, writeStepImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { htmlToMarkdown } = require('./htmlmd');

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

function anchorFor(step) {
  return `step-${step.number.replace(/\./g, '-')}`;
}

function quoteBody(text) {
  return text ? text.replace(/\n/g, '\n> ') : '';
}

function emitBlock(lines, tb, { alertStyle = 'gfm' } = {}) {
  const body = htmlToMarkdown(tb.descriptionHtml);
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
  if (ast.guide.descriptionHtml) lines.push(htmlToMarkdown(ast.guide.descriptionHtml), '');

  if (tpl.toc && ast.steps.length > 1) {
    lines.push(`## ${tocTitle}`, '');
    for (const step of ast.steps) {
      const indent = '  '.repeat(step.depth);
      lines.push(`${indent}- [${step.number}. ${step.title || 'Untitled step'}](#${anchorFor(step)})`);
    }
    lines.push('');
  }

  for (const step of ast.steps) {
    const heading = step.depth > 0 ? '###' : '##';
    lines.push(`<a id="${anchorFor(step)}"></a>`, '');
    lines.push(`${heading} ${step.number}. ${step.title || 'Untitled step'}`, '');
    if (step.skipped) lines.push('*(skipped)*', '');

    const { before, rest } = stepContentGroups(step);
    for (const tb of before) emitBlock(lines, tb, { alertStyle });

    if (step.descriptionHtml) lines.push(htmlToMarkdown(step.descriptionHtml), '');

    const img = images.get(step.stepId);
    if (img) {
      if (tpl.azureWiki && tpl.imageMaxWidth > 0) {
        lines.push(`![Step ${step.number}](${img.relPath} =${tpl.imageMaxWidth}x)`, '');
      } else {
        lines.push(`![Step ${step.number}](${img.relPath})`, '');
      }
    }

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
