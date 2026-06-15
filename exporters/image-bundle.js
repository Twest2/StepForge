'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { guideSlug, writeStepImages } = require('./common');
const { tocEntries, guideSummary } = require('./document-layout');
const raster = require('../core/raster');
const { decodePng, encodePng } = require('../core/png');

/**
 * Image bundle exporter: one annotated PNG per image step plus a
 * metadata.json describing the guide, with an optional watermark overlay.
 */

const DEFAULT_TEMPLATE = {
  watermarkPath: '', // PNG overlaid bottom-right when set
  watermarkOpacity: 0.6,
};

function exportImageBundle(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = writeStepImages(ast, outDir);

  if (tpl.watermarkPath && fs.existsSync(tpl.watermarkPath)) {
    const mark = decodePng(fs.readFileSync(tpl.watermarkPath));
    const alpha = Math.round(255 * Math.max(0, Math.min(1, tpl.watermarkOpacity)));
    for (const { relPath } of images.values()) {
      const file = path.join(outDir, relPath);
      const img = decodePng(fs.readFileSync(file));
      const faded = raster.cloneImage(mark);
      for (let i = 3; i < faded.data.length; i += 4) {
        faded.data[i] = Math.round((faded.data[i] * alpha) / 255);
      }
      raster.drawImage(img, faded, Math.max(0, img.width - mark.width - 12), Math.max(0, img.height - mark.height - 12));
      fs.writeFileSync(file, encodePng(img));
    }
  }

  const meta = {
    format: 'stepforge-image-bundle',
    version: 1,
    guide: { title: ast.guide.title, generatedAt: ast.generatedAt, summary: guideSummary(ast) },
    toc: tocEntries(ast).map(({ number, title, depth, anchor }) => ({ number, title, depth, anchor })),
    steps: ast.steps.map((step) => ({
      number: step.number,
      title: step.title,
      image: images.get(step.stepId)?.relPath || null,
    })),
  };
  const metaFile = path.join(outDir, `${guideSlug(ast)}-bundle.json`);
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  return { file: metaFile, imageCount: images.size };
}

module.exports = { exportImageBundle, DEFAULT_TEMPLATE };
