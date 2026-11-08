'use strict';

/**
 * Flowcharts: a step can carry one flowchart, stored as plain graph data
 * (`step.flowchart`). The editor and every exporter draw it through toSvg(),
 * so what the author sees is what the export shows.
 *
 *   { nodes: [{ id, shape, label, x, y, stepId }], edges: [{ id, from, to, label }] }
 *
 * shape is 'process' (box), 'decision' (diamond) or 'terminal' (start/end
 * pill). x/y are the node's top-left corner. stepId optionally links a node
 * to a step in the guide; its current number is shown under the label.
 *
 * `step.flowchartPlacement` says where exports put it: 'visual' replaces the
 * screenshot, 'block' adds it after the step's other content.
 *
 * Loaded by Node (exporters, AI, MCP) and by the renderer as a plain script.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StepForgeFlowchart = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const SHAPES = ['process', 'decision', 'terminal'];
  const PLACEMENTS = ['visual', 'block'];
  const MAX_NODES = 200;
  const MAX_EDGES = 400;
  const MAX_COORD = 20000;
  const GRID = 20;
  const FONT_SIZE = 14;
  const LINE_HEIGHT = 18;
  const FONT_FAMILY = "'Segoe UI', 'Noto Sans', Arial, sans-serif";
  const WIDTH = { process: 180, decision: 200, terminal: 160 };
  const COLORS = {
    process: { fill: '#eef4ff', stroke: '#2563eb' },
    decision: { fill: '#fff7e6', stroke: '#d97706' },
    terminal: { fill: '#ecfdf3', stroke: '#16a34a' },
    edge: '#475569',
    text: '#111827',
    muted: '#475569',
  };

  const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max);
  const num = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_COORD, Math.round(v))) : fallback);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let counter = 0;
  const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** A clean copy of a stored or AI-written graph, or null when there is none. */
  function normalizeFlowchart(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
    const ids = new Set();
    const nodes = [];
    for (const [i, n] of raw.nodes.slice(0, MAX_NODES).entries()) {
      if (!n || typeof n !== 'object') continue;
      const id = idOk(n.id) && !ids.has(n.id) ? n.id : newId('node');
      ids.add(id);
      nodes.push({
        id,
        shape: SHAPES.includes(n.shape) ? n.shape : 'process',
        label: clean(n.label, 300),
        x: num(n.x, 40),
        y: num(n.y, 40 + i * 100),
        stepId: idOk(n.stepId) ? n.stepId : null,
      });
    }
    const edgeIds = new Set();
    const edges = [];
    for (const e of (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_EDGES)) {
      if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
      const id = idOk(e.id) && !edgeIds.has(e.id) ? e.id : newId('edge');
      edgeIds.add(id);
      edges.push({ id, from: e.from, to: e.to, label: clean(e.label, 80) });
    }
    return { nodes, edges };
  }

  function normalizePlacement(value) {
    return PLACEMENTS.includes(value) ? value : 'visual';
  }

  /** Break a label into lines of at most `max` characters (long words are split). */
  function wrapLabel(text, max) {
    const lines = [];
    for (const para of String(text || '').split('\n')) {
      let line = '';
      for (let word of para.split(/\s+/).filter(Boolean)) {
        while (word.length > max) {
          if (line) { lines.push(line); line = ''; }
          lines.push(word.slice(0, max));
          word = word.slice(max);
        }
        if (!word) continue;
        if (!line) line = word;
        else if (line.length + 1 + word.length <= max) line += ` ${word}`;
        else { lines.push(line); line = word; }
      }
      if (line) lines.push(line);
    }
    return lines.slice(0, 8);
  }

  /**
   * Where a node is drawn and what it says. `steps` is [{ stepId, number }]
   * (the guide's steps in order); `stepLabel(number)` words the link caption.
   */
  function nodeBox(node, { steps = [], stepLabel = (n) => `Step ${n}` } = {}) {
    const w = WIDTH[node.shape] || WIDTH.process;
    const chars = node.shape === 'decision' ? 16 : node.shape === 'terminal' ? 18 : 21;
    const lines = wrapLabel(node.label, chars);
    const target = node.stepId ? steps.find((s) => s.stepId === node.stepId) : null;
    const caption = node.stepId ? (target ? stepLabel(target.number) : stepLabel('?')) : '';
    const textH = Math.max(1, lines.length) * LINE_HEIGHT + (caption ? 16 : 0);
    const h = node.shape === 'decision'
      ? Math.max(100, Math.round(textH * 1.8 + 16))
      : Math.max(node.shape === 'terminal' ? 48 : 60, textH + 24);
    return { x: node.x, y: node.y, w, h, cx: node.x + w / 2, cy: node.y + h / 2, lines, caption };
  }

  /** The point on a node's outline in the direction of (tx, ty). */
  function boundaryPoint(box, shape, tx, ty) {
    const dx = tx - box.cx;
    const dy = ty - box.cy;
    if (!dx && !dy) return [box.cx, box.cy];
    const hw = box.w / 2;
    const hh = box.h / 2;
    const t = shape === 'decision'
      ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
      : Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return [box.cx + dx * t, box.cy + dy * t];
  }

  function edgeLine(edge, boxes, shapes) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) return null;
    const start = boundaryPoint(a, shapes.get(edge.from), b.cx, b.cy);
    const end = boundaryPoint(b, shapes.get(edge.to), a.cx, a.cy);
    return { start, end };
  }

  /**
   * Lay the nodes out top to bottom: each node one row below the node that
   * leads to it (breadth-first from the nodes nothing points at), and the
   * nodes of a row side by side, centered. Returns a new graph.
   */
  function arrange(raw) {
    const g = normalizeFlowchart(raw) || { nodes: [], edges: [] };
    const incoming = new Set(g.edges.map((e) => e.to));
    const rank = new Map();
    const visit = (startId) => {
      const queue = [startId];
      rank.set(startId, rank.get(startId) ?? 0);
      while (queue.length) {
        const id = queue.shift();
        for (const e of g.edges) {
          if (e.from === id && !rank.has(e.to)) {
            rank.set(e.to, rank.get(id) + 1);
            queue.push(e.to);
          }
        }
      }
    };
    for (const n of g.nodes) if (!incoming.has(n.id) && !rank.has(n.id)) visit(n.id);
    for (const n of g.nodes) if (!rank.has(n.id)) { rank.set(n.id, 0); visit(n.id); }
    const rows = [];
    for (const n of g.nodes) (rows[rank.get(n.id)] ||= []).push(n);
    const colW = Math.max(...Object.values(WIDTH)) + 60;
    const widest = Math.max(1, ...rows.filter(Boolean).map((r) => r.length));
    let y = 40;
    for (const row of rows.filter(Boolean)) {
      const offset = ((widest - row.length) * colW) / 2;
      let rowH = 0;
      row.forEach((n, i) => {
        const box = nodeBox(n);
        n.x = Math.round(40 + offset + i * colW + (colW - 60 - box.w) / 2);
        n.y = y;
        rowH = Math.max(rowH, box.h);
      });
      y += rowH + 60;
    }
    return g;
  }

  /** The area the drawing covers: { x, y, w, h }, or null for an empty chart. */
  function bounds(graph, options = {}) {
    if (!graph || !graph.nodes.length) return null;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of graph.nodes) {
      const b = nodeBox(n, options);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function shapeSvg(shape, b, attrs) {
    if (shape === 'decision') {
      return `<polygon points="${b.cx},${b.y} ${b.x + b.w},${b.cy} ${b.cx},${b.y + b.h} ${b.x},${b.cy}"${attrs}/>`;
    }
    const r = shape === 'terminal' ? b.h / 2 : 8;
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${r}" ry="${r}"${attrs}/>`;
  }

  function arrowHead([x1, y1], [x2, y2], color) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const len = 11;
    const p1 = [x2 - len * Math.cos(a - 0.4), y2 - len * Math.sin(a - 0.4)];
    const p2 = [x2 - len * Math.cos(a + 0.4), y2 - len * Math.sin(a + 0.4)];
    const f = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    return `<polygon points="${f([x2, y2])} ${f(p1)} ${f(p2)}" fill="${color}"/>`;
  }

  /**
   * The chart as an SVG document.
   *
   * Export (default): cropped to the drawing plus a margin, at least
   * `minWidth` wide so a small chart isn't blown up to page width, on a white
   * background, drawn at `scale` pixels per unit.
   *
   * Editor (`editor: true`): page coordinates, no background (the editor
   * shows its dotted grid), hit targets and the selection outline.
   */
  function toSvg(raw, {
    steps = [], stepLabel, editor = false, selectedId = null, pendingFromId = null, edgeColor = COLORS.edge,
    width = 0, height = 0, padding = 24, minWidth = 640, scale = 2,
  } = {}) {
    const graph = normalizeFlowchart(raw) || { nodes: [], edges: [] };
    const options = { steps, stepLabel };
    const boxes = new Map(graph.nodes.map((n) => [n.id, nodeBox(n, options)]));
    const shapes = new Map(graph.nodes.map((n) => [n.id, n.shape]));
    const parts = [];

    for (const e of graph.edges) {
      const line = edgeLine(e, boxes, shapes);
      if (!line) continue;
      const [x1, y1] = line.start;
      const [x2, y2] = line.end;
      const selected = editor && e.id === selectedId;
      const color = selected ? '#2563eb' : edgeColor;
      const data = editor ? ` data-edge-id="${esc(e.id)}"` : '';
      parts.push(`<g${data}>`);
      if (editor) parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="14"/>`);
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${selected ? 3 : 2}"/>`);
      parts.push(arrowHead(line.start, line.end, color));
      if (e.label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const w = Math.min(160, e.label.length * 7.5 + 14);
        parts.push(`<rect x="${mx - w / 2}" y="${my - 11}" width="${w}" height="22" rx="4" fill="#ffffff" stroke="${editor ? color : '#cbd5e1'}" stroke-width="1"/>`);
        parts.push(`<text x="${mx}" y="${my + 4.5}" text-anchor="middle" font-size="13" fill="${COLORS.text}">${esc(e.label.slice(0, 22))}</text>`);
      }
      parts.push('</g>');
    }

    for (const n of graph.nodes) {
      const b = boxes.get(n.id);
      const c = COLORS[n.shape] || COLORS.process;
      const selected = editor && (n.id === selectedId || n.id === pendingFromId);
      const data = editor ? ` data-node-id="${esc(n.id)}"` : '';
      parts.push(`<g${data}>`);
      parts.push(shapeSvg(n.shape, b, ` fill="${c.fill}" stroke="${selected ? '#1d4ed8' : c.stroke}" stroke-width="${selected ? 3 : 2}"`));
      const lines = b.lines.length ? b.lines : (editor ? [''] : []);
      const total = lines.length * LINE_HEIGHT + (b.caption ? 16 : 0);
      let ty = b.cy - total / 2 + LINE_HEIGHT - 4;
      for (const text of lines) {
        parts.push(`<text x="${b.cx}" y="${ty}" text-anchor="middle" font-size="${FONT_SIZE}" fill="${COLORS.text}">${esc(text)}</text>`);
        ty += LINE_HEIGHT;
      }
      if (b.caption) parts.push(`<text x="${b.cx}" y="${ty - 2}" text-anchor="middle" font-size="12" font-weight="600" fill="${COLORS.muted}">→ ${esc(b.caption)}</text>`);
      parts.push('</g>');
    }

    const body = parts.join('');
    if (editor) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${esc(FONT_FAMILY)}">${body}</svg>`;
    }
    const box = bounds(graph, options) || { x: 0, y: 0, w: 0, h: 0 };
    const w = Math.max(minWidth, box.w + padding * 2);
    const h = box.h + padding * 2;
    const vx = box.x - (w - box.w) / 2;
    const vy = box.y - padding;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" viewBox="${vx} ${vy} ${w} ${h}" font-family="${esc(FONT_FAMILY)}">`
      + `<rect x="${vx}" y="${vy}" width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;
  }

  /** True when a step has a flowchart worth exporting (at least one node). */
  function hasFlowchart(step) {
    return Boolean(step && step.flowchart && Array.isArray(step.flowchart.nodes) && step.flowchart.nodes.length);
  }

  return {
    SHAPES, PLACEMENTS, GRID, normalizeFlowchart, normalizePlacement, wrapLabel, nodeBox, boundaryPoint,
    arrange, bounds, toSvg, hasFlowchart, newId,
  };
});
