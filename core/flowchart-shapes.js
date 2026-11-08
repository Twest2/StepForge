'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StepForgeFlowchartShapes = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const TYPES = ['step', 'rounded', 'ellipse', 'decision', 'parallelogram', 'hexagon', 'triangle', 'cylinder', 'document', 'note', 'cloud', 'text', 'start', 'end'];
  const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const nodeSize = n => ({ width: clamp(n.width, 60, 600, 220), height: clamp(n.height, 40, 400, 100) });
  const nodeStyle = n => ({ fill: color(n.style?.fill, '#ffffff'), stroke: color(n.style?.stroke, '#606060'),
    textColor: color(n.style?.textColor, '#202020'), strokeWidth: clamp(n.style?.strokeWidth, 0.5, 6, 1.5), fontSize: clamp(n.style?.fontSize, 10, 32, 14) });

  // Geometry is shared by the editor, SVG and the synchronous raster fallback.
  function nodeOutline(n) {
    const { width: w, height: h } = nodeSize(n), x = n.x, y = n.y;
    const points = [], lines = [];
    const arc = (cx, cy, rx, ry, start, end, count = 16) => {
      for (let i = 0; i <= count; i++) { const a = start + (end - start) * i / count; points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    };
    const shape = n.type;
    if (shape === 'ellipse') arc(w / 2, h / 2, w / 2, h / 2, 0, Math.PI * 2, 64);
    else if (shape === 'decision') points.push([w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]);
    else if (shape === 'parallelogram') points.push([w * .18, 0], [w, 0], [w * .82, h], [0, h]);
    else if (shape === 'hexagon') points.push([w * .18, 0], [w * .82, 0], [w, h / 2], [w * .82, h], [w * .18, h], [0, h / 2]);
    else if (shape === 'triangle') points.push([w / 2, 0], [w, h], [0, h]);
    else if (shape === 'note') {
      const fold = Math.min(24, w / 5, h / 3);
      points.push([0, 0], [w - fold, 0], [w, fold], [w, h], [0, h]);
      lines.push([[w - fold, 0], [w - fold, fold], [w, fold]]);
    } else if (shape === 'document') {
      points.push([0, 0], [w, 0], [w, h * .86]);
      for (let i = 0; i <= 32; i++) { const px = w * (1 - i / 32); points.push([px, h * .86 + Math.sin(px / w * Math.PI * 2) * h * .1]); }
    } else if (shape === 'cylinder') {
      arc(w / 2, h * .14, w / 2, h * .14, Math.PI, Math.PI * 2, 24);
      points.push([w, h * .86]); arc(w / 2, h * .86, w / 2, h * .14, 0, Math.PI, 24);
      const top = [];
      for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI; top.push([w / 2 + w / 2 * Math.cos(a), h * .14 + h * .14 * Math.sin(a)]); }
      lines.push(top);
    } else if (shape === 'cloud') {
      for (let i = 0; i < 96; i++) { const a = i / 96 * Math.PI * 2, r = .89 + .11 * Math.cos(a * 8); points.push([w / 2 + w / 2 * r * Math.cos(a), h / 2 + h / 2 * r * Math.sin(a)]); }
    } else if (['rounded', 'start', 'end'].includes(shape)) {
      const r = shape === 'rounded' ? Math.min(14, w / 5, h / 5) : Math.min(w, h) / 2;
      arc(w - r, r, r, r, -Math.PI / 2, 0, 12); arc(w - r, h - r, r, r, 0, Math.PI / 2, 12);
      arc(r, h - r, r, r, Math.PI / 2, Math.PI, 12); arc(r, r, r, r, Math.PI, Math.PI * 1.5, 12);
    } else points.push([0, 0], [w, 0], [w, h], [0, h]);
    return { points: points.map(([px, py]) => [x + px, y + py]), lines: lines.map(line => line.map(([px, py]) => [x + px, y + py])) };
  }

  function anchor(n, dx, dy) {
    const { width, height } = nodeSize(n), cx = n.x + width / 2, cy = n.y + height / 2;
    const { points } = nodeOutline(n);
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], sx = b[0] - a[0], sy = b[1] - a[1];
      const den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-8) continue;
      const ax = a[0] - cx, ay = a[1] - cy;
      const t = (ax * sy - ay * sx) / den, u = (ax * dy - ay * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return Number.isFinite(best) ? [cx + best * dx, cy + best * dy] : [cx, cy];
  }
  return { TYPES, nodeSize, nodeStyle, nodeOutline, anchor, color };
});
