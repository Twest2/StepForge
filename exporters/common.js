'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify, fileNameSlug, escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { renderStepImage, renderFlowchartImage, flowchartAltText } = require('../core/renderast');
const { flowchartImageKey } = require('../core/image-format');
const { orderedBlocks, blockText } = require('../core/blocks');
const { exportText } = require('../core/export-text');

/**
 * Shared exporter helpers: every image-bearing exporter renders annotated
 * step images through the same pipeline so output is consistent.
 */

/** The guide's export file name, in the title's own script. */
function guideSlug(ast) {
  return fileNameSlug(ast.guide.title, 'guide');
}

function imagesDirName(ast) {
  return `steps-${guideSlug(ast)}`;
}

/**
 * Render every image step to an annotated PNG inside outDir/<steps-slug>/.
 * Returns Map stepId -> { relPath, width, height }.
 */
function writeStepImages(ast, outDir) {
  const dirName = imagesDirName(ast);
  const dir = path.join(outDir, dirName);
  const result = new Map();
  let n = 0;
  for (const step of ast.steps) {
    n += 1;
    const img = renderStepImage(step);
    if (!img) continue;
    fs.mkdirSync(dir, { recursive: true });
    // ASCII on purpose: Markdown screenshots are uploaded to Wiki.js under these names.
    const fileName = `${String(n).padStart(3, '0')}-${slugify(step.title || step.stepId, step.stepId)}.png`;
    fs.writeFileSync(path.join(dir, fileName), encodePng(img));
    result.set(step.stepId, { relPath: `${dirName}/${fileName}`, width: img.width, height: img.height });
  }
  n = 0;
  for (const step of ast.steps) {
    n += 1;
    const chart = renderFlowchartImage(step);
    if (!chart) continue;
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${String(n).padStart(3, '0')}-${slugify(step.title || step.stepId, step.stepId)}-flowchart.png`;
    fs.writeFileSync(path.join(dir, fileName), encodePng(chart));
    result.set(flowchartImageKey(step.stepId), { relPath: `${dirName}/${fileName}`, width: chart.width, height: chart.height });
  }
  return result;
}

/** Render step images in-memory (for self-contained HTML, PDF, GIF...). */
function renderAllImages(ast) {
  const result = new Map();
  for (const step of ast.steps) {
    const img = renderStepImage(step);
    if (img) result.set(step.stepId, img);
    const chart = renderFlowchartImage(step);
    if (chart) result.set(flowchartImageKey(step.stepId), chart);
  }
  return result;
}

/**
 * The name an exported image gets on the site: step-001.png for step 1's
 * screenshot, step-001-flowchart.png for its flowchart block, and
 * step-001-2.png should two still clash.
 */
function publishedImageName(file, used) {
  const base = `step-${file.slice(0, 3)}`;
  let name = file.endsWith('-flowchart.png') ? `${base}-flowchart.png` : `${base}.png`;
  for (let i = 2; used.has(name); i += 1) name = `${base}-${i}.png`;
  used.add(name);
  return name;
}

/** "Step 3: Title", the text of a link to a step, in the export's language. */
function stepLinkText(target, ast) {
  const { t } = exportText(ast);
  return t('Step {number}: {title}', { number: target.number, title: target.title || t('Untitled step') });
}

/**
 * The text around a flowchart's list of step links: { before, after } of
 * "Go to: {links}" in the export's language.
 */
function goToParts(ast) {
  const { t } = exportText(ast);
  const [before, after = ''] = t('Go to: {links}').split('{links}');
  return { before, after };
}

/**
 * The steps a flowchart's shapes link to, as a line of step links to put
 * under its picture where a picture can't hold links (Word, Confluence):
 * '<p>Go to: <a href="step:…">Step 3: Title</a> · …</p>', or '' when none.
 */
function chartLinksHtml(chart, ast) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const seen = new Set();
  const links = (chart?.links || []).filter((link) => !seen.has(link.stepId) && seen.add(link.stepId)).map((link) => {
    const target = ast.steps.find((s) => s.stepId === link.stepId);
    return target ? `<a href="step:${esc(target.stepId)}" data-step-id="${esc(target.stepId)}">${esc(stepLinkText(target, ast))}</a>` : '';
  }).filter(Boolean);
  const { before, after } = goToParts(ast);
  return links.length ? `<p>${esc(before)}${links.join(' · ')}${esc(after)}</p>` : '';
}

/** Alt text for a step's flowchart block. */
function flowchartAlt(step, ast) {
  return flowchartAltText(step.number, step.title, ast && ast.language);
}

function stepBlocks(step) {
  return step.blocks || orderedBlocks(step);
}

/**
 * Split a step's blocks into the layout buckets exporters use around the
 * step title, description, and image. Text blocks and a flowchart block go
 * by their position, keeping their block-list ordering inside each bucket;
 * code/table blocks stay in `rest`.
 */
function stepContentGroups(step) {
  const all = stepBlocks(step);
  const groups = {
    beforeTitle: [],
    afterTitle: [],
    beforeDescription: [],
    afterDescription: [],
    beforeImage: [],
    afterImage: [],
    rest: [],
  };

  for (const block of all) {
    if (block.kind !== 'text' && block.kind !== 'flowchart') {
      groups.rest.push(block);
      continue;
    }

    switch (block.position) {
      case 'before-title':
        groups.beforeTitle.push(block);
        break;
      case 'after-title':
        groups.afterTitle.push(block);
        break;
      case 'before-image':
        groups.beforeImage.push(block);
        break;
      case 'after-image':
        groups.afterImage.push(block);
        break;
      case 'before-description':
        groups.beforeDescription.push(block);
        break;
      case 'after-description':
      default:
        groups.afterDescription.push(block);
        break;
    }
  }

  return groups;
}

function codeBlockText(block) {
  return blockText(block);
}

/**
 * Highlighted code (from core/code-highlight) as WordprocessingML runs for one
 * paragraph, a <w:br/> between lines. `size` is in half-points; 0 leaves it
 * to the paragraph style.
 */
function wordCodeRuns(hl, { size = 0 } = {}) {
  const font = '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
  return hl.lines.map((line, i) => {
    const runs = line.map((run) => {
      const rpr = [font, run.bold ? '<w:b/>' : '', run.italic ? '<w:i/>' : '', `<w:color w:val="${run.color.slice(1).toUpperCase()}"/>`,
        size ? `<w:sz w:val="${size}"/>` : ''].join('');
      return `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
    }).join('');
    return `${i ? '<w:r><w:br/></w:r>' : ''}${runs}`;
  }).join('');
}

