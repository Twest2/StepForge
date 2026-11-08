'use strict';
const flow = require('./flowchart');
const raster = require('./raster');
const text = require('./text-raster');

// Dependency-free synchronous fallback for headless callers. The export worker
// prepares the same SVG through the existing Sharp codec for system-font text.
function renderFlowchart(graph, steps = []) {
  const { graph: g, width, height } = flow.geometry(graph);
  const img = raster.createImage(width, height);
  const ink = [32, 32, 32, 255];
  for (const e of g.edges) {
    const points = flow.edgePoints(e, g.nodes), border = raster.parseColor(e.color || '#606060');
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (e.dashed) {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let d = 0; d < length; d += 12) { const end = Math.min(d + 7, length); raster.drawLine(img, a[0] + (b[0] - a[0]) * d / length, a[1] + (b[1] - a[1]) * d / length, a[0] + (b[0] - a[0]) * end / length, a[1] + (b[1] - a[1]) * end / length, border, 2); }
      } else raster.drawLine(img, ...a, ...b, border, 2);
    }
    const arrow = (tip, tail) => { const a = Math.atan2(tip[1] - tail[1], tip[0] - tail[0]); raster.fillPolygon(img, [tip, [tip[0] - 10 * Math.cos(a - .45), tip[1] - 10 * Math.sin(a - .45)], [tip[0] - 10 * Math.cos(a + .45), tip[1] - 10 * Math.sin(a + .45)]], border); };
    if (e.kind !== 'line') arrow(points.at(-1), points.at(-2));
    if (e.kind === 'double') arrow(points[0], points[1]);
    if (e.label) {
      const [x, y] = points[1];
      raster.fillRect(img, x - 55, y - 25, 110, 22, [255, 255, 255, 255]);
      raster.drawTextCentered(img, x, y - 15, text.fitText(e.label, 13, 105), 13, ink);
    }
  }
  for (const n of g.nodes) {
    const { width: w, height: h } = flow.nodeSize(n), style = flow.nodeStyle(n), outline = flow.nodeOutline(n);
    const border = raster.parseColor(style.stroke);
    if (n.type !== 'text') {
      raster.fillPolygon(img, outline.points, raster.parseColor(style.fill));
      raster.strokePolyline(img, [...outline.points, outline.points[0]], border, style.strokeWidth);
      for (const line of outline.lines) raster.strokePolyline(img, line, border, style.strokeWidth);
    }
    const maxChars = Math.max(5, Math.floor((w - 24) * (['decision', 'triangle'].includes(n.type) ? .6 : 1) / (style.fontSize * .55)));
    raster.drawTextCentered(img, n.x + w / 2, n.y + h / 2,
      flow.wrapLabel(flow.nodeLabel(n, steps), maxChars).slice(0, Math.max(1, Math.floor(h / (style.fontSize * 1.3)))).join('\n'), style.fontSize, raster.parseColor(style.textColor));
  }
  return img;
}
module.exports = { renderFlowchart };
