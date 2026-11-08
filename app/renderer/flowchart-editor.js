'use strict';
(() => {
const flow = window.StepForgeFlowchart;
const copy = v => JSON.parse(JSON.stringify(v));
const uid = prefix => `${prefix}-${crypto.randomUUID()}`;

class FlowchartEditor {
  constructor({ toolbar, surface, properties, getGraph, getSteps, onChange, onPlacement, onDone, onAi, onGoToStep, onToast }) {
    Object.assign(this, { toolbar, surface, properties, getGraph, getSteps, onChange, onPlacement, onDone, onAi, onGoToStep, onToast });
    this.selected = null; this.edge = null; this.connectFrom = null; this.tool = 'select'; this.zoom = 1;
    this.buildToolbar();
    surface.addEventListener('pointerdown', e => this.pointerDown(e));
    surface.addEventListener('pointermove', e => this.pointerMove(e));
    surface.addEventListener('pointerup', e => this.pointerUp(e));
    surface.addEventListener('pointercancel', () => { this.drag = null; this.render(); });
    surface.addEventListener('dblclick', e => {
      const id = e.target.closest('[data-node-id]')?.dataset.nodeId;
      const node = this.getGraph()?.nodes.find(n => n.id === id);
      if (node?.stepId) this.onGoToStep(node.stepId);
    });
    surface.addEventListener('keydown', e => this.keyDown(e));
  }

  buildToolbar() {
    const button = (label, action) => el('button.tool', { type: 'button', onClick: action }, label);
    this.selectButton = button(t('Select'), () => { this.tool = 'select'; this.connectFrom = null; this.render(); });
    this.connectButton = button(t('Connect'), () => { this.tool = 'connect'; this.connectFrom = null; this.render(); });
    this.toolbar.append(this.selectButton,
      button(t('Add node'), () => this.addNode('step')),
      button(t('Decision'), () => this.addNode('decision')),
      button(t('Start'), () => this.addNode('start')),
      button(t('End'), () => this.addNode('end')),
      this.connectButton,
      button(t('Arrange'), () => this.change(flow.arrangeGraph(this.getGraph()))),
      button(t('Delete'), () => this.removeSelected()),
      button('−', () => { this.zoom = Math.max(0.25, this.zoom - 0.25); this.render(); }),
      button('+', () => { this.zoom = Math.min(2, this.zoom + 0.25); this.render(); }),
      this.aiButton = button(t('Generate with AI…'), () => this.onAi()),
      button(t('Mermaid source'), () => this.showMermaid()),
      el('label.flowchart-placement-picker', {}, t('Flowchart placement'),
        this.placement = el('select', { 'aria-label': t('Flowchart placement'), onChange: () => this.onPlacement(this.placement.value) },
          el('option', { value: 'main' }, t('Main visual')), el('option', { value: 'block' }, t('Content block')))),
      this.doneButton = button(t('Done'), () => this.onDone()));
  }

  change(graph) { this.onChange(flow.normalizeGraph(graph)); this.render(); }

  addNode(type) {
    const g = copy(this.getGraph());
    if (g.nodes.length >= flow.MAX_NODES) return this.onToast(t('A flowchart can contain up to 100 nodes.'), { error: true });
    const node = { id: uid('node'), type, label: type === 'decision' ? t('Condition?') : type === 'start' ? t('Start') : type === 'end' ? t('End') : t('New step'),
      stepId: null, x: 40 + g.nodes.length % 3 * 280, y: 40 + Math.floor(g.nodes.length / 3) * 180 };
    g.nodes.push(node); this.selected = node.id; this.edge = null; this.change(g);
  }

  render({ block = this.block, aiReady = this.aiReady } = {}) {
    this.block = block; this.aiReady = aiReady;
    const graph = this.drag?.graph || this.getGraph();
    if (!graph) return;
    this.placement.value = block ? 'block' : 'main'; this.doneButton.hidden = !block;
    this.aiButton.hidden = !aiReady;
    this.selectButton.classList.toggle('active', this.tool === 'select');
    this.connectButton.classList.toggle('active', this.tool === 'connect');
    this.connectButton.setAttribute('aria-pressed', String(this.tool === 'connect'));
    const g = flow.geometry(graph);
    this.surface.innerHTML = flow.toSvg(graph, this.getSteps(), { selected: this.selected, selectedEdge: this.edge, interactive: true, background: false });
    const svg = this.surface.querySelector('svg');
    svg.style.width = `${g.width * this.zoom}px`; svg.style.height = `${g.height * this.zoom}px`;
    this.surface.setAttribute('aria-label', this.tool === 'connect' ? t('Select two nodes to connect them.') : t('Flowchart editor'));
    if (!this.drag) this.renderProperties();
  }

  renderProperties() {
    clearNode(this.properties);
    const graph = this.getGraph(), node = graph?.nodes.find(n => n.id === this.selected), edge = graph?.edges.find(e => e.id === this.edge);
    if (!node && !edge) {
      this.properties.append(el('span.muted', {}, this.tool === 'connect' ? t('Select two nodes to connect them.') : t('Add nodes, drag to move them, or select a node to edit it.')));
      return;
    }
    const label = el('input', { value: (node || edge).label, maxLength: node ? 300 : 80, 'aria-label': t('Label') });
    label.addEventListener('change', () => {
      const g = copy(this.getGraph()), item = node ? g.nodes.find(n => n.id === node.id) : g.edges.find(e => e.id === edge.id);
      if (item) { item.label = label.value; this.change(g); }
    });
    this.properties.append(el('label', {}, t('Label'), label));
    if (node) {
      const type = el('select', { 'aria-label': t('Node type') },
        ...[['step', t('Step')], ['decision', t('Decision')], ['start', t('Start')], ['end', t('End')]].map(([value, name]) => el('option', { value, selected: node.type === value }, name)));
      type.addEventListener('change', () => { const g = copy(this.getGraph()); g.nodes.find(n => n.id === node.id).type = type.value; this.change(g); });
      const target = el('select', { 'aria-label': t('Go to step') }, el('option', { value: '' }, t('No linked step')),
        ...this.getSteps().map(s => el('option', { value: s.stepId, selected: node.stepId === s.stepId }, `${s.number}. ${s.title || t('Untitled step')}`)));
      target.addEventListener('change', () => { const g = copy(this.getGraph()); g.nodes.find(n => n.id === node.id).stepId = target.value || null; this.change(g); });
      this.properties.append(el('label', {}, t('Node type'), type), el('label', {}, t('Go to step'), target));
      if (node.stepId) this.properties.append(el('button', { type: 'button', onClick: () => this.onGoToStep(node.stepId) }, t('Open linked step')));
    }
  }

  pointerDown(e) {
    if (e.button !== 0) return;
    const id = e.target.closest('[data-node-id]')?.dataset.nodeId;
    const edge = e.target.closest('[data-edge-id]')?.dataset.edgeId;
    if (!id) { this.selected = null; this.edge = edge || null; this.render(); return; }
    e.preventDefault();
    this.selected = id; this.edge = null;
    if (this.tool === 'connect') {
      if (!this.connectFrom) this.connectFrom = id;
      else {
        const g = copy(this.getGraph());
        if (g.edges.length >= flow.MAX_EDGES) return this.onToast(t('A flowchart can contain up to 200 connections.'), { error: true });
        g.edges.push({ id: uid('edge'), from: this.connectFrom, to: id, label: '' }); this.connectFrom = null; this.change(g);
      }
      this.render(); return;
    }
    const g = copy(this.getGraph()), node = g.nodes.find(n => n.id === id);
    this.drag = { graph: g, node, startX: e.clientX, startY: e.clientY, x: node.x, y: node.y, pointerId: e.pointerId };
    this.surface.setPointerCapture(e.pointerId); this.render();
  }

  pointerMove(e) {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    const d = this.drag;
    d.node.x = Math.max(20, Math.min(4000, d.x + (e.clientX - d.startX) / this.zoom));
    d.node.y = Math.max(20, Math.min(4000, d.y + (e.clientY - d.startY) / this.zoom));
    this.render();
  }

  pointerUp(e) {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    const d = this.drag; this.drag = null;
    if (this.surface.hasPointerCapture(e.pointerId)) this.surface.releasePointerCapture(e.pointerId);
    if (d.node.x !== d.x || d.node.y !== d.y) {
      const graph = copy(this.getGraph()), current = graph.nodes.find(n => n.id === d.node.id);
      // An agent may edit another node while this drag is in progress. Commit
      // only this node's position against the latest graph.
      if (current) { current.x = d.node.x; current.y = d.node.y; this.change(graph); } else this.render();
    } else this.render();
    this.surface.querySelector(`[data-node-id="${this.selected}"]`)?.focus();
  }

  removeSelected() {
    if (!this.selected && !this.edge) return;
    const g = copy(this.getGraph());
    g.nodes = g.nodes.filter(n => n.id !== this.selected);
    g.edges = g.edges.filter(e => e.id !== this.edge && e.from !== this.selected && e.to !== this.selected);
    if (this.connectFrom === this.selected) this.connectFrom = null;
    this.selected = null; this.edge = null; this.change(g);
  }

  keyDown(e) {
    const id = e.target.closest('[data-node-id]')?.dataset.nodeId;
    const edge = e.target.closest('[data-edge-id]')?.dataset.edgeId;
    if (id) { this.selected = id; this.edge = null; }
    else if (edge) { this.edge = edge; this.selected = null; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      if (id && this.tool === 'connect') {
        if (!this.connectFrom) this.connectFrom = id;
        else { const g = copy(this.getGraph()); if (g.edges.length < flow.MAX_EDGES) { g.edges.push({ id: uid('edge'), from: this.connectFrom, to: id, label: '' }); this.connectFrom = null; this.change(g); } }
      }
      this.renderProperties();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.removeSelected(); }
    if (id && e.key.startsWith('Arrow')) {
      e.preventDefault(); e.stopPropagation();
      const g = copy(this.getGraph()), n = g.nodes.find(n => n.id === id), amount = e.shiftKey ? 20 : 5;
      n.x += e.key === 'ArrowRight' ? amount : e.key === 'ArrowLeft' ? -amount : 0;
      n.y += e.key === 'ArrowDown' ? amount : e.key === 'ArrowUp' ? -amount : 0;
      this.change(g); this.surface.querySelector(`[data-node-id="${id}"]`)?.focus();
    }
  }

  showMermaid() {
    const source = el('textarea', { rows: 16, readOnly: true, 'aria-label': t('Mermaid source'), spellcheck: false });
    source.value = flow.toMermaid(this.getGraph(), this.getSteps());
    const { close } = openModal({ title: t('Mermaid source'), body: source,
      footer: [el('button', { type: 'button', onClick: () => close() }, t('Close'))], initialFocus: source });
    source.select();
  }
}
window.FlowchartEditor = FlowchartEditor;
})();