/** Paragraph shading for a highlighted code block's background. */
const wordCodeShading = (hl) => `<w:shd w:val="clear" w:color="auto" w:fill="${hl.background.slice(1).toUpperCase()}"/>`;

// English callout names: GitHub alert keywords (> [!NOTE]) and the levels exporters know.
const LEVEL_LABEL = { info: 'Note', warn: 'Warning', error: 'Important', success: 'Tip' };

/** A callout's name ("Note", "Tip", ...) in the export's language; Note for an unknown level. */
function levelLabel(level, ast) {
  const { t } = exportText(ast);
  if (level === 'warn') return t('Warning');
  if (level === 'error') return t('Important');
  if (level === 'success') return t('Tip');
  return t('Note');
}

/** "Tip: Back up first" (or just "Tip"): a callout's name and its title. */
function calloutLabel(tb, ast) {
  const { t } = exportText(ast);
  const label = levelLabel(tb.level, ast);
  return tb.title ? t('{label}: {title}', { label, title: tb.title }) : label;
}

module.exports = {
  guideSlug,
  flowchartImageKey,
  flowchartAlt,
  chartLinksHtml,
  stepLinkText,
  goToParts,
  publishedImageName,
  imagesDirName,
  writeStepImages,
  renderAllImages,
  stepBlocks,
  stepContentGroups,
  codeBlockText,
  wordCodeRuns,
  wordCodeShading,
  LEVEL_LABEL,
  levelLabel,
  calloutLabel,
};
