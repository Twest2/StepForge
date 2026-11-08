'use strict';

// Shared by the sandboxed editor and Node exporters. Graph JSON is the editable
// source; SVG and Mermaid are derived, never accepted as executable input.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StepForgeFlowchart = api;
})(typeof window === 'object' ? window : globalThis, function () {
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
      return [{ id: n.id, label: clean(n.label), type: ['step', 'decision', 'start', 'end'].includes(n.type) ? n.type : 'step',
        stepId: idOk(n.stepId) ? n.stepId : null, x: coord(n.x, 40 + i % 3 * 280), y: coord(n.y, 40 + Math.floor(i / 3) * 180) }];
    });
    const edgeIds = new Set();
    const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_EDGES).flatMap((e, i) => {
      if (!e || !ids.has(e.from) || !ids.has(e.to)) return [];
      const id = idOk(e.id) ? e.id : `edge-${i + 1}`;
      if (edgeIds.has(id)) return [];
      edgeIds.add(id);
      return [{ id, from: e.from, to: e.to, label: clean(e.label, 80) }];
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
    for (const n of g.nodes) {
      const r = rank.get(n.id), col = rows.get(r) || 0;
      n.x = 40 + (col + Math.floor(r / 20) * 3) * 280; n.y = 40 + (r % 20) * 180;
      rows.set(r, col + 1);
    }
    // Extremely wide levels use a compact grid rather than overlapping nodes
    // at the workspace boundary.
    if (g.nodes.some(n => n.x > 4000)) g.nodes.forEach((n, i) => { n.x = 40 + i % 10 * 280; n.y = 40 + Math.floor(i / 10) * 180; });
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
    return { graph, width: Math.max(560, ...graph.nodes.map(n => n.x + WIDTH + 40)), height: Math.max(320, ...graph.nodes.map(n => n.y + HEIGHT + 40)) };
  }

  function edgePoints(e, nodes) {
    const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
    if (a.id === b.id) return [[a.x + WIDTH, a.y + HEIGHT / 2], [a.x + WIDTH + 30, a.y + HEIGHT / 2], [a.x + WIDTH + 30, a.y - 20], [a.x + WIDTH / 2, a.y - 20], [a.x + WIDTH / 2, a.y]];
    if (Math.abs(b.x - a.x) > Math.abs(b.y - a.y)) {
      const right = b.x > a.x, x1 = a.x + (right ? WIDTH : 0), x2 = b.x + (right ? 0 : WIDTH), mid = (x1 + x2) / 2;
      return [[x1, a.y + HEIGHT / 2], [mid, a.y + HEIGHT / 2], [mid, b.y + HEIGHT / 2], [x2, b.y + HEIGHT / 2]];
    }
    const down = b.y > a.y, y1 = a.y + (down ? HEIGHT : 0), y2 = b.y + (down ? 0 : HEIGHT), mid = (y1 + y2) / 2;
    return [[a.x + WIDTH / 2, y1], [a.x + WIDTH / 2, mid], [b.x + WIDTH / 2, mid], [b.x + WIDTH / 2, y2]];
  }

  function toSvg(raw, steps = [], { selected = null, selectedEdge = null, interactive = false, background = true } = {}) {
    const { graph, width, height } = geometry(raw);
    const edges = graph.edges.map(e => {
      const p = edgePoints(e, graph.nodes), end = p[p.length - 1], before = p[p.length - 2];
      const angle = Math.atan2(end[1] - before[1], end[0] - before[0]);
      const head = [end, [end[0] - 10 * Math.cos(angle - 0.45), end[1] - 10 * Math.sin(angle - 0.45)], [end[0] - 10 * Math.cos(angle + 0.45), end[1] - 10 * Math.sin(angle + 0.45)]];
      const mid = p[1], color = selectedEdge === e.id ? '#2563eb' : '#64748b';
      return `<g data-edge-id="${esc(e.id)}"${interactive ? ' role="button" tabindex="0"' : ''} aria-label="${esc(e.label || 'Connection')}"><polyline points="${p.map(v => v.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/><polygon points="${head.map(v => v.join(',')).join(' ')}" fill="${color}"/>${interactive ? `<polyline points="${p.map(v => v.join(',')).join(' ')}" fill="none" stroke="transparent" stroke-width="18"/>` : ''}${e.label ? `<rect x="${mid[0] - 55}" y="${mid[1] - 25}" width="110" height="22" rx="4" fill="#ffffff"/><text x="${mid[0]}" y="${mid[1] - 10}" text-anchor="middle" fill="#334155" font-size="13">${esc(e.label.slice(0, 22))}</text>` : ''}</g>`;
    }).join('');
    const nodes = graph.nodes.map(n => {
      const label = nodeLabel(n, steps), lines = wrapLabel(label, n.type === 'decision' ? 19 : 27), cx = n.x + WIDTH / 2, cy = n.y + HEIGHT / 2;
      const attrs = `fill="${n.type === 'decision' ? '#eff6ff' : '#ffffff'}" stroke="${selected === n.id ? '#2563eb' : '#64748b'}" stroke-width="${selected === n.id ? 3 : 1.5}"`;
      const shape = n.type === 'decision' ? `<polygon points="${cx},${n.y} ${n.x + WIDTH},${cy} ${cx},${n.y + HEIGHT} ${n.x},${cy}" ${attrs}/>` : `<rect x="${n.x}" y="${n.y}" width="${WIDTH}" height="${HEIGHT}" rx="${['start', 'end'].includes(n.type) ? 50 : 8}" ${attrs}/>`;
      return `<g data-node-id="${esc(n.id)}"${interactive ? ' role="button" tabindex="0"' : ''} aria-label="${esc(label)}"><title>${esc(label)}</title>${shape}<text text-anchor="middle" fill="#172033" font-family="sans-serif" font-size="14">${lines.map((l, i) => `<tspan x="${cx}" y="${cy + (i - (lines.length - 1) / 2) * 18 + 5}">${esc(l)}</tspan>`).join('')}</text></g>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Flowchart" font-family="sans-serif">${background ? `<rect width="100%" height="100%" fill="#ffffff"/>` : ''}${edges}${nodes}</svg>`;
  }

  function toMermaid(raw, steps = []) {
    const g = normalizeGraph(raw), names = new Map(g.nodes.map((n, i) => [n.id, `n${i + 1}`]));
    // Encode syntax-significant characters with Mermaid's decimal entities.
    const quote = s => Array.from(String(s)).map(c => /["&<>#|\[\]{}()\\`]/.test(c) ? `#${c.codePointAt(0)};` : c).join('');
    const lines = ['flowchart TD'];
    for (const n of g.nodes) {
      const label = quote(nodeLabel(n, steps)), shape = n.type === 'decision' ? `{"${label}"}` : ['start', 'end'].includes(n.type) ? `(["${label}"])` : `["${label}"]`;
      lines.push(`  ${names.get(n.id)}${shape}`);
    }
    for (const e of g.edges) lines.push(`  ${names.get(e.from)} -->${e.label ? `|"${quote(e.label)}"|` : ''} ${names.get(e.to)}`);
    return lines.join('\n');
  }

  return { MAX_NODES, MAX_EDGES, WIDTH, HEIGHT, normalizeGraph, validateGraph, arrangeGraph, nodeLabel, wrapLabel, geometry, edgePoints, toSvg, toMermaid };
});
