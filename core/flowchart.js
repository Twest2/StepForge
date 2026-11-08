'use strict';

/**
 * Flowcharts: a step can carry one flowchart, stored as plain graph data
 * (`step.flowchart`). The editor and every exporter draw it through toSvg(),
 * so what the author sees is what the export shows.
 *
 *   nodes: [{ id, shape, label, x, y, w?, h?, stepId?, fill?, stroke?, textColor?, image? }]
 *   edges: [{ id, from, to, label, style? }]
 *
 * x/y are a node's top-left corner; w/h its size (each shape has a default,
 * and a node grows to fit its text). stepId links a node to a step of the
 * guide; its current number is shown under the label. image is
 * { src: 'data:image/png;base64,…', fit: 'contain' | 'cover' }: a picture
 * clipped to the shape, never stretched. An edge's style is one of
 * EDGE_STYLES.
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
  const PLACEMENTS = ['visual', 'block'];
  const EDGE_STYLES = ['arrow', 'double', 'line', 'dashed', 'dashedLine', 'dotted'];
  const MAX_NODES = 200;
  const MAX_EDGES = 400;
  const MAX_COORD = 20000;
  const MAX_IMAGE_CHARS = 3 * 1024 * 1024;
  const GRID = 20;
  const FONT_SIZE = 14;
  const LINE_HEIGHT = 18;
  const FONT_FAMILY = "'Segoe UI', 'Noto Sans', Arial, sans-serif";
  const BLUE = { fill: '#eef4ff', stroke: '#2563eb' };
  const COLORS = {
    decision: { fill: '#fff7e6', stroke: '#d97706' },
    terminal: { fill: '#ecfdf3', stroke: '#16a34a' },
    text: { fill: 'transparent', stroke: 'transparent' },
    edge: '#475569',
    label: '#111827',
    muted: '#475569',
  };

  const f = (n) => Math.round(n * 100) / 100;
  /** A path written in a 0..1 box (absolute M/L/C/Z pairs), scaled into box b. */
  const unit = (template) => (b) => template.replace(/(-?[\d.]+) (-?[\d.]+)/g, (m, x, y) => `${f(b.x + Number(x) * b.w)} ${f(b.y + Number(y) * b.h)}`);
  const rectPath = (b) => `M ${b.x} ${b.y} H ${b.x + b.w} V ${b.y + b.h} H ${b.x} Z`;
  const roundRect = (b, r) => {
    const k = Math.min(r, b.w / 2, b.h / 2);
    return `M ${b.x + k} ${b.y} H ${b.x + b.w - k} A ${k} ${k} 0 0 1 ${b.x + b.w} ${b.y + k} V ${b.y + b.h - k} A ${k} ${k} 0 0 1 ${b.x + b.w - k} ${b.y + b.h} `
      + `H ${b.x + k} A ${k} ${k} 0 0 1 ${b.x} ${b.y + b.h - k} V ${b.y + k} A ${k} ${k} 0 0 1 ${b.x + k} ${b.y} Z`;
  };
  const ellipsePath = (cx, cy, rx, ry) => `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  const inset = (b, l, t = l, r = l, btm = t) => ({ x: b.x + l, y: b.y + t, w: Math.max(10, b.w - l - r), h: Math.max(10, b.h - t - btm) });

  /**
   * Every shape: default size, outline (filled, clips an image, takes the
   * border), extra detail lines, and the area its text sits in. `th` is the
   * text's height, for shapes whose text area depends on it.
   */
  const SHAPES = {
    process: { w: 180, h: 60, outline: (b) => roundRect(b, 8), text: (b) => inset(b, 10) },
    rectangle: { w: 180, h: 60, outline: rectPath, text: (b) => inset(b, 10) },
    square: { w: 100, h: 100, outline: rectPath, text: (b) => inset(b, 10) },
    text: { w: 160, h: 40, outline: rectPath, text: (b) => inset(b, 4) },
    terminal: { w: 160, h: 48, outline: (b) => roundRect(b, b.h / 2), text: (b) => inset(b, Math.min(b.h / 2, b.w / 4), 6) },
    ellipse: { w: 160, h: 80, outline: (b) => ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2), text: (b) => inset(b, b.w * 0.15, b.h * 0.15) },
    circle: { w: 100, h: 100, outline: (b) => ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2), text: (b) => inset(b, b.w * 0.15, b.h * 0.15) },
    decision: { w: 200, h: 100, outline: unit('M .5 0 L 1 .5 L .5 1 L 0 .5 Z'), text: (b) => inset(b, b.w * 0.2, b.h * 0.2) },
    parallelogram: { w: 180, h: 60, outline: (b) => { const s = Math.min(b.w * 0.2, b.h * 0.6); return `M ${b.x + s} ${b.y} H ${b.x + b.w} L ${b.x + b.w - s} ${b.y + b.h} H ${b.x} Z`; }, text: (b) => inset(b, Math.min(b.w * 0.2, b.h * 0.6), 6) },
    hexagon: { w: 180, h: 70, outline: (b) => { const s = Math.min(b.w * 0.2, b.h * 0.5); return `M ${b.x + s} ${b.y} H ${b.x + b.w - s} L ${b.x + b.w} ${b.y + b.h / 2} L ${b.x + b.w - s} ${b.y + b.h} H ${b.x + s} L ${b.x} ${b.y + b.h / 2} Z`; }, text: (b) => inset(b, Math.min(b.w * 0.2, b.h * 0.5), 6) },
    triangle: { w: 140, h: 110, outline: unit('M .5 0 L 1 1 L 0 1 Z'), text: (b) => inset(b, b.w * 0.25, b.h * 0.45, b.w * 0.25, 6) },
    cylinder: {
      w: 120, h: 110,
      outline: (b) => { const ry = Math.min(b.h * 0.15, 14); return `M ${b.x} ${b.y + ry} A ${b.w / 2} ${ry} 0 0 1 ${b.x + b.w} ${b.y + ry} V ${b.y + b.h - ry} A ${b.w / 2} ${ry} 0 0 1 ${b.x} ${b.y + b.h - ry} Z`; },
      extra: (b) => { const ry = Math.min(b.h * 0.15, 14); return [`M ${b.x} ${b.y + ry} A ${b.w / 2} ${ry} 0 0 0 ${b.x + b.w} ${b.y + ry}`]; },
      text: (b) => { const ry = Math.min(b.h * 0.15, 14); return inset(b, 8, ry * 2 + 4, 8, ry + 4); },
    },
    cloud: {
      w: 180, h: 110,
      outline: unit('M .25 .85 C .06 .85 .02 .58 .18 .5 C .1 .3 .3 .14 .45 .24 C .52 .06 .78 .06 .8 .28 C .97 .28 1.02 .55 .9 .62 C 1 .8 .86 .92 .72 .85 C .62 .98 .36 .98 .25 .85 Z'),
      text: (b) => inset(b, b.w * 0.18, b.h * 0.25),
    },
    document: { w: 180, h: 80, outline: unit('M 0 0 L 1 0 L 1 .85 C .75 .7 .5 1.02 .25 .92 C .15 .88 .07 .88 0 .92 Z'), text: (b) => inset(b, 10, 6, 10, b.h * 0.18) },
    internalStorage: {
      w: 140, h: 90, outline: rectPath,
      extra: (b) => [`M ${b.x + 14} ${b.y} V ${b.y + b.h}`, `M ${b.x} ${b.y + 14} H ${b.x + b.w}`],
      text: (b) => inset(b, 20, 20, 8, 8),
    },
    cube: {
      w: 140, h: 100,
      outline: (b) => { const d = Math.min(14, b.w * 0.15, b.h * 0.15); return `M ${b.x} ${b.y + d} L ${b.x + d} ${b.y} H ${b.x + b.w} V ${b.y + b.h - d} L ${b.x + b.w - d} ${b.y + b.h} H ${b.x} Z`; },
      extra: (b) => { const d = Math.min(14, b.w * 0.15, b.h * 0.15); return [`M ${b.x} ${b.y + d} H ${b.x + b.w - d} V ${b.y + b.h}`, `M ${b.x + b.w - d} ${b.y + d} L ${b.x + b.w} ${b.y}`]; },
      text: (b) => { const d = Math.min(14, b.w * 0.15, b.h * 0.15); return inset(b, 8, d + 6, d + 8, 6); },
    },
    step: { w: 180, h: 60, outline: (b) => { const s = Math.min(b.w * 0.2, b.h * 0.5); return `M ${b.x} ${b.y} H ${b.x + b.w - s} L ${b.x + b.w} ${b.y + b.h / 2} L ${b.x + b.w - s} ${b.y + b.h} H ${b.x} L ${b.x + s} ${b.y + b.h / 2} Z`; }, text: (b) => inset(b, Math.min(b.w * 0.2, b.h * 0.5) + 4, 6) },
    trapezoid: { w: 180, h: 60, outline: (b) => { const s = Math.min(b.w * 0.2, b.h * 0.6); return `M ${b.x + s} ${b.y} H ${b.x + b.w - s} L ${b.x + b.w} ${b.y + b.h} H ${b.x} Z`; }, text: (b) => inset(b, Math.min(b.w * 0.2, b.h * 0.6), 6) },
    tape: { w: 180, h: 80, outline: unit('M 0 .1 C .25 .25 .5 -.05 .75 .05 C .85 .1 .95 .1 1 .05 L 1 .9 C .75 .75 .5 1.05 .25 .95 C .15 .9 .05 .9 0 .95 Z'), text: (b) => inset(b, 10, b.h * 0.18) },
    note: {
      w: 140, h: 100,
      outline: (b) => { const k = Math.min(18, b.w * 0.25, b.h * 0.25); return `M ${b.x} ${b.y} H ${b.x + b.w - k} L ${b.x + b.w} ${b.y + k} V ${b.y + b.h} H ${b.x} Z`; },
      extra: (b) => { const k = Math.min(18, b.w * 0.25, b.h * 0.25); return [`M ${b.x + b.w - k} ${b.y} V ${b.y + k} H ${b.x + b.w}`]; },
      text: (b) => inset(b, 10, 20, 10, 8),
    },
    card: { w: 140, h: 90, outline: (b) => { const c = Math.min(18, b.w * 0.25, b.h * 0.25); return `M ${b.x + c} ${b.y} H ${b.x + b.w} V ${b.y + b.h} H ${b.x} V ${b.y + c} Z`; }, text: (b) => inset(b, 10, 14, 10, 8) },
    callout: { w: 160, h: 100, outline: unit('M 0 0 L 1 0 L 1 .72 L .45 .72 L .25 1 L .25 .72 L 0 .72 Z'), text: (b) => ({ x: b.x + 8, y: b.y + 6, w: b.w - 16, h: b.h * 0.72 - 12 }) },
    actor: {
      w: 80, h: 120,
      // The figure fills the space above the text; the text sits under its feet.
      outline: (b, th) => { const fig = actorBox(b, th); const r = Math.min(fig.w * 0.18, fig.h * 0.14); return ellipsePath(fig.x + fig.w / 2, fig.y + r + 1, r, r); },
      extra: (b, th) => {
        const fig = actorBox(b, th);
        const cx = fig.x + fig.w / 2;
        const r = Math.min(fig.w * 0.18, fig.h * 0.14);
        const hip = fig.y + fig.h * 0.65;
        return [`M ${cx} ${fig.y + 2 * r + 1} V ${hip}`, `M ${cx - fig.w * 0.38} ${fig.y + fig.h * 0.38} H ${cx + fig.w * 0.38}`,
          `M ${cx - fig.w * 0.32} ${fig.y + fig.h} L ${cx} ${hip} L ${cx + fig.w * 0.32} ${fig.y + fig.h}`];
      },
      text: (b, th) => ({ x: b.x - 20, y: b.y + b.h - th - 4, w: b.w + 40, h: th + 4 }),
      noBorder: true,
    },
    dataStorage: { w: 160, h: 80, outline: unit('M .15 0 L 1 0 C .9 .2 .9 .8 1 1 L .15 1 C 0 .8 0 .2 .15 0 Z'), text: (b) => inset(b, b.w * 0.12, 6, b.w * 0.12, 6) },
    delay: { w: 140, h: 80, outline: (b) => { const r = Math.min(b.h / 2, b.w / 2); return `M ${b.x} ${b.y} H ${b.x + b.w - r} A ${r} ${b.h / 2} 0 0 1 ${b.x + b.w - r} ${b.y + b.h} H ${b.x} Z`; }, text: (b) => inset(b, 10, 6, Math.min(b.h / 2, b.w / 2) * 0.5 + 6, 6) },
    display: { w: 180, h: 80, outline: unit('M 0 .5 L .15 0 L .8 0 C 1 0 1 1 .8 1 L .15 1 Z'), text: (b) => inset(b, b.w * 0.15, 6, b.w * 0.12, 6) },
    subprocess: {
      w: 180, h: 60, outline: rectPath,
      extra: (b) => [`M ${b.x + 12} ${b.y} V ${b.y + b.h}`, `M ${b.x + b.w - 12} ${b.y} V ${b.y + b.h}`],
      text: (b) => inset(b, 18, 6),
    },
    container: {
      w: 220, h: 140, outline: rectPath,
      extra: (b, th) => [`M ${b.x} ${b.y + th + 12} H ${b.x + b.w}`],
      text: (b, th) => ({ x: b.x + 8, y: b.y + 4, w: b.w - 16, h: th + 4 }),
    },
    blockArrow: { w: 160, h: 70, outline: unit('M 0 .28 L .65 .28 L .65 0 L 1 .5 L .65 1 L .65 .72 L 0 .72 Z'), text: (b) => ({ x: b.x + 6, y: b.y + b.h * 0.28, w: b.w * 0.6, h: b.h * 0.44 }) },
    doubleArrow: { w: 180, h: 70, outline: unit('M 0 .5 L .22 0 L .22 .28 L .78 .28 L .78 0 L 1 .5 L .78 1 L .78 .72 L .22 .72 L .22 1 Z'), text: (b) => ({ x: b.x + b.w * 0.22, y: b.y + b.h * 0.28, w: b.w * 0.56, h: b.h * 0.44 }) },
  };
  const SHAPE_IDS = Object.keys(SHAPES);

  function actorBox(b, th) {
    return { x: b.x + b.w * 0.15, y: b.y + 2, w: b.w * 0.7, h: Math.max(30, b.h - th - 12) };
  }

  const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max);
  const num = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_COORD, Math.round(v))) : fallback);
  const size = (v) => (Number.isFinite(v) ? Math.max(20, Math.min(2000, Math.round(v))) : undefined);
  const color = (v) => (typeof v === 'string' && (/^#[0-9a-fA-F]{6}$/.test(v) || v === 'transparent') ? v : undefined);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let counter = 0;
  const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function cleanImage(image) {
    if (!image || typeof image !== 'object' || typeof image.src !== 'string') return undefined;
    if (image.src.length > MAX_IMAGE_CHARS || !/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/.test(image.src)) return undefined;
    return { src: image.src, fit: image.fit === 'cover' ? 'cover' : 'contain' };
  }

  /** A clean copy of a stored or AI-written graph, or null when there is none. */
  function normalizeFlowchart(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
    const ids = new Set();
    const nodes = [];
    for (const [i, n] of raw.nodes.slice(0, MAX_NODES).entries()) {
      if (!n || typeof n !== 'object') continue;
      const id = idOk(n.id) && !ids.has(n.id) ? n.id : newId('node');
      ids.add(id);
      const node = {
        id,
        shape: SHAPES[n.shape] ? n.shape : 'process',
        label: clean(n.label, 300),
        x: num(n.x, 40),
        y: num(n.y, 40 + i * 100),
        stepId: idOk(n.stepId) ? n.stepId : null,
      };
      for (const [key, value] of [['w', size(n.w)], ['h', size(n.h)], ['fill', color(n.fill)], ['stroke', color(n.stroke)],
        ['textColor', color(n.textColor)], ['image', cleanImage(n.image)]]) {
        if (value !== undefined) node[key] = value;
      }
      nodes.push(node);
    }
    const edgeIds = new Set();
    const edges = [];
    for (const e of (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_EDGES)) {
      if (!e || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
      const id = idOk(e.id) && !edgeIds.has(e.id) ? e.id : newId('edge');
      edgeIds.add(id);
      edges.push({ id, from: e.from, to: e.to, label: clean(e.label, 80), ...(EDGE_STYLES.includes(e.style) && e.style !== 'arrow' ? { style: e.style } : {}) });
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
    return lines.slice(0, 12);
  }

  /**
   * Where a node is drawn and what it says. `steps` is [{ stepId, number }]
   * (the guide's steps in order); `stepLabel(number)` words the link caption.
   * The box grows taller than the node's size when its text needs the room.
   */
  function nodeBox(node, { steps = [], stepLabel = (n) => `Step ${n}` } = {}) {
    const def = SHAPES[node.shape] || SHAPES.process;
    const w = node.w || def.w;
    let h = node.h || def.h;
    const target = node.stepId ? steps.find((s) => s.stepId === node.stepId) : null;
    const caption = node.stepId ? (target ? stepLabel(target.number) : stepLabel('?')) : '';
    const probe = def.text({ x: 0, y: 0, w, h }, LINE_HEIGHT);
    const lines = wrapLabel(node.label, Math.max(4, Math.floor(probe.w / (FONT_SIZE * 0.56))));
    const textH = Math.max(1, lines.length) * LINE_HEIGHT + (caption ? 16 : 0);
    for (let i = 0; i < 200 && def.text({ x: 0, y: 0, w, h }, textH).h < textH; i += 1) h += 4;
    const b = { x: node.x, y: node.y, w, h };
    return { ...b, cx: node.x + w / 2, cy: node.y + h / 2, lines, caption, textH, textArea: def.text(b, textH) };
  }

  /** The point on a node's box (a diamond for decisions) in the direction of (tx, ty). */
  function boundaryPoint(box, shape, tx, ty) {
    const dx = tx - box.cx;
    const dy = ty - box.cy;
    if (!dx && !dy) return [box.cx, box.cy];
    const hw = box.w / 2;
    const hh = box.h / 2;
    const round = shape === 'decision' || shape === 'ellipse' || shape === 'circle';
    const t = round
      ? 1 / (shape === 'decision' ? Math.abs(dx) / hw + Math.abs(dy) / hh : Math.hypot(dx / hw, dy / hh))
      : Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return [box.cx + dx * t, box.cy + dy * t];
  }

  function edgeLine(edge, boxes, shapes) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) return null;
    return { start: boundaryPoint(a, shapes.get(edge.from), b.cx, b.cy), end: boundaryPoint(b, shapes.get(edge.to), a.cx, a.cy) };
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
    const colW = Math.max(...g.nodes.map((n) => nodeBox(n).w), 160) + 60;
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
      const t = b.textArea;
      minX = Math.min(minX, b.x, t.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w, t.x + t.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function arrowHead([x1, y1], [x2, y2], fill) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const len = 11;
    const p = (ang) => `${f(x2 - len * Math.cos(ang))},${f(y2 - len * Math.sin(ang))}`;
    return `<polygon points="${f(x2)},${f(y2)} ${p(a - 0.4)} ${p(a + 0.4)}" fill="${fill}"/>`;
  }

  /** The SVG of one node: shape, picture, detail lines, border, text. */
  function nodeSvg(n, b, { editor, selected, idPrefix }) {
    const def = SHAPES[n.shape] || SHAPES.process;
    const base = COLORS[n.shape] || BLUE;
    const fill = n.fill || base.fill;
    const noBorder = def.noBorder || n.shape === 'text';
    const stroke = selected ? '#1d4ed8' : (n.stroke || (noBorder && n.shape !== 'actor' ? 'transparent' : base.stroke));
    const width = selected ? 3 : 2;
    const outline = def.outline(b, b.textH);
    const parts = [];
    // The outline is filled even when "transparent", so the shape can be clicked.
    parts.push(`<path d="${outline}" fill="${fill === 'transparent' ? (editor ? 'rgba(0,0,0,0.001)' : 'none') : fill}"/>`);
    if (n.image) {
      const clip = `${idPrefix}clip-${n.id}`;
      parts.push(`<clipPath id="${esc(clip)}"><path d="${outline}"/></clipPath>`);
      parts.push(`<image href="${n.image.src}" xlink:href="${n.image.src}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" `
        + `preserveAspectRatio="xMidYMid ${n.image.fit === 'cover' ? 'slice' : 'meet'}" clip-path="url(#${esc(clip)})"/>`);
    }
    const lineColor = n.shape === 'actor' ? (n.stroke || '#1f2937') : stroke;
    for (const d of def.extra ? def.extra(b, b.textH) : []) parts.push(`<path d="${d}" fill="none" stroke="${selected ? '#1d4ed8' : lineColor}" stroke-width="${width}"/>`);
    if (n.shape === 'text' && editor) {
      parts.push(`<path d="${outline}" fill="none" stroke="${selected ? '#1d4ed8' : '#94a3b8'}" stroke-width="${selected ? 2 : 1}" stroke-dasharray="4 3"/>`);
    } else if (stroke !== 'transparent' || n.shape === 'actor') {
      parts.push(`<path d="${outline}" fill="none" stroke="${n.shape === 'actor' ? lineColor : stroke}" stroke-width="${width}" stroke-linejoin="round"/>`);
    }
    const t = b.textArea;
    const lines = b.lines.length ? b.lines : [];
    const total = lines.length * LINE_HEIGHT + (b.caption ? 16 : 0);
    let ty = t.y + (t.h - total) / 2 + LINE_HEIGHT - 4;
    const textColor = n.textColor || COLORS.label;
    for (const text of lines) {
      parts.push(`<text x="${f(t.x + t.w / 2)}" y="${f(ty)}" text-anchor="middle" font-size="${FONT_SIZE}" fill="${textColor}">${esc(text)}</text>`);
      ty += LINE_HEIGHT;
    }
    if (b.caption) parts.push(`<text x="${f(t.x + t.w / 2)}" y="${f(ty - 2)}" text-anchor="middle" font-size="12" font-weight="600" fill="${n.textColor || COLORS.muted}">→ ${esc(b.caption)}</text>`);
    if (editor && selected) {
      // Resize handle, bottom-right.
      parts.push(`<rect data-resize="se" x="${b.x + b.w - 5}" y="${b.y + b.h - 5}" width="10" height="10" fill="#ffffff" stroke="#1d4ed8" stroke-width="2"/>`);
    }
    return parts.join('');
  }

  /**
   * The chart as an SVG document.
   *
   * Export (default): cropped to the drawing plus a margin, at least
   * `minWidth` wide so a small chart isn't blown up to page width, on a white
   * background, drawn at `scale` pixels per unit.
   *
   * Editor (`editor: true`): chart coordinates at `zoom`, no background (the
   * editor shows its dotted grid), hit targets and the selection outline.
   */
  function toSvg(raw, {
    steps = [], stepLabel, editor = false, selectedId = null, pendingFromId = null, edgeColor = COLORS.edge,
    width = 0, height = 0, zoom = 1, padding = 24, minWidth = 640, scale = 2, idPrefix = 'fc-',
  } = {}) {
    const graph = normalizeFlowchart(raw) || { nodes: [], edges: [] };
    const options = { steps, stepLabel };
    const boxes = new Map(graph.nodes.map((n) => [n.id, nodeBox(n, options)]));
    const shapes = new Map(graph.nodes.map((n) => [n.id, n.shape]));
    const parts = [];

    for (const e of graph.edges) {
      const line = edgeLine(e, boxes, shapes);
      if (!line) continue;
      const [x1, y1] = line.start.map(f);
      const [x2, y2] = line.end.map(f);
      const selected = editor && e.id === selectedId;
      const color = selected ? '#2563eb' : edgeColor;
      const style = e.style || 'arrow';
      const dash = style === 'dashed' || style === 'dashedLine' ? ' stroke-dasharray="8 5"' : style === 'dotted' ? ' stroke-dasharray="2 4" stroke-linecap="round"' : '';
      parts.push(editor ? `<g data-edge-id="${esc(e.id)}">` : '<g>');
      if (editor) parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="14"/>`);
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${selected ? 3 : 2}"${dash}/>`);
      if (style === 'arrow' || style === 'double' || style === 'dashed') parts.push(arrowHead(line.start, line.end, color));
      if (style === 'double') parts.push(arrowHead(line.end, line.start, color));
      if (e.label) {
        const mx = f((x1 + x2) / 2);
        const my = f((y1 + y2) / 2);
        const w = Math.min(160, e.label.length * 7.5 + 14);
        parts.push(`<rect x="${f(mx - w / 2)}" y="${f(my - 11)}" width="${f(w)}" height="22" rx="4" fill="#ffffff" stroke="${editor ? color : '#cbd5e1'}" stroke-width="1"/>`);
        parts.push(`<text x="${mx}" y="${f(my + 4.5)}" text-anchor="middle" font-size="13" fill="${COLORS.label}">${esc(e.label.slice(0, 22))}</text>`);
      }
      parts.push('</g>');
    }

    for (const n of graph.nodes) {
      const selected = editor && (n.id === selectedId || n.id === pendingFromId);
      parts.push(editor ? `<g data-node-id="${esc(n.id)}">` : '<g>');
      parts.push(nodeSvg(n, boxes.get(n.id), { editor, selected, idPrefix }));
      parts.push('</g>');
    }

    const body = parts.join('');
    const ns = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
    if (editor) {
      return `<svg ${ns} width="${f(width * zoom)}" height="${f(height * zoom)}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT_FAMILY)}">${body}</svg>`;
    }
    const box = bounds(graph, options) || { x: 0, y: 0, w: 0, h: 0 };
    const w = Math.max(minWidth, box.w + padding * 2);
    const h = box.h + padding * 2;
    const vx = box.x - (w - box.w) / 2;
    const vy = box.y - padding;
    return `<svg ${ns} width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" viewBox="${f(vx)} ${f(vy)} ${f(w)} ${f(h)}" font-family="${esc(FONT_FAMILY)}">`
      + `<rect x="${f(vx)}" y="${f(vy)}" width="${f(w)}" height="${f(h)}" fill="#ffffff"/>${body}</svg>`;
  }

  /** A small outline drawing of a shape, for the shape palette. */
  function shapeIcon(shape) {
    const def = SHAPES[shape] || SHAPES.process;
    const aspect = def.w / def.h;
    // Wide shapes are drawn a little taller than true so they read at this size.
    const bw = aspect >= 1 ? 34 : Math.max(16, 24 * aspect);
    const bh = aspect >= 1 ? Math.max(16, Math.min(24, 34 / aspect)) : 24;
    const b = { x: (40 - bw) / 2, y: (30 - bh) / 2, w: bw, h: bh };
    const th = shape === 'actor' ? 0 : 6;
    const paths = [def.outline(b, th), ...(def.extra ? def.extra(b, th) : [])];
    const dash = shape === 'text' ? ' stroke-dasharray="3 2"' : '';
    const label = shape === 'text' ? '<path d="M15 12h10M20 12v8"/>' : '';
    return `<svg viewBox="0 0 40 30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths.map((d) => `<path d="${d}"${dash}/>`).join('')}${label}</svg>`;
  }

  /** A shape's own fill and border colors, before the author changes them. */
  function defaultColors(shape) {
    if (shape === 'actor') return { fill: BLUE.fill, stroke: '#1f2937' };
    return COLORS[shape] && shape !== 'edge' ? { fill: COLORS[shape].fill, stroke: COLORS[shape].stroke } : { ...BLUE };
  }

  /** True when a step has a flowchart worth exporting (at least one node). */
  function hasFlowchart(step) {
    return Boolean(step && step.flowchart && Array.isArray(step.flowchart.nodes) && step.flowchart.nodes.length);
  }

  return {
    SHAPES: SHAPE_IDS, EDGE_STYLES, PLACEMENTS, GRID, normalizeFlowchart, normalizePlacement, wrapLabel, nodeBox, boundaryPoint,
    arrange, bounds, toSvg, shapeIcon, defaultColors, hasFlowchart, newId,
  };
});
