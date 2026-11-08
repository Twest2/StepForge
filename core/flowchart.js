'use strict';

// Shared by the sandboxed editor and Node exporters. Graph JSON is the editable
// source; SVG and Mermaid are derived, never accepted as executable input.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./flowchart-shapes') : root.StepForgeFlowchartShapes);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StepForgeFlowchart = api;
})(typeof window === 'object' ? window : globalThis, function (shapes) {
  const MAX_NODES = 100, MAX_EDGES = 200;
  const WIDTH = 220, HEIGHT = 100;
  const clean = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  const idOk = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const coord = (v, fallback) => Number.isFinite(v) ? Math.max(20, Math.min(4000, v)) : fallback;

  function normalizeGraph(raw = {}) {
    if (!raw || typeof raw !== 'object') raw = {};
    const ids = new Set();
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, MAX_NODES).flatMap((n, i) => {
      if (!n || !idOk(n.id) || ids.has(n.id)) return [];
      ids.add(n.id);
      return [{ id: n.id, label: clean(n.label), type: shapes.TYPES.includes(n.type) ? n.type : 'step',
        stepId: idOk(n.stepId) ? n.stepId : null, x: coord(n.x, 40 + i % 3 * 280), y: coord(n.y, 40 + Math.floor(i / 3) * 180),
        ...(n.width != null || n.height != null ? shapes.nodeSize(n) : {}),
        ...(n.style && typeof n.style === 'object' ? { style: shapes.nodeStyle(n) } : {}) }];
    });
    const edgeIds = new Set();
    const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_EDGES).flatMap((e, i) => {
      if (!e || !ids.has(e.from) || !ids.has(e.to)) return [];
      const id = idOk(e.id) ? e.id : `edge-${i + 1}`;
      if (edgeIds.has(id)) return [];
      edgeIds.add(id);
      return [{ id, from: e.from, to: e.to, label: clean(e.label, 80),
        ...(e.kind != null ? { kind: ['arrow', 'line', 'double'].includes(e.kind) ? e.kind : 'arrow' } : {}),
        ...(e.routing != null ? { routing: e.routing === 'straight' ? 'straight' : 'orthogonal' } : {}),
        ...(e.dashed != null ? { dashed: Boolean(e.dashed) } : {}),
        ...(e.color != null ? { color: shapes.color(e.color, '#606060') } : {}) }];
    });
    return { version: 1, nodes, edges };
  }

  function validateGraph(raw, stepIds = null) {
    if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)
      || raw.nodes.length > MAX_NODES || raw.edges.length > MAX_EDGES) throw new Error('A flowchart needs at most 100 nodes and 200 connections.');
    if (raw.nodes.some(n => n && n.stepId != null && n.stepId !== '' && !idOk(n.stepId))) throw new Error('A flowchart step reference must be a permanent step ID.');
    const graph = normalizeGraph(raw);
    if (graph.nodes.length !== raw.nodes.length || graph.edges.length !== raw.edges.length) throw new Error('Flowchart IDs must be unique and every connection must name existing nodes.');
    if (stepIds && graph.nodes.some(n => n.stepId && !stepIds.has(n.stepId))) throw new Error('A flowchart references a step that is not in this guide.');
    return graph;
  }

  function arrangeGraph(raw) {
    const g = normalizeGraph(raw), rank = new Map(), incoming = new Set(g.edges.filter(e => e.from !== e.to).map(e => e.to));
    const visit = start => {
      const queue = [[start.id, 0]];
      for (let i = 0; i < queue.length; i++) {
        const [id, r] = queue[i];
        if (rank.has(id)) continue;
        rank.set(id, r);
        for (const e of g.edges) if (e.from === id && !rank.has(e.to)) queue.push([e.to, r + 1]);
      }
    };
    for (const n of g.nodes.filter(n => !incoming.has(n.id))) visit(n);
    for (const n of g.nodes) if (!rank.has(n.id)) visit(n);
    const rows = new Map();
    const gapX = Math.max(WIDTH, ...g.nodes.map(n => shapes.nodeSize(n).width)) + 60;
    const gapY = Math.max(HEIGHT, ...g.nodes.map(n => shapes.nodeSize(n).height)) + 80;
    for (const n of g.nodes) {
      const r = rank.get(n.id), col = rows.get(r) || 0;
      const perColumn = Math.max(1, Math.floor(3900 / gapY));
      n.x = 40 + (col + Math.floor(r / perColumn) * 3) * gapX; n.y = 40 + (r % perColumn) * gapY;
      rows.set(r, col + 1);
    }
    // Extremely wide levels use a compact grid rather than overlapping nodes
    // at the workspace boundary.
    if (g.nodes.some(n => n.x > 4000)) { const cols = Math.max(1, Math.floor(3900 / gapX)); g.nodes.forEach((n, i) => { n.x = 40 + i % cols * gapX; n.y = 40 + Math.floor(i / cols) * gapY; }); }
    return g;
  }

  function nodeLabel(node, steps = []) {
    if (!node.stepId) return node.label || node.type;
    const step = steps.find(s => (s.stepId || s.id) === node.stepId);
    if (!step) return `${node.label || 'Step'} (unavailable)`;
    return `Step ${step.number || '?'}: ${node.label || step.title || 'Untitled step'}`;
  }

  function wrapLabel(label, max = 27) {
    const lines = [];
    let line = '';
    for (const ch of String(label)) {
      line += ch;
      if (line.length >= max) { lines.push(line.trim()); line = ''; }
    }
    if (line) lines.push(line.trim());
    return lines.slice(0, 3).map((s, i) => i === 2 && lines.length > 3 ? `${s.slice(0, -1)}…` : s);
  }

  function geometry(raw) {
    const graph = normalizeGraph(raw);
    return { graph, width: Math.max(560, ...graph.nodes.map(n => n.x + shapes.nodeSize(n).width + 40)), height: Math.max(320, ...graph.nodes.map(n => n.y + shapes.nodeSize(n).height + 40)) };
  }

  function edgePoints(e, nodes) {
    const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
    const as = shapes.nodeSize(a), bs = shapes.nodeSize(b), dx = b.x + bs.width / 2 - a.x - as.width / 2, dy = b.y + bs.height / 2 - a.y - as.height / 2;
    if (a.id === b.id) return [shapes.anchor(a, 1, 0), [a.x + as.width + 30, a.y + as.height / 2], [a.x + as.width + 30, a.y - 20], [a.x + as.width / 2, a.y - 20], shapes.anchor(a, 0, -1)];
    if (e.routing === 'straight') return [shapes.anchor(a, dx || 1, dy), shapes.anchor(b, -dx || -1, -dy)];
    if (Math.abs(dx) > Math.abs(dy)) {
      const start = shapes.anchor(a, dx > 0 ? 1 : -1, 0), end = shapes.anchor(b, dx > 0 ? -1 : 1, 0), mid = (start[0] + end[0]) / 2;
      return [start, [mid, start[1]], [mid, end[1]], end];
    }
    const start = shapes.anchor(a, 0, dy > 0 ? 1 : -1), end = shapes.anchor(b, 0, dy > 0 ? -1 : 1), mid = (start[1] + end[1]) / 2;
    return [start, [start[0], mid], [end[0], mid], end];
  }

  function toSvg(raw, steps = [], { selected = null, selectedEdge = null, interactive = false, background = true } = {}) {
    const { graph, width, height } = geometry(raw);
    const edges = graph.edges.map(e => {
      const p = edgePoints(e, graph.nodes), end = p[p.length - 1], before = p[p.length - 2];
      const color = selectedEdge === e.id ? '#2563eb' : e.color || '#606060';
      const head = (tip, tail) => { const a = Math.atan2(tip[1] - tail[1], tip[0] - tail[0]); return `<polygon points="${[tip, [tip[0] - 10 * Math.cos(a - .45), tip[1] - 10 * Math.sin(a - .45)], [tip[0] - 10 * Math.cos(a + .45), tip[1] - 10 * Math.sin(a + .45)]].map(v => v.join(',')).join(' ')}" fill="${color}"/>`; };
      const mid = p.length === 2 ? [(p[0][0] + end[0]) / 2, (p[0][1] + end[1]) / 2] : p[1];
      return `<g data-edge-id="${esc(e.id)}"${interactive ? ' role="button" tabindex="0"' : ''} aria-label="${esc(e.label || 'Connection')}"><polyline points="${p.map(v => v.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2"${e.dashed ? ' stroke-dasharray="7 5"' : ''}/>${e.kind === 'line' ? '' : head(end, before)}${e.kind === 'double' ? head(p[0], p[1]) : ''}${interactive ? `<polyline points="${p.map(v => v.join(',')).join(' ')}" fill="none" stroke="transparent" stroke-width="18"/>` : ''}${e.label ? `<rect x="${mid[0] - 55}" y="${mid[1] - 25}" width="110" height="22" rx="4" fill="#ffffff"/><text x="${mid[0]}" y="${mid[1] - 10}" text-anchor="middle" fill="#333333" font-size="13">${esc(e.label.slice(0, 22))}</text>` : ''}</g>`;
    }).join('');
    const nodes = graph.nodes.map(n => {
      const { width: w, height: h } = shapes.nodeSize(n), style = shapes.nodeStyle(n), outline = shapes.nodeOutline(n);
      const label = nodeLabel(n, steps), cx = n.x + w / 2, cy = n.y + h / 2;
      const lines = wrapLabel(label, Math.max(5, Math.floor((w - 24) * (['decision', 'triangle'].includes(n.type) ? .6 : 1) / (style.fontSize * .55)))).slice(0, Math.max(1, Math.floor(h / (style.fontSize * 1.3))));
      const stroke = selected === n.id ? '#2563eb' : style.stroke;
      const attrs = `fill="${n.type === 'text' ? 'transparent' : style.fill}" stroke="${n.type === 'text' && selected !== n.id ? 'none' : stroke}" stroke-width="${selected === n.id ? 2.5 : style.strokeWidth}" stroke-linejoin="round"`;
      const shape = `<polygon points="${outline.points.map(v => v.join(',')).join(' ')}" ${attrs}/>` + outline.lines.map(line => `<polyline points="${line.map(v => v.join(',')).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${style.strokeWidth}"/>`).join('');
      const handles = interactive && selected === n.id ? [['nw', n.x, n.y], ['ne', n.x + w, n.y], ['sw', n.x, n.y + h], ['se', n.x + w, n.y + h]].map(([dir, x, y]) => `<rect data-resize="${dir}" x="${x - 5}" y="${y - 5}" width="10" height="10" fill="#ffffff" stroke="#2563eb"/>`).join('') : '';
      return `<g data-node-id="${esc(n.id)}"${interactive ? ' role="button" tabindex="0"' : ''} aria-label="${esc(label)}"><title>${esc(label)}</title>${shape}<text text-anchor="middle" fill="${style.textColor}" font-family="sans-serif" font-size="${style.fontSize}">${lines.map((l, i) => `<tspan x="${cx}" y="${cy + (i - (lines.length - 1) / 2) * style.fontSize * 1.3 + style.fontSize * .35}">${esc(l)}</tspan>`).join('')}</text>${handles}</g>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Flowchart" font-family="sans-serif">${background ? `<rect width="100%" height="100%" fill="#ffffff"/>` : ''}${edges}${nodes}</svg>`;
  }

  function toMermaid(raw, steps = []) {
    const g = normalizeGraph(raw), names = new Map(g.nodes.map((n, i) => [n.id, `n${i + 1}`]));
    // Encode syntax-significant characters with Mermaid's decimal entities.
    const quote = s => Array.from(String(s)).map(c => /["&<>#|\[\]{}()\\`]/.test(c) ? `#${c.codePointAt(0)};` : c).join('');
    const lines = ['flowchart TD'];
    for (const n of g.nodes) {
      const label = quote(nodeLabel(n, steps)), types = { rounded: 'rounded', ellipse: 'stadium', parallelogram: 'lean-r', hexagon: 'hex', triangle: 'tri', cylinder: 'cyl', document: 'doc', note: 'notch-rect', cloud: 'cloud', text: 'text' };
      if (types[n.type]) lines.push(`  ${names.get(n.id)}@{ shape: ${types[n.type]}, label: "${label}" }`);
      else lines.push(`  ${names.get(n.id)}${n.type === 'decision' ? `{"${label}"}` : ['start', 'end'].includes(n.type) ? `(["${label}"])` : `["${label}"]`}`);
      if (n.style) { const s = shapes.nodeStyle(n); lines.push(`  style ${names.get(n.id)} fill:${s.fill},stroke:${s.stroke},color:${s.textColor},stroke-width:${s.strokeWidth}px,font-size:${s.fontSize}px`); }
    }
    for (const [i, e] of g.edges.entries()) {
      const connector = e.dashed ? (e.kind === 'line' ? '-.-' : e.kind === 'double' ? '<-.->' : '-.->') : e.kind === 'line' ? '---' : e.kind === 'double' ? '<-->' : '-->';
      lines.push(`  ${names.get(e.from)} ${connector}${e.label ? `|"${quote(e.label)}"|` : ''} ${names.get(e.to)}`);
      if (e.color) lines.push(`  linkStyle ${i} stroke:${e.color}`);
    }
    return lines.join('\n');
  }

  return { MAX_NODES, MAX_EDGES, WIDTH, HEIGHT, ...shapes, normalizeGraph, validateGraph, arrangeGraph, nodeLabel, wrapLabel, geometry, edgePoints, toSvg, toMermaid };
});
