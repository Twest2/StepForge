'use strict';

const fs = require('node:fs');
const { decodePng, encodePng } = require('./png');
const { renderAnnotations, resize } = require('./raster');

// Models gain nothing from a 4K screenshot, and every pixel costs request
// size and inference time, so the long edge is capped at this many pixels.
const AI_SCREENSHOT_MAX_EDGE = 1600;

/**
 * The screenshot an AI model is shown for a step: the working image with every
 * annotation burned in, exactly as exports draw it. Blurs are filled first, so
 * a model never sees what the user hid, and the click marker shows where the
 * user clicked. Returns a PNG buffer, or null when there is no readable image.
 */
function renderScreenshotForAi(imagePath, annotations = [], { maxEdge = AI_SCREENSHOT_MAX_EDGE } = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  let img = renderAnnotations(decodePng(fs.readFileSync(imagePath)), annotations || []);
  const target = aiScreenshotSize(img, { maxEdge });
  if (target.width !== img.width) img = resize(img, target.width, target.height);
  return encodePng(img);
}

/** Size of the screenshot AI is shown for an image of `size`: the long edge capped at maxEdge. */
function aiScreenshotSize(size, { maxEdge = AI_SCREENSHOT_MAX_EDGE } = {}) {
  const scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
  return scale < 1
    ? { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
    : { width: size.width, height: size.height };
}

module.exports = { AI_SCREENSHOT_MAX_EDGE, renderScreenshotForAi, aiScreenshotSize };
