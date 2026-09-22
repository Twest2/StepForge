'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeGif } = require('../core/gif');
const raster = require('../core/raster');
const text = require('../core/text-raster');
const { guideSlug, renderAllImages } = require('./common');
const { guideMetaLines } = require('./document-layout');

/**
 * Animated GIF exporter: an optional title card, then one frame per image
 * step with a caption bar (step number + title) and a thin progress line.
 */

const DEFAULT_TEMPLATE = {
  width: 960,
  frameDelayCs: 250,
  loop: 0,
  titleCard: true,
  titleOverlay: true,
  progressBar: true,
  accentColor: '#0068FF',
  background: '#F4F6F8',
};

const OPTION_INFO = {
  width: { label: 'Width', unit: 'px', min: 320, max: 1920, step: 10 },
  frameDelayCs: { label: 'Time per step', unit: 'seconds', scale: 100, min: 0.5, max: 30, step: 0.25 },
  loop: { hidden: true },
  titleCard: { label: 'Start with a title card' },
  titleOverlay: { label: 'Show step titles' },
  progressBar: { label: 'Show progress line' },
  accentColor: { label: 'Accent color', type: 'color' },
  background: { label: 'Background color', type: 'color' },
};

const INK = [24, 33, 43, 255];
const MUTED = [101, 113, 129, 255];
const WHITE = [255, 255, 255, 255];
const RULE = [217, 225, 232, 255];

function captionHeight(W) {
  return Math.round(Math.max(44, W * 0.058));
}

function drawTitleCard(W, H, ast, frameCount, accent, bg) {
  const card = raster.createImage(W, H, bg);
  const pad = Math.round(W * 0.08);
  const titleSize = Math.round(Math.max(22, Math.min(W * 0.05, H * 0.1)));
  const lines = text.wrapText(ast.guide.title || 'Untitled guide', titleSize, W - pad * 2, { weight: 'bold', maxLines: 3 });
  const lineH = titleSize * 1.2;
  const subSize = Math.round(titleSize * 0.42);
  const meta = [`${frameCount} step${frameCount === 1 ? '' : 's'}`, ...guideMetaLines(ast).map((l) => l.replace(/^[^:]+:\s*/, ''))].join('  ·  ');
  const blockH = lines.length * lineH + titleSize * 0.6 + subSize * 1.6;
  let y = Math.round((H - blockH) / 2);

  // Accent rule above the title, like the PDF cover.
  raster.fillRoundRect(card, pad, y - Math.round(titleSize * 0.7), Math.round(titleSize * 1.6), Math.max(3, Math.round(titleSize * 0.14)), 3, accent);
  for (const line of lines) {
    text.drawText(card, pad, y, line, titleSize, INK, { weight: 'bold' });
    y += lineH;
  }
  y += titleSize * 0.35;
  text.drawText(card, pad, y, text.fitText(meta, subSize, W - pad * 2), subSize, MUTED);
  return card;
}

function drawCaption(frame, y, h, step, accent) {
  const W = frame.width;
  raster.fillRect(frame, 0, y, W, h, WHITE);
  raster.fillRect(frame, 0, y, W, 1, RULE);
  const size = Math.round(h * 0.36);
  const badgeH = Math.round(h * 0.56);
  const numSize = Math.round(badgeH * 0.5);
  const num = String(step.number);
  const badgeW = Math.max(badgeH, Math.round(text.lineWidth(num, numSize, 'bold') + badgeH * 0.6));
  const pad = Math.round(h * 0.34);
  const by = y + Math.round((h - badgeH) / 2);
  raster.fillRoundRect(frame, pad, by, badgeW, badgeH, badgeH / 2, accent);
  text.drawTextCentered(frame, pad + badgeW / 2, by + badgeH / 2, num, numSize, WHITE, { weight: 'bold' });
  const tx = pad + badgeW + Math.round(h * 0.28);
  const title = text.fitText(step.title || 'Untitled step', size, W - tx - pad, { weight: 'bold' });
  text.drawTextCentered(frame, tx + text.lineWidth(title, size, 'bold') / 2, y + h / 2, title, size, INK, { weight: 'bold' });
}

function exportGifGuide(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const images = renderAllImages(ast);
  const stepsWithImages = ast.steps.filter((s) => images.has(s.stepId));
  if (!stepsWithImages.length) throw new Error('This guide has no screenshots to put in a GIF.');

  // Frame height derives from the median aspect ratio so most shots fit.
  const ratios = stepsWithImages.map((s) => {
    const img = images.get(s.stepId);
    return img.height / img.width;
  }).sort((a, b) => a - b);
  const ratio = ratios[Math.floor(ratios.length / 2)];
  const W = Math.round(Math.max(160, Math.min(4000, Number(tpl.width) || DEFAULT_TEMPLATE.width)));
  const capH = tpl.titleOverlay ? captionHeight(W) : 0;
  const progH = tpl.progressBar ? Math.max(3, Math.round(W / 240)) : 0;
  const shotH = Math.round(W * ratio);
  const H = shotH + capH + progH;
  const accent = raster.parseColor(tpl.accentColor, [0, 104, 255, 255]);
  const bg = raster.parseColor(tpl.background, [244, 246, 248, 255]);

  const frames = [];
  const delays = [];
  const stepDelay = Math.max(20, Number(tpl.frameDelayCs) || DEFAULT_TEMPLATE.frameDelayCs);

  if (tpl.titleCard) {
    frames.push(drawTitleCard(W, H, ast, stepsWithImages.length, accent, bg));
    delays.push(Math.max(150, Math.round(stepDelay * 0.8)));
  }

  stepsWithImages.forEach((step, i) => {
    const frame = raster.createImage(W, H, bg);
    const src = images.get(step.stepId);
    let dw = W, dh = Math.round((src.height / src.width) * W);
    if (dh > shotH) { dh = shotH; dw = Math.round((src.width / src.height) * shotH); }
    raster.drawImage(frame, raster.resize(src, dw, dh), Math.round((W - dw) / 2), Math.round((shotH - dh) / 2));
    if (tpl.titleOverlay) drawCaption(frame, shotH, capH, step, accent);
    if (tpl.progressBar) {
      raster.fillRect(frame, 0, H - progH, W, progH, RULE);
      raster.fillRect(frame, 0, H - progH, Math.round((W * (i + 1)) / stepsWithImages.length), progH, accent);
    }
    frames.push(frame);
    // Linger on the final step before the loop restarts.
    delays.push(i === stepsWithImages.length - 1 ? Math.round(stepDelay * 1.6) : stepDelay);
  });

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.gif`);
  fs.writeFileSync(file, encodeGif(frames, { delays, loop: tpl.loop }));
  return { file, frameCount: frames.length, width: W, height: H };
}

module.exports = { exportGifGuide, DEFAULT_TEMPLATE, OPTION_INFO };
