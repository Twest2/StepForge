'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { guideSlug, writeStepImages, LEVEL_LABEL, stepBlocks, codeBlockText } = require('./common');
const { htmlToMarkdown } = require('./htmlmd');

/**
 * Markdown exporter. Writes <slug>.md plus a steps-<slug>/ image folder.
 * azureWiki mode emits resized image syntax (=WxH) Azure DevOps wikis accept.
 */

const DEFAULT_TEMPLATE = {
  toc: true,
  includeImages: true,
  azureWiki: false,
  imageMaxWidth: 0, // 0 = natural size
};

function anchorFor(step) {
  return `step-${step.number.replace(/\./g, '-')}`;
}

function exportMarkdown(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? writeStepImages(ast, outDir) : new Map();
  const lines = [];

  lines.push(`# ${ast.guide.title}`, '');
  if (ast.guide.descriptionHtml) lines.push(htmlToMarkdown(ast.guide.descriptionHtml), '');

  if (tpl.toc && ast.steps.length > 1) {
    lines.push('## Contents', '');
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

    emitBlocks(lines, step, 'before-description');

    if (step.descriptionHtml) lines.push(htmlToMarkdown(step.descriptionHtml), '');

    const img = images.get(step.stepId);
    if (img) {
      if (tpl.azureWiki && tpl.imageMaxWidth > 0) {
        lines.push(`![Step ${step.number}](${img.relPath} =${tpl.imageMaxWidth}x)`, '');
      } else {
        lines.push(`![Step ${step.number}](${img.relPath})`, '');
      }
    }

    for (const block of stepBlocks(step).filter((item) => item.kind !== 'text')) {
      if (block.kind === 'code') {
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

    emitBlocks(lines, step, 'after-description');
    emitBlocks(lines, step, 'after-image');
  }

  const file = path.join(outDir, `${guideSlug(ast)}.md`);
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  return { file, imageCount: images.size };
}

function emitBlocks(lines, step, position) {
  for (const tb of stepBlocks(step).filter((b) => b.kind === 'text' && b.position === position)) {
    const label = LEVEL_LABEL[tb.level] || 'Note';
    // GitHub-Flavored Markdown alert syntax — renders with a colored,
    // icon-labeled box on GitHub/Azure DevOps wikis and several other
    // viewers; degrades to a plain blockquote elsewhere.
    lines.push(`> [!${label.toUpperCase()}]`);
    if (tb.title) lines.push(`> **${tb.title}**`);
    const body = htmlToMarkdown(tb.descriptionHtml);
    if (body) lines.push(`> ${body.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }
}

module.exports = { exportMarkdown, DEFAULT_TEMPLATE, anchorFor };
