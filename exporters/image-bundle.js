'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
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
  includeGallery: true,
};

function statusLabel(step) {
  if (step.skipped) return 'Skipped';
  if (step.status === 'in-progress') return 'In progress';
  if (step.status === 'done') return 'Done';
  return 'Todo';
}

function renderGallery(ast, images) {
  const cards = ast.steps.map((step) => {
    const image = images.get(step.stepId);
    const title = `${step.number}. ${step.title || 'Untitled step'}`;
    return `<article class="step${step.skipped ? ' skipped' : ''}">
  <div class="step-head"><span class="number">${escapeHtml(step.number)}</span><h2>${escapeHtml(step.title || 'Untitled step')}</h2><span class="status">${escapeHtml(statusLabel(step))}</span></div>
  ${step.descriptionText ? `<p class="description">${escapeHtml(step.descriptionText)}</p>` : ''}
  ${image ? `<a href="${escapeHtml(image.relPath)}"><img src="${escapeHtml(image.relPath)}" alt="${escapeHtml(title)}"></a>` : '<p class="no-image">No screenshot was captured for this step.</p>'}
</article>`;
  }).join('\n');
  const meta = ast.guide.metadata || {};
  const metaLines = [meta.author && `Author: ${meta.author}`, meta.organization && meta.organization]
    .filter(Boolean)
    .map((line) => `<span>${escapeHtml(line)}</span>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ast.guide.title)} — StepForge image bundle</title>
<style>
:root{--accent:#2563eb;--ink:#172033;--muted:#61708a;--line:#dce4ef;--canvas:#f5f8fc}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.55 Aptos,"Segoe UI",Arial,sans-serif}.page{max-width:1120px;margin:auto;padding:32px 20px 56px}header,article{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 10px 32px #1520330d}header{padding:32px;margin-bottom:20px;border-top:5px solid var(--accent)}h1{font-size:clamp(2rem,5vw,3.25rem);line-height:1.08;margin:0 0 12px}.summary,.meta{color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.meta span,.status{border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:.82rem;background:#f8fbff}article{padding:24px;margin:16px 0}.step-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.number{color:var(--accent);font-weight:800}h2{font-size:1.3rem;margin:0}.status{margin-left:auto;color:var(--muted)}.description{margin:12px 0;color:#3d4b63}img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:12px;margin-top:16px}.no-image{color:var(--muted);font-style:italic}.skipped{opacity:.72}@media print{body{background:#fff}.page{max-width:none;padding:0}header,article{box-shadow:none;break-inside:avoid}}
</style></head><body><main class="page"><header><p class="summary">StepForge image bundle · ${escapeHtml(guideSummary(ast))}</p><h1>${escapeHtml(ast.guide.title)}</h1>${ast.guide.descriptionText ? `<p>${escapeHtml(ast.guide.descriptionText)}</p>` : ''}<div class="meta">${metaLines}</div></header>${cards}</main></body></html>\n`;
}

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
    guide: {
      title: ast.guide.title,
      descriptionHtml: ast.guide.descriptionHtml,
      descriptionText: ast.guide.descriptionText,
      metadata: ast.guide.metadata,
      generatedAt: ast.generatedAt,
      summary: guideSummary(ast),
    },
    toc: tocEntries(ast).map(({ number, title, depth, anchor }) => ({ number, title, depth, anchor })),
    steps: ast.steps.map((step) => ({
      number: step.number,
      depth: step.depth,
      title: step.title,
      status: step.status,
      skipped: Boolean(step.skipped),
      descriptionHtml: step.descriptionHtml,
      descriptionText: step.descriptionText,
      image: images.get(step.stepId)?.relPath || null,
    })),
  };
  const metaFile = path.join(outDir, `${guideSlug(ast)}-bundle.json`);
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  const galleryFile = tpl.includeGallery ? path.join(outDir, `${guideSlug(ast)}-gallery.html`) : null;
  if (galleryFile) fs.writeFileSync(galleryFile, renderGallery(ast, images));
  return { file: metaFile, galleryFile, imageCount: images.size };
}

module.exports = { exportImageBundle, DEFAULT_TEMPLATE };
