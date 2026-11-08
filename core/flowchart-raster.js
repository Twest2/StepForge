'use strict';
const flow = require('./flowchart');
const raster = require('./raster');
const text = require('./text-raster');

// Dependency-free synchronous fallback for headless callers. The export worker
// prepares the same SVG through the existing Sharp codec for system-font text.
function renderFlowchart(graph, steps = []) {
  const { graph: g, width, height } = flow.geometry(graph);
  const img = raster.createImage(width, height);
  const ink = [23, 32, 51, 255], border = [100, 116, 139, 255];
  for (const e of g.edges) {
    const points = flow.edgePoints(e, g.nodes);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (i === points.length - 1) raster.drawArrow(img, ...a, ...b, border, 2);
      else raster.drawLine(img, ...a, ...b, border, 2);
    }
    if (e.label) {
      const [x, y] = points[1];
      raster.fillRect(img, x - 55, y - 25, 110, 22, [255, 255, 255, 255]);
      raster.drawTextCentered(img, x, y - 15, text.fitText(e.label, 13, 105), 13, ink);
    }
  }
  for (const n of g.nodes) {
    const x = n.x, y = n.y, w = flow.WIDTH, h = flow.HEIGHT;
    if (n.type === 'decision') {
      const p = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
      raster.fillPolygon(img, p, [239, 246, 255, 255]);
      for (let i = 0; i < 4; i++) raster.drawLine(img, ...p[i], ...p[(i + 1) % 4], border, 2);
    } else {
      raster.fillRoundRect(img, x, y, w, h, ['start', 'end'].includes(n.type) ? 40 : 8, [255, 255, 255, 255]);
      raster.strokeRect(img, x, y, w, h, border, 1.5);
    }
    raster.drawTextCentered(img, x + w / 2, y + h / 2,
      flow.wrapLabel(flow.nodeLabel(n, steps), n.type === 'decision' ? 19 : 27).join('\n'), 14, ink);
  }
  return img;
}
module.exports = { renderFlowchart };
