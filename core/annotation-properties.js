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
  return { DEFAULT_COLORS, colors, recentColor, colorGroups, percentage, fontSizeFromPercent };
});
