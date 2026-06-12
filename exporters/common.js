'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify } = require('../core/util');
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

function codeBlockText(block) {
  return blockText(block);
}

const LEVEL_LABEL = { info: 'Note', warn: 'Warning', error: 'Important', success: 'Tip' };

module.exports = {
  guideSlug,
  imagesDirName,
  writeStepImages,
  renderAllImages,
  stepBlocks,
  codeBlockText,
  LEVEL_LABEL,
};
