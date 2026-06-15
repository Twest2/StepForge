'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { guideSlug, writeStepImages, stepBlocks, codeBlockText } = require('./common');
const { tocEntries, guideSummary } = require('./document-layout');

/**
 * JSON exporter: structured guide + steps, annotated screenshots written to
 * a sidecar steps-<title>/ folder, image paths relative to the JSON file.
 */

const DEFAULT_TEMPLATE = {
  pretty: true,
  includeImages: true,
  includeAnnotations: true,
};

function exportJson(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? writeStepImages(ast, outDir) : new Map();

  const doc = {
    format: 'stepforge-guide',
    version: 1,
    generatedAt: ast.generatedAt,
    guide: {
      title: ast.guide.title,
      descriptionHtml: ast.guide.descriptionHtml,
      createdAt: ast.guide.createdAt,
      updatedAt: ast.guide.updatedAt,
      summary: guideSummary(ast),
    },
    toc: tocEntries(ast).map(({ number, title, depth, anchor }) => ({ number, title, depth, anchor })),
    steps: ast.steps.map((step) => ({
      number: step.number,
      kind: step.kind,
      status: step.status,
      title: step.title,
      descriptionHtml: step.descriptionHtml,
      descriptionText: step.descriptionText,
      image: images.has(step.stepId) ? images.get(step.stepId) : null,
      annotations: tpl.includeAnnotations ? step.annotations : undefined,
      textBlocks: step.textBlocks.map((tb) => ({
        position: tb.position, level: tb.level, title: tb.title, descriptionHtml: tb.descriptionHtml,
      })),
      codeBlocks: step.codeBlocks.map((cb) => ({ ...cb, code: codeBlockText(cb) })),
      tableBlocks: step.tableBlocks,
      blocks: stepBlocks(step).map((block) => (
        block.kind === 'text'
          ? { ...block }
          : block.kind === 'code'
            ? { ...block, code: codeBlockText(block) }
            : { ...block }
      )),
      links: step.links,
    })),
  };

  const file = path.join(outDir, `${guideSlug(ast)}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, tpl.pretty ? 2 : 0) + '\n');
  return { file, imageCount: images.size };
}

module.exports = { exportJson, DEFAULT_TEMPLATE };
