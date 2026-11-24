'use strict';

const { htmlToText } = require('../core/util');
const { encodePng } = require('../core/png');
const { renderAllImages, stepContentGroups, codeBlockText, LEVEL_LABEL, levelLabel, flowchartImageKey } = require('./common');
const { guideMetaLines, stepCount } = require('./document-layout');
const { exportText } = require('../core/export-text');
const { fitRaster } = require('./branding');

/**
 * The guide as Notion blocks (Share → Publish to Notion, app/notion.js).
 * Like 'clipboard', it isn't an Export dialog format: it returns
 * { blocks, images } and writes no files. Image blocks hold
 * { stepforgeImage: index } until the screenshot at that index of
 * `images` (base64 PNG) is uploaded and the block points at it.
 */

const MAX_IMAGE_WIDTH = 1600;
const TEXT_LIMIT = 2000; // characters per Notion rich-text item
const CALLOUT_ICON = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '⛔' };
// Notion's code languages are a fixed list; anything else is plain text.
const CODE_LANGUAGES = new Set(['bash', 'c', 'c#', 'c++', 'css', 'diff', 'docker', 'go', 'html', 'java', 'javascript', 'json', 'kotlin',
  'markdown', 'php', 'powershell', 'python', 'ruby', 'rust', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml']);
const CODE_ALIASES = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', ps1: 'powershell', cs: 'c#', cpp: 'c++', yml: 'yaml' };

/** Text as rich-text items of at most TEXT_LIMIT characters. */
function richText(text, annotations = null) {
  const out = [];
  for (let i = 0; i < text.length; i += TEXT_LIMIT) {
    out.push({ type: 'text', text: { content: text.slice(i, i + TEXT_LIMIT) }, ...(annotations ? { annotations } : {}) });
  }
  return out;
}

const block = (type, body) => ({ object: 'block', type, [type]: body });
const paragraphs = (html) => htmlToText(html || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => block('paragraph', { rich_text: richText(p) }));

function callout(tb, ast) {
  const level = LEVEL_LABEL[tb.level] ? tb.level : 'info';
  const heading = tb.title || levelLabel(level, ast);
  const body = htmlToText(tb.descriptionHtml || '').trim();
  return block('callout', { icon: { type: 'emoji', emoji: CALLOUT_ICON[level] },
    rich_text: [...richText(heading, { bold: true }), ...(body ? richText(`\n${body}`) : [])] });
}

function codeBlock(tb) {
  const lang = String(tb.language || '').toLowerCase();
  const language = CODE_LANGUAGES.has(CODE_ALIASES[lang] || lang) ? CODE_ALIASES[lang] || lang : 'plain text';
  return block('code', { language, rich_text: richText(codeBlockText(tb)) });
}

function tableBlock(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  return block('table', { table_width: width, has_column_header: true, has_row_header: false,
    children: rows.map((row) => block('table_row', { cells: Array.from({ length: width }, (_, i) => richText(String(row[i] ?? ''))) })) });
}

function exportNotion(ast) {
  const { t } = exportText(ast);
  const images = [];
  const imageBlock = (img, caption) => {
    images.push(encodePng(fitRaster(img, MAX_IMAGE_WIDTH, Number.MAX_SAFE_INTEGER)).toString('base64'));
    return block('image', { stepforgeImage: images.length - 1, caption: caption ? richText(caption) : [] });
  };
  const rendered = renderAllImages(ast);
  const blocks = [...paragraphs(ast.guide.descriptionHtml),
    block('paragraph', { rich_text: richText([stepCount(ast), ...guideMetaLines(ast)].join(' · '), { color: 'gray' }) })];
  if (ast.branding?.header.text) blocks.unshift(block('paragraph', { rich_text: richText(ast.branding.header.text, { color: 'gray' }) }));
  for (const step of ast.steps) {
    const groups = stepContentGroups(step);
    const chart = rendered.get(flowchartImageKey(step.stepId));
    const callouts = (list) => list.map((tb) => (tb.kind === 'flowchart' ? (chart ? imageBlock(chart, '') : null) : callout(tb, ast))).filter(Boolean);
    blocks.push(...callouts(groups.beforeTitle));
    const title = `${step.number}. ${step.title || t('Untitled step')}${step.skipped ? ` ${t('(Skipped)')}` : ''}`;
    blocks.push(block(step.depth > 0 ? 'heading_3' : 'heading_2', { rich_text: richText(title) }));
    blocks.push(...callouts(groups.afterTitle), ...callouts(groups.beforeDescription), ...paragraphs(step.descriptionHtml));
    blocks.push(...callouts(groups.afterDescription), ...callouts(groups.beforeImage));
    const img = rendered.get(step.stepId);
    if (img) blocks.push(imageBlock(img, step.altText || ''));
    blocks.push(...callouts(groups.afterImage));
    for (const tb of groups.rest) {
      if (tb.kind === 'text') blocks.push(callout(tb, ast));
      else if (tb.kind === 'code') blocks.push(codeBlock(tb));
      else if (tb.kind === 'table' && tb.rows?.length) blocks.push(tableBlock(tb.rows));
    }
  }
  if (ast.branding?.footer.text) blocks.push(block('paragraph', { rich_text: richText(ast.branding.footer.text, { color: 'gray' }) }));
  return { blocks, images };
}

module.exports = { exportNotion, richText };
