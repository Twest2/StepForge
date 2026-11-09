'use strict';

const { pointInBounds } = require('./click-frames');
const { t } = require('../core/ui-text');

/**
 * Coordinate-space conversion between physical (OS event) pixels and
 * Electron DIP points.
 *
 * Why this exists: OS-level click hooks report *physical* pixels (the X11
 * root window space on Linux, virtual-screen pixels on Windows), while
 * everything Electron-side — display bounds, cursor reads, the click-marker
 * math in storeFrameAsStep — is in DIP. Mixing the two spaces is exactly the
 * bug that makes the red marker drift on scaled displays: at 150% scaling a
 * physical click at (1500, 900) is the DIP point (1000, 600), and a marker
 * drawn at the physical values lands well below-right of the real click.
 *
 * On Windows, Electron exposes screen.screenToDipPoint() and the capture
 * service prefers it. On Linux/X11 there is no such API, so we reconstruct
 * the mapping from display geometry: each display's DIP bounds plus its
 * scaleFactor give its physical rectangle, and a physical point inside that
 * rectangle maps back linearly. With mixed-DPI multi-monitor X11 setups the
 * origin reconstruction is an approximation (X11 itself has a single global
 * coordinate space), but it is exact for the overwhelmingly common cases:
 * single display at any scale, and multi-display with a uniform scale.
 */

/**
 * Physical-pixel rectangle a display occupies: `physicalBounds` when the
 * caller has the real one (Windows, screen.dipToScreenRect), else derived
 * from DIP bounds. The derivation scales the origin too, which is wrong for
 * a scaled display beside the primary on Windows: Chromium keeps such a
 * display's DIP origin at its physical edge, not at that edge times the scale.
 */
function physicalBoundsOf(display) {
  const real = display && display.physicalBounds;
  if (real && [real.x, real.y, real.width, real.height].every(Number.isFinite) && real.width > 0 && real.height > 0) {
    return { x: real.x, y: real.y, width: real.width, height: real.height };
  }
  const bounds = display && display.bounds;
  if (!bounds) return null;
  const scale = display.scaleFactor || 1;
  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.round(bounds.width * scale),
    height: Math.round(bounds.height * scale),
  };
}

function centerDistanceSq(point, rect) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return (point.x - cx) ** 2 + (point.y - cy) ** 2;
}

/**
 * Display whose physical rectangle contains the point, or the nearest one
 * (clicks on the very edge of a screen can round to one pixel outside it).
 */
function displayForPhysicalPoint(point, displays) {
  if (!point || !Array.isArray(displays) || !displays.length) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const display of displays) {
    const phys = physicalBoundsOf(display);
    if (!phys) continue;
    if (pointInBounds(point, phys)) return display;
    const dist = centerDistanceSq(point, phys);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = display;
    }
  }
  return nearest;
}

/**
 * Convert a physical-pixel point (OS click hook) to DIP. Returns null when
 * no display geometry is available — the caller should then fall back to a
 * live cursor read rather than guessing.
 */
function physicalToDip(point, displays) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const display = displayForPhysicalPoint(point, displays);
  if (!display) return null;
  const phys = physicalBoundsOf(display);
  const scale = display.scaleFactor || 1;
  return {
    x: display.bounds.x + (point.x - phys.x) / scale,
    y: display.bounds.y + (point.y - phys.y) / scale,
  };
}

/**
 * Display whose DIP bounds contain the point, or the nearest one. Used to
 * route a click to the capture stream of the monitor it landed on.
 */
function displayForDipPoint(point, displays) {
  if (!point || !Array.isArray(displays) || !displays.length) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const display of displays) {
    if (!display || !display.bounds) continue;
    if (pointInBounds(point, display.bounds)) return display;
    const dist = centerDistanceSq(point, display.bounds);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = display;
    }
  }
  return nearest;
}

/**
 * A physical-pixel window rectangle ({ left, top, right, bottom }) in DIP,
 * placed relative to an anchor point known in both spaces: the click, so the
 * window and the click marker go through the same conversion. `scale` is the
 * anchor display's scale factor. Within one display the mapping is linear;
 * parts of the window on other displays are cut away by cropGeometry.
 */
function physicalRectToDip(rect, anchorPhysical, anchorDip, scale = 1) {
  if (!rect || !anchorPhysical || !anchorDip) return null;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const out = {
    x: anchorDip.x + (rect.left - anchorPhysical.x) / s,
    y: anchorDip.y + (rect.top - anchorPhysical.y) / s,
    width: (rect.right - rect.left) / s,
    height: (rect.bottom - rect.top) / s,
  };
  if (!Object.values(out).every(Number.isFinite) || out.width <= 0 || out.height <= 0) return null;
  return out;
}

/**
 * Where a DIP rectangle falls in a frame of one display: its part on that
 * display (`bounds`, DIP) and the matching pixels of the frame image.
 * Throws when the rectangle is not on the display at all.
 */
function cropGeometry(bounds, rect, size) {
  const x = Math.max(bounds.x, rect.x);
  const y = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
  if (right <= x || bottom <= y) throw new Error(t('The selected area is outside the shared monitor.'));
  const sx = size.width / bounds.width;
  const sy = size.height / bounds.height;
  const px = Math.round((x - bounds.x) * sx);
  const py = Math.round((y - bounds.y) * sy);
  return {
    bounds: { x, y, width: right - x, height: bottom - y },
    pixels: { x: px, y: py, width: Math.round((right - bounds.x) * sx) - px,
      height: Math.round((bottom - bounds.y) * sy) - py },
  };
}

module.exports = {
  physicalBoundsOf,
  displayForPhysicalPoint,
  displayForDipPoint,
  physicalToDip,
  physicalRectToDip,
  cropGeometry,
  pointInBounds,
};
