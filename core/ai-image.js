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
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (scale < 1) {
    img = resize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  }
  return encodePng(img);
}

module.exports = { AI_SCREENSHOT_MAX_EDGE, renderScreenshotForAi };
