'use strict';
(() => {
const flow = window.StepForgeFlowchart;
const copy = v => JSON.parse(JSON.stringify(v));
const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
const names = () => ({ step: t('Rectangle'), rounded: t('Rounded rectangle'), ellipse: t('Oval'), decision: t('Decision'),
  parallelogram: t('Parallelogram'), hexagon: t('Hexagon'), triangle: t('Triangle'), cylinder: t('Cylinder'),
  document: t('Document'), note: t('Note'), cloud: t('Cloud'), text: t('Text'), start: t('Start'), end: t('End') });
const paths = {
  select: '<path d="M5 3v16l4-4 3 6 2-1-3-6h6z"/>',
  connect: '<path d="M4 5h7v14h9m-4-4 4 4-4 4"/>',
  line: '<path d="M4 19 20 5"/>',
  shapes: '<rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17" cy="6.5" r="3.5"/><path d="m6.5 14 4.5 7H2zM17 13l5 5-5 5-5-5z"/>',
  arrange: '<rect x="8" y="2" width="8" height="5" rx="1"/><path d="M12 7v5M5 16v-4h14v4"/><rect x="1" y="16" width="8" height="6" rx="1"/><rect x="15" y="16" width="8" height="6" rx="1"/>',
  delete: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 5V3H3v13h2"/>',
  undo: '<path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 4 5 5-5 5M20 9H10a6 6 0 0 0 0 12h3"/>',
  zoomIn: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6m-3-3v6"/>',
  zoomOut: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6"/>',
  fit: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
  source: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  done: '<path d="m4 12 5 5L20 6"/>',
};
function icon(name) {
  let content = paths[name];
  if (flow.TYPES.includes(name)) {
    if (name === 'text') content = '<path d="M4 7V4h16v3M12 4v17m-4 0h8"/>';
    else { const shape = flow.nodeOutline({ type: name, x: 0, y: 0 }); content = `<g transform="translate(3 6) scale(.08182 .12)"><polygon vector-effect="non-scaling-stroke" points="${shape.points.map(p => p.join(',')).join(' ')}"/>${shape.lines.map(p => `<polyline vector-effect="non-scaling-stroke" points="${p.map(v => v.join(',')).join(' ')}"/>`).join('')}</g>`; }
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content || paths.select}</svg>`;
}
function toolButton(label, name, action, data = {}) {
  return el('button.tool.tool-icon', { type: 'button', title: label, 'aria-label': label, dataset: data, innerHTML: icon(name), onClick: action });
}

class FlowchartEditor {
  constructor({ toolbar, controls, surface, properties, getGraph, getSteps, onChange, onPlacement, onDone, onUndo, onRedo, onGoToStep, onToast }) {
    Object.assign(this, { toolbar, controls, surface, properties, getGraph, getSteps, onChange, onPlacement, onDone, onUndo, onRedo, onGoToStep, onToast });
    this.selected = null; this.edge = null; this.connectFrom = null; this.tool = 'select'; this.zoom = 1;
    this.buildToolbar();
    surface.addEventListener('pointerdown', e => this.pointerDown(e));
    surface.addEventListener('pointermove', e => this.pointerMove(e));
    surface.addEventListener('pointerup', e => this.pointerUp(e));
    surface.addEventListener('pointercancel', () => { this.drag = null; this.tool = 'select'; this.render(); });
    surface.addEventListener('keydown', e => this.keyDown(e));
    surface.addEventListener('dblclick', e => { const id = e.target.closest('[data-node-id]')?.dataset.nodeId; const n = this.getGraph()?.nodes.find(n => n.id === id); if (n?.stepId) this.onGoToStep(n.stepId); });
    surface.parentElement.addEventListener('wheel', e => {
      if (!e.ctrlKey || surface.hidden) return;
      e.preventDefault(); e.stopPropagation();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * .002), { x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  buildToolbar() {
    const sep = () => el('span.sep', { 'aria-hidden': 'true' });
    this.selectButton = toolButton(t('Select'), 'select', () => this.setTool('select'), { flowTool: 'select' });
    this.toolButtons = new Map([['select', this.selectButton]]);
    const shapeButton = type => { const b = toolButton(names()[type], type, () => this.setTool(type), { flowTool: type }); return b; };
    this.palette = el('div.flowchart-palette', { popover: 'auto', role: 'group', 'aria-label': t('Shapes') }, ...flow.TYPES.map(shapeButton));
    this.moreButton = toolButton(t('More shapes'), 'shapes', () => {
      const r = this.moreButton.getBoundingClientRect();
      this.palette.style.left = `${Math.min(r.left, window.innerWidth - 208)}px`; this.palette.style.top = `${r.bottom + 6}px`;
      this.palette.togglePopover();
    });
    this.moreButton.setAttribute('aria-expanded', 'false');
    this.palette.addEventListener('toggle', e => this.moreButton.setAttribute('aria-expanded', String(e.newState === 'open')));
    const quick = ['step', 'rounded', 'ellipse', 'decision'].map(type => { const b = shapeButton(type); this.toolButtons.set(type, b); return b; });
    this.connectButton = toolButton(t('Connect'), 'connect', () => this.setTool('connect', 'arrow'), { flowTool: 'connect' });
    this.lineButton = toolButton(t('Line'), 'line', () => this.setTool('connect', 'line'), { flowTool: 'line' });
    this.toolbar.append(this.selectButton, sep(), ...quick, this.moreButton, sep(), this.connectButton, this.lineButton, sep(),
      toolButton(t('Arrange'), 'arrange', () => { this.tool = 'select'; this.change(flow.arrangeGraph(this.getGraph())); }),
      toolButton(t('Duplicate'), 'duplicate', () => this.duplicateSelected()), toolButton(t('Delete'), 'delete', () => this.removeSelected()), this.palette);
    this.controls.append(toolButton(t('Undo'), 'undo', () => this.onUndo()), toolButton(t('Redo'), 'redo', () => this.onRedo()), sep(),
      toolButton(t('Zoom out'), 'zoomOut', () => this.setZoom(this.zoom / 1.2)), this.zoomLabel = el('span.flowchart-zoom', { role: 'status', 'aria-label': t('Zoom') }, '100%'),
      toolButton(t('Zoom in'), 'zoomIn', () => this.setZoom(this.zoom * 1.2)), toolButton(t('Fit'), 'fit', () => this.fit()), sep(),
      toolButton(t('Mermaid source'), 'source', () => this.showMermaid()),
      this.placement = el('select.flowchart-placement-select', { 'aria-label': t('Flowchart placement'), title: t('Flowchart placement'), onChange: () => this.onPlacement(this.placement.value) },
        el('option', { value: 'main' }, t('Replace image')), el('option', { value: 'block' }, t('Content block'))),
      this.doneButton = toolButton(t('Done'), 'done', () => this.onDone()));
  }

  setTool(tool, kind = 'arrow') {
    this.tool = tool; this.connectionKind = kind; this.connectFrom = null;
    if (this.palette.matches(':popover-open')) this.palette.hidePopover();
    this.render(); this.surface.focus();
  }
  change(graph) { this.onChange(flow.normalizeGraph(graph)); this.render(); }
  resetTool() { this.tool = 'select'; this.connectFrom = null; }
  addNode(type, position = null) {
    const g = copy(this.getGraph());
    if (g.nodes.length >= flow.MAX_NODES) { this.resetTool(); return this.onToast(t('A flowchart can contain up to 100 nodes.'), { error: true }); }
    const node = { id: uid('node'), type, label: type === 'decision' ? t('Condition?') : type === 'start' ? t('Start') : type === 'end' ? t('End') : type === 'text' ? t('Text') : t('New step'),
      stepId: null, x: position?.x ?? 40 + g.nodes.length % 3 * 280, y: position?.y ?? 40 + Math.floor(g.nodes.length / 3) * 180 };
    g.nodes.push(node); this.selected = node.id; this.edge = null; this.resetTool(); this.change(g);
  }

  render({ block = this.block } = {}) {
    this.block = block;
    const graph = this.drag?.graph || this.getGraph(); if (!graph) return;
    this.placement.value = block ? 'block' : 'main'; this.doneButton.hidden = !block;
    for (const [tool, b] of this.toolButtons) { const active = this.tool === tool; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }
    for (const [b, kind] of [[this.connectButton, 'arrow'], [this.lineButton, 'line']]) { const active = this.tool === 'connect' && this.connectionKind === kind; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }
    const g = flow.geometry(graph), wrap = this.surface.parentElement;
    const width = Math.max(g.width, wrap.clientWidth / this.zoom), height = Math.max(g.height, wrap.clientHeight / this.zoom);
    this.surface.innerHTML = flow.toSvg(graph, this.getSteps(), { selected: this.selected, selectedEdge: this.edge, interactive: true, background: false });
    const svg = this.surface.querySelector('svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.width = `${width * this.zoom}px`; svg.style.height = `${height * this.zoom}px`;
    this.surface.style.width = `${width * this.zoom}px`; this.surface.style.height = `${height * this.zoom}px`;
    this.surface.style.backgroundSize = `${20 * this.zoom}px ${20 * this.zoom}px`;
    const dot = Math.max(.35, this.zoom * .8);
    this.surface.style.backgroundImage = `radial-gradient(circle, var(--canvas-grid-dot) ${dot}px, transparent ${dot}px)`;
    this.surface.classList.toggle('drawing-shape', flow.TYPES.includes(this.tool));
    this.surface.classList.toggle('connecting', this.tool === 'connect');
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.surface.setAttribute('aria-label', this.tool === 'connect' ? t('Select two nodes to connect them.') : t('Flowchart editor'));
    if (!this.drag) this.renderProperties();
  }

  setZoom(value, pointer = null) {
    const wrap = this.surface.parentElement, r = wrap.getBoundingClientRect();
    const x = pointer ? pointer.x - r.left : wrap.clientWidth / 2, y = pointer ? pointer.y - r.top : wrap.clientHeight / 2;
    const worldX = (wrap.scrollLeft + x) / this.zoom, worldY = (wrap.scrollTop + y) / this.zoom;
    this.zoom = Math.max(.1, Math.min(4, value)); this.render();
    wrap.scrollLeft = worldX * this.zoom - x; wrap.scrollTop = worldY * this.zoom - y;
  }
  fit() {
    const wrap = this.surface.parentElement, g = flow.geometry(this.getGraph());
    this.setZoom(Math.min(1, (wrap.clientWidth - 32) / g.width, (wrap.clientHeight - 32) / g.height)); wrap.scrollLeft = 0; wrap.scrollTop = 0;
  }

  renderProperties() {
    clearNode(this.properties);
    const g = this.getGraph(), node = g?.nodes.find(n => n.id === this.selected), edge = g?.edges.find(e => e.id === this.edge);
    if (!node && !edge) { this.properties.append(el('span.muted', {}, this.tool === 'connect' ? t('Select two nodes to connect them.') : flow.TYPES.includes(this.tool) ? t('Click or drag on the canvas to place a shape.') : t('Add nodes, drag to move them, or select a node to edit it.'))); return; }
    const update = patch => { const graph = copy(this.getGraph()), item = node ? graph.nodes.find(n => n.id === node.id) : graph.edges.find(e => e.id === edge.id); if (item) { Object.assign(item, patch); this.change(graph); } };
    const field = (label, input) => el('label', {}, label, input);
    const select = (label, value, options, onChange) => { const input = el('select', { 'aria-label': label }, ...options.map(([v, text]) => el('option', { value: v, selected: value === v }, text))); input.addEventListener('change', () => onChange(input.value)); return field(label, input); };
    const label = el('input', { value: (node || edge).label, maxLength: node ? 300 : 80, 'aria-label': t('Label') });
    label.addEventListener('change', () => update({ label: label.value })); this.properties.append(field(t('Label'), label));
    const color = (name, value, change) => { const input = el('input', { type: 'color', value, 'aria-label': name }); input.addEventListener('change', () => change(input.value)); return field(name, input); };
    if (node) {
      this.properties.append(select(t('Node type'), node.type, Object.entries(names()), type => update({ type })),
        select(t('Go to step'), node.stepId || '', [['', t('No linked step')], ...this.getSteps().map(s => [s.stepId, `${s.number}. ${s.title || t('Untitled step')}`])], stepId => update({ stepId: stepId || null })));
      const style = flow.nodeStyle(node), changeStyle = patch => update({ style: { ...flow.nodeStyle(this.getGraph().nodes.find(n => n.id === node.id) || node), ...patch } });
      this.properties.append(color(t('Fill'), style.fill, fill => changeStyle({ fill })), color(t('Stroke'), style.stroke, stroke => changeStyle({ stroke })), color(t('Text color'), style.textColor, textColor => changeStyle({ textColor })),
        select(t('Line width'), String(style.strokeWidth), ['1', '1.5', '2', '3', '4', '6'].map(s => [s, `${s} px`]), value => changeStyle({ strokeWidth: Number(value) })),
        select(t('Font size'), String(style.fontSize), ['10', '12', '14', '16', '20', '24', '32'].map(s => [s, `${s} px`]), value => changeStyle({ fontSize: Number(value) })));
      if (node.stepId) this.properties.append(toolButton(t('Open linked step'), 'connect', () => this.onGoToStep(node.stepId)));
    } else {
      this.properties.append(select(t('Connection'), edge.kind || 'arrow', [['arrow', t('Arrow')], ['line', t('Line')], ['double', t('Double arrow')]], kind => update({ kind })),
        select(t('Routing'), edge.routing || 'orthogonal', [['orthogonal', t('Orthogonal')], ['straight', t('Straight')]], routing => update({ routing })),
        select(t('Line style'), edge.dashed ? 'dashed' : 'solid', [['solid', t('Solid')], ['dashed', t('Dashed')]], value => update({ dashed: value === 'dashed' })),
        color(t('Stroke'), edge.color || '#606060', value => update({ color: value })));
    }
  }

  point(e) { const r = this.surface.getBoundingClientRect(); return { x: Math.max(20, Math.min(4000, (e.clientX - r.left) / this.zoom)), y: Math.max(20, Math.min(4000, (e.clientY - r.top) / this.zoom)) }; }
  pointerDown(e) {
    if (e.button !== 0) return;
    const id = e.target.closest('[data-node-id]')?.dataset.nodeId, edge = e.target.closest('[data-edge-id]')?.dataset.edgeId;
    if (flow.TYPES.includes(this.tool)) {
      e.preventDefault(); const graph = copy(this.getGraph());
      if (graph.nodes.length >= flow.MAX_NODES) { this.resetTool(); this.render(); return this.onToast(t('A flowchart can contain up to 100 nodes.'), { error: true }); }
      const p = this.point(e), node = { id: uid('node'), type: this.tool, label: this.tool === 'decision' ? t('Condition?') : this.tool === 'text' ? t('Text') : names()[this.tool], stepId: null, x: p.x, y: p.y };
      graph.nodes.push(node); this.selected = node.id; this.edge = null;
      this.drag = { mode: 'create', graph, node, origin: p, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
      this.surface.setPointerCapture(e.pointerId); this.render(); return;
    }
    if (!id) { this.selected = null; this.edge = edge || null; this.render(); return; }
    e.preventDefault(); this.selected = id; this.edge = null;
    if (this.tool === 'connect') { this.connect(id); return; }
    const graph = copy(this.getGraph()), node = graph.nodes.find(n => n.id === id), size = flow.nodeSize(node);
    this.drag = { mode: e.target.dataset.resize ? 'resize' : 'move', handle: e.target.dataset.resize, graph, node, startX: e.clientX, startY: e.clientY, x: node.x, y: node.y, ...size, pointerId: e.pointerId };
    this.surface.setPointerCapture(e.pointerId); this.render();
  }

  connect(id) {
    if (!this.connectFrom) this.connectFrom = id;
    else {
      const graph = copy(this.getGraph());
      if (graph.edges.length >= flow.MAX_EDGES) { this.resetTool(); this.render(); return this.onToast(t('A flowchart can contain up to 200 connections.'), { error: true }); }
      graph.edges.push({ id: uid('edge'), from: this.connectFrom, to: id, label: '', kind: this.connectionKind || 'arrow' });
      this.resetTool(); this.change(graph);
    }
    this.render();
  }
  pointerMove(e) {
    const d = this.drag; if (!d || d.pointerId !== e.pointerId) return;
    const dx = (e.clientX - d.startX) / this.zoom, dy = (e.clientY - d.startY) / this.zoom;
    if (d.mode === 'create') {
      if (Math.abs(dx) + Math.abs(dy) > 6) { d.node.x = Math.max(20, d.origin.x + Math.min(0, dx)); d.node.y = Math.max(20, d.origin.y + Math.min(0, dy)); Object.assign(d.node, flow.nodeSize({ width: Math.abs(dx), height: Math.abs(dy) })); }
    } else if (d.mode === 'resize') {
      const left = d.handle.includes('w'), top = d.handle.includes('n');
      const size = flow.nodeSize({ width: d.width + (left ? -dx : dx), height: d.height + (top ? -dy : dy) });
      Object.assign(d.node, size, { x: Math.max(20, left ? d.x + d.width - size.width : d.x), y: Math.max(20, top ? d.y + d.height - size.height : d.y) });
    } else { d.node.x = Math.max(20, Math.min(4000, d.x + dx)); d.node.y = Math.max(20, Math.min(4000, d.y + dy)); }
    this.render();
  }
  pointerUp(e) {
    const d = this.drag; if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    if (this.surface.hasPointerCapture(e.pointerId)) this.surface.releasePointerCapture(e.pointerId);
    this.resetTool();
    if (d.mode === 'create') { const graph = copy(this.getGraph()); if (graph.nodes.length < flow.MAX_NODES) { graph.nodes.push(d.node); this.change(graph); } else this.render(); }
    else if (d.node.x !== d.x || d.node.y !== d.y || d.node.width !== undefined && d.node.width !== d.width || d.node.height !== undefined && d.node.height !== d.height) {
      const graph = copy(this.getGraph()), current = graph.nodes.find(n => n.id === d.node.id);
      if (current) { current.x = d.node.x; current.y = d.node.y; if (d.mode === 'resize') Object.assign(current, flow.nodeSize(d.node)); this.change(graph); } else this.render();
    } else this.render();
    this.surface.querySelector(`[data-node-id="${this.selected}"]`)?.focus();
  }
  removeSelected() {
    if (!this.selected && !this.edge) return;
    const g = copy(this.getGraph()); g.nodes = g.nodes.filter(n => n.id !== this.selected); g.edges = g.edges.filter(e => e.id !== this.edge && e.from !== this.selected && e.to !== this.selected);
    this.selected = null; this.edge = null; this.resetTool(); this.change(g);
  }
  duplicateSelected() {
    const g = copy(this.getGraph()), node = g.nodes.find(n => n.id === this.selected);
    if (!node || g.nodes.length >= flow.MAX_NODES) return;
    const duplicate = { ...copy(node), id: uid('node'), x: Math.min(4000, node.x + 30), y: Math.min(4000, node.y + 30) };
    g.nodes.push(duplicate); this.selected = duplicate.id; this.resetTool(); this.change(g);
  }
  keyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.drag = null; this.selected = null; this.edge = null; this.resetTool(); this.render(); return; }
    const id = e.target.closest('[data-node-id]')?.dataset.nodeId, edge = e.target.closest('[data-edge-id]')?.dataset.edgeId;
    if (id) { this.selected = id; this.edge = null; } else if (edge) { this.edge = edge; this.selected = null; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      if (flow.TYPES.includes(this.tool)) { const w = this.surface.parentElement; this.addNode(this.tool, { x: Math.max(20, (w.scrollLeft + 40) / this.zoom), y: Math.max(20, (w.scrollTop + 40) / this.zoom) }); }
      else if (id && this.tool === 'connect') this.connect(id);
      this.renderProperties();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.removeSelected(); }
    if (id && e.key.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); const g = copy(this.getGraph()), n = g.nodes.find(n => n.id === id), amount = e.shiftKey ? 20 : 5; n.x += e.key === 'ArrowRight' ? amount : e.key === 'ArrowLeft' ? -amount : 0; n.y += e.key === 'ArrowDown' ? amount : e.key === 'ArrowUp' ? -amount : 0; this.change(g); this.surface.querySelector(`[data-node-id="${id}"]`)?.focus(); }
  }
  showMermaid() {
    const source = el('textarea', { rows: 16, readOnly: true, 'aria-label': t('Mermaid source'), spellcheck: false }); source.value = flow.toMermaid(this.getGraph(), this.getSteps());
    const { close } = openModal({ title: t('Mermaid source'), body: source, footer: [el('button', { type: 'button', onClick: () => close() }, t('Close'))], initialFocus: source }); source.select();
  }
}
FlowchartEditor.icon = icon;
FlowchartEditor.toolButton = toolButton;
window.FlowchartEditor = FlowchartEditor;
})();
