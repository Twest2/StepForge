'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify, escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, stepContentGroups, codeBlockText } = require('./common');

/**
 * Confluence storage-format export. Writes a single XHTML document plus a
 * sidecar attachments folder containing the rendered screenshots referenced
 * by the page.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
};

const MACRO_FOR_LEVEL = {
  info: 'info',
  warn: 'warning',
  error: 'note',
  success: 'tip',
};

function anchorFor(step) {
  return `step-${step.number.replace(/\./g, '-')}`;
}

function stepLinkRewrite(html, ast) {
  return String(html || '').replace(/href="step:([^"]+)"/g, (m, id) => {
    const target = ast.steps.find((s) => s.stepId === id);
    return target ? `href="#${anchorFor(target)}"` : 'data-missing-step-link="true"';
  });
}

function cdata(text) {
  return `<![CDATA[${String(text || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function blockMacro(tb, ast) {
  const macro = MACRO_FOR_LEVEL[tb.level] || 'note';
  const title = tb.title ? `<ac:parameter ac:name="title">${escapeXml(tb.title)}</ac:parameter>` : '';
  const body = tb.descriptionHtml ? `<div>${stepLinkRewrite(tb.descriptionHtml, ast)}</div>` : '<p />';
  return `<ac:structured-macro ac:name="${macro}">${title}<ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;
}

function exportConfluence(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  const attachmentDir = path.join(outDir, `${guideSlug(ast)}-attachments`);
  fs.mkdirSync(attachmentDir, { recursive: true });

  let attachmentCount = 0;
  const attachmentNames = new Map();
  for (const step of ast.steps) {
    const img = images.get(step.stepId);
    if (!img) continue;
    attachmentCount += 1;
    const fileName = `${String(attachmentCount).padStart(3, '0')}-${slugify(step.title || step.stepId, step.stepId)}.png`;
    fs.writeFileSync(path.join(attachmentDir, fileName), encodePng(img));
    attachmentNames.set(step.stepId, fileName);
  }

  const stepXml = ast.steps.map((step) => {
    const parts = [`<a id="${anchorFor(step)}"></a>`, `<h2>${escapeXml(step.number)}. ${escapeXml(step.title || 'Untitled step')}</h2>`];
    if (step.skipped) parts.push('<p><em>(skipped)</em></p>');

    const { before, rest } = stepContentGroups(step);
    for (const tb of before) {
      parts.push(blockMacro(tb, ast));
    }

    if (step.descriptionHtml) {
      parts.push(`<div>${stepLinkRewrite(step.descriptionHtml, ast)}</div>`);
    }

    const attachment = attachmentNames.get(step.stepId);
    if (attachment) {
      parts.push(`<p><ac:image><ri:attachment ri:filename="${escapeXml(attachment)}" /></ac:image></p>`);
    }

    for (const block of rest) {
      if (block.kind === 'text') {
        parts.push(blockMacro(block, ast));
      } else if (block.kind === 'code') {
        const lang = block.language ? `<ac:parameter ac:name="language">${escapeXml(block.language)}</ac:parameter>` : '';
        parts.push(`<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body>${cdata(codeBlockText(block))}</ac:plain-text-body></ac:structured-macro>`);
      } else if (block.kind === 'table') {
        if (!block.rows || !block.rows.length) continue;
        const width = Math.max(...block.rows.map((row) => row.length));
        const rows = block.rows.map((row, rowIndex) => (
          `<tr>${Array.from({ length: width }, (_, i) => {
            const cell = escapeXml(row[i] ?? '');
            return rowIndex === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`;
          }).join('')}</tr>`
        ));
        parts.push(`<table><tbody>${rows.join('')}</tbody></table>`);
      }
    }

    return `<div class="step">${parts.join('\n')}</div>`;
  }).join('\n');

  const html = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:ac="http://atlassian.com/content"
      xmlns:ri="http://atlassian.com/resource/identifier">
<head>
  <title>${escapeXml(ast.guide.title)}</title>
</head>
<body>
  <h1>${escapeXml(ast.guide.title)}</h1>
  ${ast.guide.descriptionHtml ? `<div>${stepLinkRewrite(ast.guide.descriptionHtml, ast)}</div>` : ''}
  ${stepXml}
</body>
</html>
`;

  const file = path.join(outDir, `${guideSlug(ast)}.confluence.xml`);
  fs.writeFileSync(file, html);
  return { file, attachmentCount: images.size };
}

module.exports = { exportConfluence, DEFAULT_TEMPLATE };
