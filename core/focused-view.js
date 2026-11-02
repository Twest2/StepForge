'use strict';

/**
 * The numbers behind the editor's Focused view controls
 * (app/renderer/editor.js). A step stores focusedView { enabled, zoom, panX,
 * panY }: zoom from 1 to 3, and pan as 0–1 fractions of the room the crop has
 * to move, with panY increasing upward (see core/raster.js applyFocusedView).
 * The editor shows pan as a whole percentage with 0% at the left and top
 * edges, so Pan Y is flipped here and nowhere else; stored guides keep their
 * format.
 */
(function attachFocusedView(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StepForgeFocusedView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 3;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  // Number('') is 0, so an emptied box must not read as 0.
  const toNumber = (value) => (value == null || String(value).trim() === '' ? NaN : Number(value));

  /** A typed or dragged zoom as stored: 1–3, to two decimals. NaN if it is not a number. */
  function zoomFromInput(value) {
    const n = toNumber(value);
    return Number.isFinite(n) ? Math.round(clamp(n, ZOOM_MIN, ZOOM_MAX) * 100) / 100 : NaN;
  }

  /** A stored zoom as the box shows it, e.g. "1.50". */
  function formatZoom(zoom) {
    return (Number.isFinite(zoom) ? clamp(zoom, ZOOM_MIN, ZOOM_MAX) : 1.5).toFixed(2);
  }

  /** A stored pan (0–1) as the whole percentage the editor shows. Pan Y counts from the top. */
  function panToPercent(pan, axis) {
    const n = Number.isFinite(pan) ? clamp(pan, 0, 1) : 0.5;
    return Math.round((axis === 'y' ? 1 - n : n) * 100);
  }

  /** A typed or dragged percentage as the stored pan (0–1). NaN if it is not a number. */
  function panFromPercent(value, axis) {
    const n = toNumber(value);
    if (!Number.isFinite(n)) return NaN;
    const percent = Math.round(clamp(n, 0, 100));
    return (axis === 'y' ? 100 - percent : percent) / 100;
  }

  return {
    ZOOM_MIN, ZOOM_MAX, zoomFromInput, formatZoom, panToPercent, panFromPercent,
  };
});
