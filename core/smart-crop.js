'use strict';

/** Return a non-destructive focused view for a click in logical screen coordinates. */
function smartCrop(size, bounds, point) {
  if (!size || !bounds || !point ||
      ![size.width, size.height, bounds.x, bounds.y, bounds.width, bounds.height,
        point.x, point.y].every(Number.isFinite) ||
      size.width <= 0 || size.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (point.x - bounds.x) / bounds.width;
  const y = (point.y - bounds.y) / bounds.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  // Keep at least 640 x 360 logical pixels of context and keep at least two-thirds of each image dimension.
  const zoom = Math.max(1, Math.min(1.5, bounds.width / 640, bounds.height / 360));
  if (zoom === 1) return null;
  const span = 1 / zoom;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  return {
    enabled: true, zoom,
    panX: clamp((x - span / 2) / (1 - span)),
    // Focused view's vertical slider increases upward.
    panY: 1 - clamp((y - span / 2) / (1 - span)),
  };
}

module.exports = { smartCrop };
