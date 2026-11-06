'use strict';

/**
 * Geometry for the pen and curved arrow annotations, shared by the editor
 * canvas (app/renderer/canvas.js) and the export rasterizer (core/raster.js)
 * so both draw the same strokes.
 *
 * A pen stroke stores `points`: [[fx, fy], ...] as fractions of its own box
 * (x, y, w, h), so moving or resizing the box moves and scales the stroke.
 * The points are drawn as a smooth curve through their midpoints.
 *
 * A curved arrow runs from (x, y) to (x + w, y + h) like an arrow, bent by
 * `bend`: [along, across], where its control point sits as fractions of the
 * start-to-end line (along it, and to its side). Being relative to the
 * line, the bend follows when the ends move. The head points along the
 * curve's end and is the straight arrow's head.
 */
(function attachAnnotationShapes(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StepForgeAnnotationShapes = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // A gentle bend: the control point halfway along, a third of the length to
  // the side (above a left-to-right arrow).
  const DEFAULT_BEND = [0.5, -0.3];
  const MAX_PEN_POINTS = 2000;
  const BEND_LIMIT = 5;

  const round4 = (v) => Math.round(v * 1e4) / 1e4;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** A stored bend as [along, across], or the default when missing or invalid. */
  function bendOf(bend) {
    if (Array.isArray(bend) && bend.length === 2 && bend.every(Number.isFinite)) {
      return [clamp(bend[0], -BEND_LIMIT, BEND_LIMIT), clamp(bend[1], -BEND_LIMIT, BEND_LIMIT)];
    }
    return [...DEFAULT_BEND];
  }

  /** The control point of a curve from (x0, y0) to (x1, y1) with this bend. */
  function controlPoint(x0, y0, x1, y1, bend) {
    const [a, b] = bendOf(bend);
    const dx = x1 - x0, dy = y1 - y0;
    return { x: x0 + a * dx - b * dy, y: y0 + a * dy + b * dx };
  }

  /** The bend that puts the control point at (cx, cy). */
  function bendFromControl(x0, y0, x1, y1, cx, cy) {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return [...DEFAULT_BEND];
    const rx = cx - x0, ry = cy - y0;
    return bendOf([round4((rx * dx + ry * dy) / len2), round4((ry * dx - rx * dy) / len2)]);
  }

  function quadPoint(p0, c, p1, t) {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
  }

  /** The point on the curve halfway along it, where the editor shows the bend handle. */
  function curveMidpoint(x0, y0, x1, y1, bend) {
    return quadPoint({ x: x0, y: y0 }, controlPoint(x0, y0, x1, y1, bend), { x: x1, y: y1 }, 0.5);
  }

  /** The bend whose curve passes through (mx, my) halfway along. */
  function bendThrough(x0, y0, x1, y1, mx, my) {
    return bendFromControl(x0, y0, x1, y1, 2 * mx - (x0 + x1) / 2, 2 * my - (y0 + y1) / 2);
  }

  function flattenQuad(p0, c, p1, out, steps) {
    for (let i = 1; i <= steps; i++) out.push(quadPoint(p0, c, p1, i / steps));
  }

  /**
   * A curved arrow in pixels: the shaft (a quadratic curve that stops where
   * the head starts) and the head triangle. `thickness` is the stroke width,
   * sized like the straight arrow's head.
   */
  function curvedArrowGeometry(x0, y0, x1, y1, bend, thickness) {
    const p0 = { x: x0, y: y0 }, p1 = { x: x1, y: y1 };
    const c = controlPoint(x0, y0, x1, y1, bend);
    const line = [p0];
    flattenQuad(p0, c, p1, line, 32);
    let length = 0;
    for (let i = 1; i < line.length; i++) length += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    length = length || 1;
    const head = Math.min(length * 0.4, Math.max(10, thickness * 4));
    // Where the curve comes within the head's length of its end.
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const q = quadPoint(p0, c, p1, mid);
      if (Math.hypot(p1.x - q.x, p1.y - q.y) > head) lo = mid; else hi = mid;
    }
    const t = lo;
    const base = quadPoint(p0, c, p1, t);
    // The curve from 0 to t has control point lerp(p0, c, t).
    const shaft = { x0, y0, cx: x0 + (c.x - x0) * t, cy: y0 + (c.y - y0) * t, x1: base.x, y1: base.y };
    const dist = Math.hypot(p1.x - base.x, p1.y - base.y) || 1;
    const ux = (p1.x - base.x) / dist, uy = (p1.y - base.y) / dist;
    const bx = x1 - ux * head, by = y1 - uy * head;
    const wing = head * 0.5;
    return {
      control: c,
      shaft,
      head: [[x1, y1], [bx - uy * wing, by + ux * wing], [bx + uy * wing, by - ux * wing]],
    };
  }

  /** The shaft of a curved arrow as a polyline [[x, y], ...]. */
  function shaftPolyline(shaft, steps = 32) {
    const p0 = { x: shaft.x0, y: shaft.y0 };
    const out = [p0];
    flattenQuad(p0, { x: shaft.cx, y: shaft.cy }, { x: shaft.x1, y: shaft.y1 }, out, steps);
    return out.map((p) => [p.x, p.y]);
  }

  /** A pen's points in pixels, from its box (x, y, w, h in pixels). */
  function penPoints(points, x, y, w, h) {
    return (Array.isArray(points) ? points : []).map(([fx, fy]) => [x + fx * w, y + fy * h]);
  }

  /**
   * The smoothed pen path as segments: { type: 'move' | 'quad' | 'line', ... }
   * Each point is a control point, the curve passing through the midpoints
   * between them; the first and last points are kept.
   */
  function penPath(pts) {
    if (!pts.length) return [];
    const path = [{ type: 'move', x: pts[0][0], y: pts[0][1] }];
    if (pts.length === 1) return [...path, { type: 'line', x: pts[0][0], y: pts[0][1] }];
    for (let i = 1; i < pts.length - 1; i++) {
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[i + 1];
      path.push({ type: 'quad', cx, cy, x: (cx + nx) / 2, y: (cy + ny) / 2 });
    }
    const last = pts[pts.length - 1];
    path.push({ type: 'line', x: last[0], y: last[1] });
    return path;
  }

  /** The smoothed pen path as a polyline [[x, y], ...], for drawing pixels and hit testing. */
  function penPolyline(pts) {
    const out = [];
    let cur = null;
    for (const seg of penPath(pts)) {
      if (seg.type === 'move') { cur = { x: seg.x, y: seg.y }; out.push([seg.x, seg.y]); continue; }
      if (seg.type === 'line') { cur = { x: seg.x, y: seg.y }; out.push([seg.x, seg.y]); continue; }
      const end = { x: seg.x, y: seg.y };
      const steps = Math.max(2, Math.min(16, Math.ceil(Math.hypot(end.x - cur.x, end.y - cur.y) / 3)));
      const tmp = [];
      flattenQuad(cur, { x: seg.cx, y: seg.cy }, end, tmp, steps);
      for (const p of tmp) out.push([p.x, p.y]);
      cur = end;
    }
    return out;
  }

  function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
    return Math.hypot(ax + u * dx - px, ay + u * dy - py);
  }

  /** The shortest distance from (px, py) to a polyline. */
  function polylineDistance(px, py, line) {
    if (!line.length) return Infinity;
    if (line.length === 1) return Math.hypot(px - line[0][0], py - line[0][1]);
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      best = Math.min(best, segmentDistance(px, py, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
    }
    return best;
  }

  function simplifyRun(pts, first, last, tolerance, keep) {
    let worst = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(pts[i][0], pts[i][1], pts[first][0], pts[first][1], pts[last][0], pts[last][1]);
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > tolerance) {
      keep[index] = true;
      simplifyRun(pts, first, index, tolerance, keep);
      simplifyRun(pts, index, last, tolerance, keep);
    }
  }

  /**
   * Fewer points for a stroke drawn in pixels: drops points closer than
   * `minDistance` to the last one kept, then points within `tolerance` of the
   * line through their neighbours. The first and last points stay.
   */
  function simplifyStroke(pts, { minDistance = 3, tolerance = 0.75 } = {}) {
    if (pts.length <= 2) return pts.map((p) => [...p]);
    const spaced = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = spaced[spaced.length - 1];
      if (Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]) >= minDistance) spaced.push(pts[i]);
    }
    spaced.push(pts[pts.length - 1]);
    const keep = spaced.map((_, i) => i === 0 || i === spaced.length - 1);
    simplifyRun(spaced, 0, spaced.length - 1, tolerance, keep);
    return spaced.filter((_, i) => keep[i]).map((p) => [...p]);
  }

  /**
   * A pen annotation's box and points from a stroke in image fractions:
   * { x, y, w, h, points } with the points as fractions of the box.
   */
  function penFromStroke(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    const points = pts.map(([px, py]) => [round4(w > 0 ? (px - x) / w : 0), round4(h > 0 ? (py - y) / h : 0)]);
    return { x, y, w, h, points };
  }

  /** Stored pen points: finite [fx, fy] pairs, rounded, at most MAX_PEN_POINTS. */
  function normalizePenPoints(points) {
    if (!Array.isArray(points)) return [];
    return points
      .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      .slice(0, MAX_PEN_POINTS)
      .map(([fx, fy]) => [round4(fx), round4(fy)]);
  }

  return {
    DEFAULT_BEND, MAX_PEN_POINTS,
    bendOf, controlPoint, bendFromControl, curveMidpoint, bendThrough,
    curvedArrowGeometry, shaftPolyline,
    penPoints, penPath, penPolyline, polylineDistance, simplifyStroke, penFromStroke, normalizePenPoints,
  };
});
