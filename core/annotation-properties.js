(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StepForgeAnnotationProperties = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const DEFAULT_COLORS = ['#FFE066', '#E5484D', '#1F6FEB', '#10B981', '#111827', '#FFFFFF'];
  function colors(values, limit = 12) {
    return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)).map(value => value.toUpperCase()))].slice(0, limit);
  }
  function recentColor(recent, value) { return colors([value, ...colors(recent)]); }
  function colorGroups(recent, brand) {
    const used = new Set(DEFAULT_COLORS);
    const unique = values => colors(values).filter(color => { if (used.has(color)) return false; used.add(color); return true; });
    return { defaults: [...DEFAULT_COLORS], recent: unique(recent), brand: unique(brand) };
  }
  function percentage(value) { return Number.isFinite(value) ? Number((value * 100).toFixed(2)) : 0; }
  function fontSizeFromPercent(value) {
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 100 ? number / 100 : null;
  }
  // Spotlights (see SPOTLIGHT_DEFAULTS in core/schema.js). All spotlights on a
  // step share one dark overlay, as dark as the darkest of them, with every
  // spotlight cut out of it. The editor canvas and core/raster.js both draw
  // them from spotlightAreas(), so the editor matches every export.
  const SPOTLIGHT_DARKNESS = 0.55;
  const SPOTLIGHT_CORNER_RADIUS = 8;
  function spotlightDarkness(style) {
    const value = Number(style && style.darkness);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : SPOTLIGHT_DARKNESS;
  }
  /**
   * The step's spotlights as areas in pixels, and the overlay's darkness.
   * toPx(ann) gives { x, y, w, h } in pixels; radiusScale turns a corner radius
   * on a 1000px-wide image into pixels. null when the step has no spotlight.
   */
  function spotlightAreas(annotations, toPx, radiusScale) {
    const spots = (Array.isArray(annotations) ? annotations : []).filter(ann => ann && ann.type === 'spotlight');
    if (!spots.length) return null;
    const areas = spots.map(ann => {
      const r = toPx(ann);
      const x = Math.min(r.x, r.x + r.w), y = Math.min(r.y, r.y + r.h), w = Math.abs(r.w), h = Math.abs(r.h);
      const style = ann.style || {};
      const oval = style.shape === 'oval';
      const radius = Number.isFinite(style.cornerRadius) ? Math.max(0, style.cornerRadius) : SPOTLIGHT_CORNER_RADIUS;
      return { x, y, w, h, oval, radius: oval ? 0 : Math.min(radius * radiusScale, w / 2, h / 2) };
    });
    return { areas, darkness: Math.max(...spots.map(ann => spotlightDarkness(ann.style))) };
  }
  return {
    DEFAULT_COLORS, colors, recentColor, colorGroups, percentage, fontSizeFromPercent,
    SPOTLIGHT_DARKNESS, SPOTLIGHT_CORNER_RADIUS, spotlightDarkness, spotlightAreas,
  };
});
