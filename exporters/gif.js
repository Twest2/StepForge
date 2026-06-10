'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeGif } = require('../core/gif');
const raster = require('../core/raster');
const { guideSlug, renderAllImages } = require('./common');

/**
 * Animated GIF exporter: one frame per image step, optional title card,
 * optional title overlay and progress bar per frame.
 */

const DEFAULT_TEMPLATE = {
  width: 800,
  frameDelayCs: 220,
  loop: 0,
  titleCard: true,
  titleOverlay: true,
  progressBar: true,
  background: '#FFFFFF',
};

function exportGifGuide(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const images = renderAllImages(ast);
  const stepsWithImages = ast.steps.filter((s) => images.has(s.stepId));
  if (!stepsWithImages.length) throw new Error('gif export: guide has no image steps');

  // Frame height derives from the median aspect ratio so most shots fit.
  const ratios = stepsWithImages.map((s) => {
    const img = images.get(s.stepId);
    return img.height / img.width;
  }).sort((a, b) => a - b);
  const ratio = ratios[Math.floor(ratios.length / 2)];
  const W = tpl.width;
  const H = Math.round(W * ratio) + (tpl.titleOverlay ? 36 : 0) + (tpl.progressBar ? 8 : 0);
  const bg = raster.parseColor(tpl.background, [255, 255, 255, 255]);

  const frames = [];

  if (tpl.titleCard) {
    const card = raster.createImage(W, H, [31, 41, 55, 255]);
    raster.drawTextCentered(card, W / 2, H / 2 - 14, fitText(ast.guide.title, W, 22), 22, [255, 255, 255, 255]);
    raster.drawTextCentered(card, W / 2, H / 2 + 18, `${stepsWithImages.length} steps`, 12, [156, 163, 175, 255]);
    frames.push(card);
  }

  let n = 0;
  for (const step of stepsWithImages) {
    n += 1;
    const frame = raster.createImage(W, H, bg);
    const headerH = tpl.titleOverlay ? 36 : 0;
    const footerH = tpl.progressBar ? 8 : 0;
    const availH = H - headerH - footerH;

    const src = images.get(step.stepId);
    let dw = W, dh = Math.round((src.height / src.width) * W);
    if (dh > availH) { dh = availH; dw = Math.round((src.width / src.height) * availH); }
    const scaled = raster.resize(src, dw, dh);
    raster.drawImage(frame, scaled, Math.round((W - dw) / 2), headerH + Math.round((availH - dh) / 2));

    if (tpl.titleOverlay) {
      raster.fillRect(frame, 0, 0, W, headerH, [31, 41, 55, 255]);
      raster.drawText(frame, 10, 10, fitText(`${step.number}. ${step.title || ''}`, W - 20, 14), 14, [255, 255, 255, 255]);
    }
    if (tpl.progressBar) {
      raster.fillRect(frame, 0, H - footerH, W, footerH, [229, 231, 235, 255]);
      raster.fillRect(frame, 0, H - footerH, Math.round((W * n) / stepsWithImages.length), footerH, [37, 99, 235, 255]);
    }
    frames.push(frame);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.gif`);
  fs.writeFileSync(file, encodeGif(frames, { delayCs: tpl.frameDelayCs, loop: tpl.loop }));
  return { file, frameCount: frames.length, width: W, height: H };
}

function fitText(text, maxWidthPx, sizePx) {
  const scale = Math.max(1, Math.round(sizePx / 8));
  const maxChars = Math.max(4, Math.floor(maxWidthPx / (8 * scale)) - 1);
  const t = String(text);
  return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
}

module.exports = { exportGifGuide, DEFAULT_TEMPLATE };
