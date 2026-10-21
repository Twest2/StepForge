'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify, escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { renderStepImage } = require('../core/renderast');
const { orderedBlocks, blockText } = require('../core/blocks');

/**
 * Shared exporter helpers: every image-bearing exporter renders annotated
 * step images through the same pipeline so output is consistent.
 */

function guideSlug(ast) {
  return slugify(ast.guide.title, 'guide');
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
    const fileName = `${String(n).padStart(3, '0')}-${slugify(step.title || step.stepId, step.stepId)}.png`;
    fs.writeFileSync(path.join(dir, fileName), encodePng(img));
    result.set(step.stepId, { relPath: `${dirName}/${fileName}`, width: img.width, height: img.height });
  }
  return result;
}

/** Render step images in-memory (for self-contained HTML, PDF, GIF...). */
function renderAllImages(ast) {
  const result = new Map();
  for (const step of ast.steps) {
    const img = renderStepImage(step);
    if (img) result.set(step.stepId, img);
  }
  return result;
}

function stepBlocks(step) {
  return step.blocks || orderedBlocks(step);
}

/**
 * Split a step's blocks into the layout buckets exporters use around the
 * step title, description, and image. Text blocks keep their block-list
 * ordering inside each bucket; code/table blocks stay in `rest`.
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
    if (block.kind !== 'text') {
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

const LEVEL_LABEL = { info: 'Note', warn: 'Warning', error: 'Important', success: 'Tip' };

module.exports = {
  guideSlug,
  imagesDirName,
  writeStepImages,
  renderAllImages,
  stepBlocks,
  stepContentGroups,
  codeBlockText,
  wordCodeRuns,
  wordCodeShading,
  LEVEL_LABEL,
};
