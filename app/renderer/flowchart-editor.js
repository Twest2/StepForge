'use strict';

/**
 * The flowchart drawing surface shown in the canvas pane when the toolbar's
 * Image/Flowchart menu is on Flowchart. It draws core/flowchart.js's SVG and
 * turns pointer and key input into graph edits. The graph belongs to the step;
 * the editor (editor.js) owns saving and undo through these callbacks:
 *
 *   getGraph()      the step's flowchart, or null
 *   beforeChange()  called before every edit; returns the graph to change
 *                   (creating it), after taking an undo snapshot
 *   changed()       called after every edit
 *   getSteps()      [{ stepId, number }] for "→ Step 3" captions
 *   stepLabel(n)    the caption's words
 *   onSelect(sel)   the selection changed: { kind: 'node'|'edge', id } or null
 *   onToolChange(tool)
 */
(() => {
  const flow = window.StepForgeFlowchart;
  const SHAPE_TOOLS = flow.SHAPES;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 3;
  const snap = (v) => Math.round(v / flow.GRID) * flow.GRID;

  class FlowchartEditor {
    constructor(host, cb) {
      this.host = host;
      this.cb = cb;
      this.tool = 'select';
      this.selected = null;
      this.drag = null;
      this.pendingFrom = null;
      this.zoom = 1;
      // The chart point at the layer's top-left corner (render() keeps room on every side).
      this.origin = null;
      this.layer = document.createElement('div');
      this.layer.className = 'flowchart-layer';
      this.hint = document.createElement('div');
      this.hint.className = 'flowchart-hint';
      host.append(this.layer, this.hint);
      host.tabIndex = 0;
      host.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      host.addEventListener('pointermove', (e) => this.onPointerMove(e));
      host.addEventListener('pointerup', (e) => this.onPointerUp(e));
      host.addEventListener('pointercancel', () => { this.drag = null; host.classList.remove('panning'); this.render(); });
      host.addEventListener('dblclick', (e) => this.onDoubleClick(e));
      // Ctrl + mouse wheel zooms around the pointer.
      host.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
      }, { passive: false });
    }

    /** Zoom to `zoom`, keeping the chart point under `anchor` (client coordinates) in place. */
    setZoom(zoom, anchor = null) {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom) || 1));
      const hostRect = this.host.getBoundingClientRect();
      const at = anchor || { x: hostRect.left + this.host.clientWidth / 2, y: hostRect.top + this.host.clientHeight / 2 };
      const chart = this.point({ clientX: at.x, clientY: at.y });
      this.closeLabelEditor(true);
      this.zoom = next;
      this.render();
      this.host.scrollLeft = (chart.x - this.origin.x) * next - (at.x - hostRect.left);
      this.host.scrollTop = (chart.y - this.origin.y) * next - (at.y - hostRect.top);
      this.cb.onZoom?.(next);
    }

    graph() {
      return this.cb.getGraph() || { nodes: [], edges: [] };
    }

    node(id) {
      return this.graph().nodes.find((n) => n.id === id) || null;
    }

    renderOptions() {
      return { steps: this.cb.getSteps(), stepLabel: this.cb.stepLabel };
    }

    edgeColor() {
      const color = window.getComputedStyle?.(this.host).getPropertyValue('--flow-edge').trim();
      return color || undefined;
    }

    /** The chart's background color on the canvas (the dots stay); the theme's canvas when unset or transparent. */
    applyBackground(background) {
      const custom = /^#[0-9a-f]{6}$/i.test(background || '');
      const style = this.host.style;
      if (custom) {
        const dark = flow.isDark(background);
        style.setProperty('--flow-bg', background);
        style.setProperty('--flow-dot', dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(15, 23, 42, 0.2)');
        style.setProperty('--flow-edge', flow.edgeColorOn(background));
      } else {
        for (const name of ['--flow-bg', '--flow-dot', '--flow-edge']) style.removeProperty(name);
      }
      const canvas = window.getComputedStyle?.(this.host).getPropertyValue('--flow-bg').trim();
      return flow.isDark(canvas);
    }

    /** Pick a tool; Connect takes the style of the arrows it draws (core/flowchart.js EDGE_STYLES). */
    setTool(tool, { edgeStyle = 'arrow' } = {}) {
      this.tool = tool;
      this.edgeStyle = tool === 'connect' ? edgeStyle : 'arrow';
      this.pendingFrom = null;
      this.drag = null;
      this.host.dataset.tool = tool;
      this.render();
      this.cb.onToolChange?.(tool);
    }

    select(selection) {
      this.selected = selection;
      this.render();
      this.cb.onSelect?.(selection);
    }

    /** Forget a selection that no longer exists (after undo, or another step). */
    reset() {
      const g = this.graph();
      const s = this.selected;
      if (s && !(s.kind === 'node' ? g.nodes : g.edges).some((item) => item.id === s.id)) this.selected = null;
      this.drag = null;
      this.pendingFrom = null;
      this.closeLabelEditor(false);
      this.render();
    }

    /** Pointer position in chart coordinates. */
    point(e) {
      const rect = this.layer.getBoundingClientRect();
      const o = this.origin || { x: 0, y: 0 };
      return { x: (e.clientX - rect.left) / this.zoom + o.x, y: (e.clientY - rect.top) / this.zoom + o.y };
    }

    hitAt(target) {
      const node = target?.closest?.('[data-node-id]');
      if (node) return { kind: 'node', id: node.dataset.nodeId };
      const edge = target?.closest?.('[data-edge-id]');
      if (edge) return { kind: 'edge', id: edge.dataset.edgeId };
      return null;
    }

    render() {
      const g = this.graph();
      const options = this.renderOptions();
      const b = flow.bounds(g, options);
      // Room to move the view (and drag shapes) past the chart on every side:
      // 60% of the visible area beyond the shapes, left and up as well as right and down.
      const z = this.zoom;
      const roomX = (this.host.clientWidth * 0.6) / z;
      const roomY = (this.host.clientHeight * 0.6) / z;
      const origin = { x: Math.min(0, b ? b.x : 0) - roomX, y: Math.min(0, b ? b.y : 0) - roomY };
      const right = (b ? b.x + b.w + 40 : 0) + roomX;
      const bottom = (b ? b.y + b.h + 40 : 0) + roomY;
      const width = right - origin.x;
      const height = bottom - origin.y;
      this.host.style.setProperty('--flow-grid', `${flow.GRID * z}px`);
      const dark = this.applyBackground(g.background);
      let svg = flow.toSvg(g, {
        ...options, editor: true, dark, width, height, viewX: origin.x, viewY: origin.y, zoom: z, idPrefix: 'ed-', edgeColor: this.edgeColor(),
        selectedId: this.selected?.id || null, pendingFromId: this.pendingFrom,
      });
      if (this.drag?.type === 'connect' && this.drag.moved) {
        const from = this.node(this.drag.from);
        if (from) {
          const box = flow.nodeBox(from, options);
          svg = svg.replace(/<\/svg>$/, `<line x1="${box.cx}" y1="${box.cy}" x2="${this.drag.to.x}" y2="${this.drag.to.y}" stroke="#2563eb" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/></svg>`);
        }
      }
      this.layer.innerHTML = svg;
      this.layer.style.width = `${width * z}px`;
      this.layer.style.height = `${height * z}px`;
      // When the room on the left or top grows or shrinks, scroll by as much so nothing on screen jumps.
      const before = this.origin;
      this.origin = origin;
      if (before) {
        this.host.scrollLeft += (before.x - origin.x) * z;
        this.host.scrollTop += (before.y - origin.y) * z;
      }
      this.hint.hidden = g.nodes.length > 0;
      this.hint.textContent = t('Pick a shape in the toolbar, then click here to place it.');
    }

    /** Scroll so the chart's top-left corner is at the top-left of the view (a step just opened). */
    home() {
      this.render();
      const b = flow.bounds(this.graph(), this.renderOptions());
      const z = this.zoom;
      this.host.scrollLeft = (Math.min(0, b ? b.x - 20 : 0) - this.origin.x) * z;
      this.host.scrollTop = (Math.min(0, b ? b.y - 20 : 0) - this.origin.y) * z;
    }

    /** Add a shape centered on p; its text box opens at once (or on pointerup, when `fromPointer`). */
    addNode(shape, p, { fromPointer = false } = {}) {
      const g = this.cb.beforeChange();
      const node = { id: flow.newId('node'), shape, label: '', x: 0, y: 0, stepId: null };
      const box = flow.nodeBox(node);
      node.x = snap(p.x - box.w / 2);
      node.y = snap(p.y - box.h / 2);
      g.nodes.push(node);
      this.cb.changed();
      if (this.tool !== 'select') this.setTool('select');
      this.select({ kind: 'node', id: node.id });
      // The pointerdown's default action focuses the surface, which would close
      // a text box opened now; open it when the button comes up instead.
      if (fromPointer) this.editOnPointerUp = { kind: 'node', id: node.id };
      else this.editLabel({ kind: 'node', id: node.id });
    }

    connect(from, to) {
      this.pendingFrom = null;
      const g = this.graph();
      if (from === to || g.edges.some((e) => e.from === from && e.to === to)) {
        this.render();
        return;
      }
      const graph = this.cb.beforeChange();
      const edge = { id: flow.newId('edge'), from, to, label: '', ...(this.edgeStyle && this.edgeStyle !== 'arrow' ? { style: this.edgeStyle } : {}) };
      graph.edges.push(edge);
      this.cb.changed();
      this.setTool('select');
      this.select({ kind: 'edge', id: edge.id });
      // A decision's arrows want a label (Yes / No) straight away.
      if (this.node(from)?.shape === 'decision') this.editLabel({ kind: 'edge', id: edge.id });
    }

    onPointerDown(e) {
      // Middle button drags the view anywhere.
      if (e.button === 1) {
        e.preventDefault();
        this.startPan(e);
        return;
      }
      if (e.button !== 0 || e.target.closest('.flowchart-label-editor')) return;
      this.closeLabelEditor(true);
      this.host.focus({ preventScroll: true });
      const p = this.point(e);
      const hit = this.hitAt(e.target);
      if (SHAPE_TOOLS.includes(this.tool)) {
        this.addNode(this.tool, p, { fromPointer: true });
        return;
      }
      if (this.tool === 'connect') {
        if (hit?.kind !== 'node') {
          this.pendingFrom = null;
          this.render();
          return;
        }
        if (this.pendingFrom && this.pendingFrom !== hit.id) {
          this.connect(this.pendingFrom, hit.id);
          return;
        }
        this.drag = { type: 'connect', from: hit.id, to: p, moved: false };
        this.host.setPointerCapture?.(e.pointerId);
        return;
      }
      if (!hit) {
        // Dragging empty space moves around the canvas.
        this.select(null);
        this.startPan(e);
        return;
      }
      const resizing = e.target.closest?.('[data-resize]') && this.selected?.kind === 'node';
      if (resizing) {
        const n = this.node(this.selected.id);
        const box = flow.nodeBox(n, this.renderOptions());
        this.drag = { type: 'resize', id: n.id, start: p, origin: { w: box.w, h: box.h }, moved: false };
        this.host.setPointerCapture?.(e.pointerId);
        return;
      }
      this.select(hit);
      if (hit.kind === 'node') {
        const n = this.node(hit.id);
        this.drag = { type: 'move', id: hit.id, start: p, origin: { x: n.x, y: n.y }, moved: false };
        this.host.setPointerCapture?.(e.pointerId);
      }
    }

    startPan(e) {
      this.drag = { type: 'pan', x: e.clientX, y: e.clientY, left: this.host.scrollLeft, top: this.host.scrollTop };
      this.host.classList.add('panning');
      this.host.setPointerCapture?.(e.pointerId);
    }

    onPointerMove(e) {
      const drag = this.drag;
      if (!drag) return;
      if (drag.type === 'pan') {
        this.host.scrollLeft = drag.left - (e.clientX - drag.x);
        this.host.scrollTop = drag.top - (e.clientY - drag.y);
        return;
      }
      const p = this.point(e);
      if (drag.type === 'connect') {
        drag.to = p;
        drag.moved = true;
        this.render();
        return;
      }
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        this.cb.beforeChange();
        drag.moved = true;
      }
      const n = this.node(drag.id);
      if (!n) return;
      if (drag.type === 'resize') {
        n.w = Math.max(40, Math.round((drag.origin.w + dx) / 10) * 10);
        n.h = Math.max(30, Math.round((drag.origin.h + dy) / 10) * 10);
      } else {
        n.x = snap(drag.origin.x + dx);
        n.y = snap(drag.origin.y + dy);
      }
      this.render();
    }

    onPointerUp(e) {
      if (this.editOnPointerUp) {
        const target = this.editOnPointerUp;
        this.editOnPointerUp = null;
        this.editLabel(target);
        return;
      }
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;
      if (drag.type === 'pan') {
        this.host.classList.remove('panning');
        return;
      }
      if (drag.type === 'move' || drag.type === 'resize') {
        if (drag.moved) this.cb.changed();
        return;
      }
      const hit = this.hitAt(document.elementFromPoint(e.clientX, e.clientY));
      if (hit?.kind === 'node' && hit.id !== drag.from) {
        this.connect(drag.from, hit.id);
      } else if (!drag.moved || hit?.id === drag.from) {
        // A click on a node: the next node clicked gets the arrow.
        this.pendingFrom = drag.from;
        this.render();
      } else {
        this.render();
      }
    }

    onDoubleClick(e) {
      if (e.target.closest('.flowchart-label-editor')) return;
      const hit = this.hitAt(e.target);
      if (hit) this.editLabel(hit);
      else if (this.tool === 'select') this.addNode('process', this.point(e));
    }

    /** Keys while the flowchart is shown. Returns true when the key was used. */
    handleKey(e) {
      if (e.key === 'Escape') {
        if (this.tool !== 'select') this.setTool('select');
        else this.select(null);
        return true;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.deleteSelected();
        return true;
      }
      if (e.key === 'Enter' && this.selected) {
        this.editLabel(this.selected);
        return true;
      }
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (step && this.selected?.kind === 'node') {
        this.cb.beforeChange();
        const n = this.node(this.selected.id);
        if (n) {
          n.x = n.x + step[0] * flow.GRID;
          n.y = n.y + step[1] * flow.GRID;
        }
        this.cb.changed();
        this.render();
        return true;
      }
      return false;
    }

    deleteSelected() {
      const s = this.selected;
      if (!s) return;
      const g = this.cb.beforeChange();
      if (s.kind === 'node') {
        g.nodes = g.nodes.filter((n) => n.id !== s.id);
        g.edges = g.edges.filter((edge) => edge.from !== s.id && edge.to !== s.id);
      } else {
        g.edges = g.edges.filter((edge) => edge.id !== s.id);
      }
      this.cb.changed();
      this.select(null);
    }

    arrange() {
      const g = this.cb.beforeChange();
      const arranged = flow.arrange(g);
      g.nodes = arranged.nodes;
      g.edges = arranged.edges;
      this.cb.changed();
      this.render();
    }

    /** Type a node's or arrow's text in place. Enter saves, Escape cancels. */
    editLabel(target) {
      this.closeLabelEditor(true);
      const g = this.graph();
      const options = this.renderOptions();
      let item;
      let box;
      if (target.kind === 'node') {
        item = g.nodes.find((n) => n.id === target.id);
        if (!item) return;
        const b = flow.nodeBox(item, options);
        box = { x: b.x + 8, y: b.cy - 18, w: b.w - 16 };
      } else {
        item = g.edges.find((e) => e.id === target.id);
        const a = item && this.node(item.from);
        const z = item && this.node(item.to);
        if (!a || !z) return;
        const ba = flow.nodeBox(a, options);
        const bz = flow.nodeBox(z, options);
        box = { x: (ba.cx + bz.cx) / 2 - 60, y: (ba.cy + bz.cy) / 2 - 18, w: 120 };
      }
      const input = document.createElement('textarea');
      input.className = 'flowchart-label-editor';
      input.value = item.label || '';
      input.rows = target.kind === 'node' ? 2 : 1;
      input.maxLength = target.kind === 'node' ? 300 : 80;
      input.setAttribute('aria-label', target.kind === 'node' ? t('Shape text') : t('Arrow label'));
      const z = this.zoom;
      const o = this.origin || { x: 0, y: 0 };
      Object.assign(input.style, { left: `${(box.x - o.x) * z}px`, top: `${(box.y - o.y) * z}px`, width: `${box.w * z}px`, fontSize: `${14 * z}px` });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.closeLabelEditor(true); this.host.focus({ preventScroll: true }); }
        if (e.key === 'Escape') { e.preventDefault(); this.closeLabelEditor(false); this.host.focus({ preventScroll: true }); }
      });
      input.addEventListener('blur', () => this.closeLabelEditor(true));
      this.editing = { target, input };
      this.host.append(input);
      input.focus();
      input.select();
    }

    closeLabelEditor(commit) {
      const editing = this.editing;
      if (!editing) return;
      this.editing = null;
      editing.input.remove();
      if (!commit) return;
      const value = editing.input.value.replace(/\s+/g, ' ').trim();
      const list = editing.target.kind === 'node' ? this.graph().nodes : this.graph().edges;
      const current = list.find((item) => item.id === editing.target.id);
      if (!current || (current.label || '') === value) return;
      const g = this.cb.beforeChange();
      const item = (editing.target.kind === 'node' ? g.nodes : g.edges).find((i) => i.id === editing.target.id);
      if (item) item.label = value;
      this.cb.changed();
      this.render();
      this.cb.onSelect?.(this.selected);
    }
  }

  window.FlowchartEditor = FlowchartEditor;
})();
