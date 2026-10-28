'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify, htmlToText } = require('../core/util');
const { guideSlug, renderAllImages } = require('./common');
const { tocEntries, guideSummary } = require('./document-layout');
const raster = require('../core/raster');
const text = require('../core/text-raster');
const { decodePng, encodePng } = require('../core/png');
const { zipSync } = require('../core/zip');
const { withBrand, brandRaster, overlayWatermark, hexToRgb } = require('./branding');

/**
 * Image bundle exporter: a folder with one annotated PNG per image step,
 * named in step order, plus an index.json describing the guide. Optionally
 * burns a caption (step number + title) under each image, overlays a
 * watermark (a chosen PNG, or the brand profile's logo when its watermark is
 * on), and packages the folder as a .zip.
 */

const DEFAULT_TEMPLATE = {
  captions: false,
  accentColor: '#2563EB',
  watermarkPath: '', // PNG overlaid bottom-right when set
  watermarkOpacity: 0.6,
  zip: false,
};

const OPTION_INFO = {
  captions: { label: 'Add step captions', hint: 'Adds the step number and title under each screenshot.' },
  accentColor: { label: 'Caption color', type: 'color', dependsOn: 'captions' },
  watermarkPath: { label: 'Watermark image', type: 'file', filters: ['png'], hint: 'A PNG placed in the bottom-right corner of every image.' },
  watermarkOpacity: { label: 'Watermark opacity', min: 0, max: 1, step: 0.05, dependsOn: 'watermarkPath' },
  zip: { label: 'Also create a .zip', hint: 'One file that is easy to share.' },
};

/** "2.1" -> "02.1" so files sort in step order. */
function fileNumber(number) {
  return String(number).split('.').map((part, i) => (i === 0 ? part.padStart(2, '0') : part)).join('.');
}

function addCaption(img, step, accent, ink = [24, 33, 43, 255]) {
  const W = img.width;
  const h = Math.round(Math.max(40, Math.min(96, W * 0.045)));
  const out = raster.createImage(W, img.height + h, [255, 255, 255, 255]);
  raster.drawImage(out, img, 0, 0);
  raster.fillRect(out, 0, img.height, W, 1, [217, 225, 232, 255]);
  const badgeH = Math.round(h * 0.56);
  const numSize = Math.round(badgeH * 0.5);
  const num = String(step.number);
  const badgeW = Math.max(badgeH, Math.round(text.lineWidth(num, numSize, 'bold') + badgeH * 0.6));
  const pad = Math.round(h * 0.34);
  const by = img.height + Math.round((h - badgeH) / 2);
  raster.fillRoundRect(out, pad, by, badgeW, badgeH, badgeH / 2, accent);
  text.drawTextCentered(out, pad + badgeW / 2, by + badgeH / 2, num, numSize, [255, 255, 255, 255], { weight: 'bold' });
  const size = Math.round(h * 0.36);
  const tx = pad + badgeW + Math.round(h * 0.28);
  const title = text.fitText(step.title || 'Untitled step', size, W - tx - pad, { weight: 'bold' });
  text.drawTextCentered(out, tx + text.lineWidth(title, size, 'bold') / 2, img.height + h / 2, title, size, ink, { weight: 'bold' });
  return out;
}

function exportImageBundle(ast, outDir, template = {}) {
  const tpl = withBrand('image-bundle', DEFAULT_TEMPLATE, ast, template);
  const brand = ast.branding;
  const name = `${guideSlug(ast)}-images`;
  const folder = path.join(outDir, name);
  fs.mkdirSync(folder, { recursive: true });
  // Clear images from an earlier export so renamed steps don't linger.
  for (const f of fs.readdirSync(folder)) if (/^step-.*\.png$/.test(f)) fs.rmSync(path.join(folder, f));

  // A watermark chosen in the Export dialog wins over the brand's.
  const chosen = tpl.watermarkPath && fs.existsSync(tpl.watermarkPath)
    ? decodePng(fs.readFileSync(tpl.watermarkPath))
    : null;
  const brandMark = !chosen && brand?.watermark.enabled ? brandRaster(brand.logo) : null;
  const mark = chosen || brandMark;
  const markStyle = chosen ? { position: 'bottom-right', opacity: tpl.watermarkOpacity } : brand?.watermark;
  const ink = brand ? [...hexToRgb(brand.colors.text), 255] : undefined;
  const accent = raster.parseColor(tpl.accentColor, [37, 99, 235, 255]);
  const rendered = renderAllImages(ast);
  const files = new Map();
  for (const step of ast.steps) {
    let img = rendered.get(step.stepId);
    if (!img) continue;
    if (mark) overlayWatermark(img, mark, markStyle);
    if (tpl.captions) img = addCaption(img, step, accent, ink);
    const fileName = `step-${fileNumber(step.number)}-${slugify(step.title || step.stepId, 'step')}.png`;
    fs.writeFileSync(path.join(folder, fileName), encodePng(img));
    files.set(step.stepId, { fileName, width: img.width, height: img.height });
  }

  const meta = {
    format: 'stepforge-image-bundle',
    version: 2,
    guide: {
      title: ast.guide.title,
      description: htmlToText(ast.guide.descriptionHtml || ''),
      generatedAt: ast.generatedAt,
      summary: guideSummary(ast),
    },
    toc: tocEntries(ast).map(({ number, title, depth, anchor }) => ({ number, title, depth, anchor })),
    steps: ast.steps.map((step) => ({
      number: step.number,
      title: step.title,
      description: htmlToText(step.descriptionHtml || ''),
      image: files.get(step.stepId)?.fileName || null,
      width: files.get(step.stepId)?.width || null,
      height: files.get(step.stepId)?.height || null,
    })),
  };
  const metaFile = path.join(folder, 'index.json');
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

  let zipFile = null;
  if (tpl.zip) {
    zipFile = path.join(outDir, `${name}.zip`);
    const entries = ['index.json', ...[...files.values()].map((f) => f.fileName)].sort().map((f) => ({ name: `${name}/${f}`, data: fs.readFileSync(path.join(folder, f)) }));
    fs.writeFileSync(zipFile, zipSync(entries));
  }
  return { file: metaFile, folder, zipFile, previewFile: folder, imageCount: files.size };
}

module.exports = { exportImageBundle, DEFAULT_TEMPLATE, OPTION_INFO };
