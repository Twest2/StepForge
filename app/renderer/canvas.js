'use strict';

(() => {

/**
 * AnnotationCanvas: renders a step's working image plus its normalized
 * annotation scene graph, and provides editing interactions (create, select,
 * move, resize, nudge, crop). Geometry rules mirror core/raster.js so the
 * editor shows what exports produce.
 */

const DRAW_ORDER = { blur: 0, highlight: 1, magnify: 2, rect: 3, oval: 3, line: 3, arrow: 3, cursor: 4, number: 5, text: 6, tooltip: 7 };
const POINT_TOOLS = new Set(['line', 'arrow']);
const HANDLE_SIZE = 8;

class AnnotationCanvas {
  constructor(canvasEl, callbacks = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.cb = callbacks; // { onChange, onSelect, onCrop, onRequestText }
    this.image = null;   // HTMLImageElement
    this.imgW = 0;
    this.imgH = 0;
    this.annotations = [];
    this.tool = 'select';
    this.zoomMode = 'fit';
    this.scale = 1;
    this.selectedId = null;
    this.drag = null;
    this.cropRect = null;
    this.focusedView = null;

    canvasEl.addEventListener('pointerdown', (e) => this.onDown(e));
    canvasEl.addEventListener('pointermove', (e) => this.onMove(e));
    canvasEl.addEventListener('pointerup', (e) => this.onUp(e));
    canvasEl.addEventListener('dblclick', (e) => this.onDblClick(e));
  }

  setImage(image, w, h) {
    this.image = image;
    this.imgW = w || 0;
    this.imgH = h || 0;
    this.cropRect = null;
    if (!image || !this.imgW || !this.imgH) {
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.render();
      return;
    }
    this.applyZoom();
  }

  setAnnotations(annotations) {
    this.annotations = annotations || [];
    if (!this.annotations.some((a) => a.id === this.selectedId)) this.selectedId = null;
    this.render();
  }

  // The focused view crops and zooms the canvas itself to match what
  // exports produce. Annotation data stays in full-image-normalized
  // coordinates; only the on-screen viewport changes.
  setFocusedView(focusedView) {
    this.focusedView = focusedView || null;
    this.render();
  }

  setTool(tool) {
    this.tool = tool;
    this.cropRect = null;
    if (tool !== 'select') this.select(null);
    this.render();
  }

  setZoom(mode) {
    this.zoomMode = mode;
    this.applyZoom();
  }

  applyZoom() {
    if (!this.image) return;
    const wrap = this.canvas.parentElement;
    if (this.zoomMode === 'fit') {
      const availW = Math.max(100, wrap.clientWidth - 40);
      const availH = Math.max(100, wrap.clientHeight - 40);
      this.scale = Math.min(availW / this.imgW, availH / this.imgH, 1);
    } else {
      this.scale = Number(this.zoomMode) || 1;
    }
    this.canvas.width = Math.round(this.imgW * this.scale);
    this.canvas.height = Math.round(this.imgH * this.scale);
    this.render();
  }

  select(id) {
    this.selectedId = id;
    if (this.cb.onSelect) this.cb.onSelect(this.annotations.find((a) => a.id === id) || null);
    this.render();
  }

  selected() {
    return this.annotations.find((a) => a.id === this.selectedId) || null;
  }

  changed() {
    if (this.cb.onChange) this.cb.onChange(this.annotations);
    this.render();
  }

  // ---- coordinate helpers ----
  // The focused-view crop region, in coordinates normalized to the full
  // image (0..1). Identity rect when focused view is off, matching
  // core/raster.js applyFocusedView. panX/panY are 0..1 fractions of the
  // available pan range (0 = left/bottom edge, 1 = right/top edge), so the
  // slider's full range always pans the crop across the whole image
  // regardless of zoom. Y is inverted so panY increases upward.
  viewRect() {
    const fv = this.focusedView;
    if (!fv || !fv.enabled || !(fv.zoom > 1)) return { x: 0, y: 0, w: 1, h: 1 };
    const w = 1 / fv.zoom, h = 1 / fv.zoom;
    const panX = fv.panX ?? 0.5, panY = fv.panY ?? 0.5;
    return { x: panX * (1 - w), y: (1 - panY) * (1 - h), w, h };
  }

  toNorm(e) {
    const rect = this.canvas.getBoundingClientRect();
    const r = this.viewRect();
    return {
      x: r.x + ((e.clientX - rect.left) / rect.width) * r.w,
      y: r.y + ((e.clientY - rect.top) / rect.height) * r.h,
    };
  }

  px(ann) {
    const r = this.viewRect();
    return {
      x: (ann.x - r.x) / r.w * this.canvas.width,
      y: (ann.y - r.y) / r.h * this.canvas.height,
      w: ann.w / r.w * this.canvas.width,
      h: ann.h / r.h * this.canvas.height,
    };
  }

  // Converts a canvas-pixel point to image-pixel coordinates in the
  // full (uncropped) source image, for sampling `this.image` directly.
  toImagePx(x, y) {
    const r = this.viewRect();
    return {
      x: (x / this.canvas.width * r.w + r.x) * this.imgW,
      y: (y / this.canvas.height * r.h + r.y) * this.imgH,
    };
  }

  toImageLen(len, axis) {
    const r = this.viewRect();
    return axis === 'y' ? len / this.canvas.height * r.h * this.imgH : len / this.canvas.width * r.w * this.imgW;
  }

  // ---- rendering ----
  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.image) return;
    ctx.imageSmoothingEnabled = true;
    const r = this.viewRect();
    ctx.drawImage(this.image,
      r.x * this.imgW, r.y * this.imgH, r.w * this.imgW, r.h * this.imgH,
      0, 0, canvas.width, canvas.height);

    const ordered = [...this.annotations].sort((a, b) => (DRAW_ORDER[a.type] ?? 3) - (DRAW_ORDER[b.type] ?? 3));
    for (const ann of ordered) this.drawAnnotation(ann);

    const sel = this.selected();
    if (sel) this.drawSelection(sel);
    if (this.cropRect) this.drawCropOverlay();
  }

  // Annotation strokes/fonts are sized relative to the full image, then
  // magnified by the focused-view crop on export (core/raster.js) — divide
  // by the view rect so the canvas preview matches that magnification.
  strokePx(ann) {
    const r = this.viewRect();
    return Math.max(1, ((ann.style && ann.style.strokeWidth) || 3) * this.canvas.width / 1000 / r.w);
  }

  fontPx(ann) {
    const r = this.viewRect();
    return Math.max(9, ((ann.style && ann.style.fontSize) || 0.022) * this.canvas.height / r.h);
  }

  drawAnnotation(ann) {
    const { ctx } = this;
    const { x, y, w, h } = this.px(ann);
    const style = ann.style || {};
    const stroke = style.stroke || '#E5484D';
    const fill = style.fill && style.fill !== 'transparent' ? style.fill : null;
    ctx.save();
    ctx.lineWidth = this.strokePx(ann);
    ctx.strokeStyle = stroke;

    switch (ann.type) {
      case 'rect':
        if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
        ctx.strokeRect(x, y, w, h);
        break;
      case 'oval':
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        ctx.stroke();
        break;
      case 'line':
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.stroke();
        break;
      case 'arrow': {
        const len = Math.hypot(w, h) || 1;
        const head = Math.min(len * 0.4, Math.max(10, ctx.lineWidth * 4));
        const ux = w / len, uy = h / len;
        const bx = x + w - ux * head, by = y + h - uy * head;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx, by); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + w, y + h);
        ctx.lineTo(bx - uy * head * 0.5, by + ux * head * 0.5);
        ctx.lineTo(bx + uy * head * 0.5, by - ux * head * 0.5);
        ctx.closePath();
        ctx.fillStyle = stroke; ctx.fill();
        break;
      }
      case 'blur': {
        // preview: pixelate the region by down/up-scaling
        const f = Math.max(6, (ann.radius || 8));
        try {
          ctx.imageSmoothingEnabled = true;
          const tw = Math.max(1, Math.round(w / f)), th = Math.max(1, Math.round(h / f));
          const off = document.createElement('canvas');
          off.width = tw; off.height = th;
          off.getContext('2d').drawImage(this.canvas, x, y, w, h, 0, 0, tw, th);
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(off, 0, 0, tw, th, x, y, w, h);
        } catch { /* region may be degenerate while dragging */ }
        break;
      }
      case 'highlight':
        ctx.fillStyle = 'rgba(255, 235, 59, 0.41)';
        ctx.fillRect(x, y, w, h);
        break;
      case 'magnify': {
        const zoom = ann.zoom || 2;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        ctx.clip();
        const sw = w / zoom, sh = h / zoom;
        const center = this.toImagePx(x + w / 2, y + h / 2);
        const srcW = this.toImageLen(sw, 'x');
        const srcH = this.toImageLen(sh, 'y');
        ctx.drawImage(
          this.image,
          center.x - srcW / 2, center.y - srcH / 2,
          srcW, srcH,
          x, y, w, h
        );
        ctx.restore();
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'text': {
        ctx.font = `600 ${this.fontPx(ann)}px system-ui, sans-serif`;
        ctx.fillStyle = stroke;
        ctx.textBaseline = 'top';
        let ty = y;
        for (const line of String(ann.text || 'Text').split('\n')) {
          ctx.fillText(line, x, ty);
          ty += this.fontPx(ann) * 1.25;
        }
        break;
      }
      case 'tooltip': {
        const bg = fill || '#1F2937';
        const ts = Math.max(6, Math.min(Math.abs(w), Math.abs(h)) * 0.25);
        ctx.fillStyle = bg;
        ctx.beginPath();
        const r = 6;
        ctx.roundRect(x, y, w, h, r);
        ctx.fill();
        const tail = style.tail || 'bottom';
        ctx.beginPath();
        if (tail === 'bottom') { ctx.moveTo(x + w / 2 - ts, y + h); ctx.lineTo(x + w / 2 + ts, y + h); ctx.lineTo(x + w / 2, y + h + ts * 1.4); }
        if (tail === 'top') { ctx.moveTo(x + w / 2 - ts, y); ctx.lineTo(x + w / 2 + ts, y); ctx.lineTo(x + w / 2, y - ts * 1.4); }
        if (tail === 'left') { ctx.moveTo(x, y + h / 2 - ts); ctx.lineTo(x, y + h / 2 + ts); ctx.lineTo(x - ts * 1.4, y + h / 2); }
        if (tail === 'right') { ctx.moveTo(x + w, y + h / 2 - ts); ctx.lineTo(x + w, y + h / 2 + ts); ctx.lineTo(x + w + ts * 1.4, y + h / 2); }
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = style.textColor || '#fff';
        ctx.font = `600 ${this.fontPx(ann)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(ann.text || '…'), x + w / 2, y + h / 2, Math.abs(w) - 8);
        break;
      }
      case 'number': {
        const rr = Math.max(8, Math.min(Math.abs(w), Math.abs(h)) / 2);
        ctx.fillStyle = stroke;
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = style.textColor || '#fff';
        ctx.font = `700 ${rr}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(ann.value ?? '?'), x + w / 2, y + h / 2 + 1);
        break;
      }
      case 'cursor': {
        const s = Math.max(12, Math.min(Math.abs(w), Math.abs(h)));
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = Math.max(1, s / 12);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x, y + s); ctx.lineTo(x + s * 0.28, y + s * 0.75);
        ctx.lineTo(x + s * 0.45, y + s * 1.05); ctx.lineTo(x + s * 0.58, y + s * 0.98);
        ctx.lineTo(x + s * 0.42, y + s * 0.68); ctx.lineTo(x + s * 0.72, y + s * 0.68);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      }
      default: break;
    }
    ctx.restore();
  }

  drawSelection(ann) {
    const { ctx } = this;
    const { x, y, w, h } = this.px(ann);
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(Math.min(x, x + w) - 3, Math.min(y, y + h) - 3, Math.abs(w) + 6, Math.abs(h) + 6);
    ctx.setLineDash([]);
    ctx.fillStyle = '#2563eb';
    for (const hd of this.handles(ann)) {
      ctx.fillRect(hd.px - HANDLE_SIZE / 2, hd.py - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    }
    ctx.restore();
  }

  handles(ann) {
    const { x, y, w, h } = this.px(ann);
    if (POINT_TOOLS.has(ann.type)) {
      return [
        { id: 'p1', px: x, py: y },
        { id: 'p2', px: x + w, py: y + h },
      ];
    }
    return [
      { id: 'nw', px: x, py: y }, { id: 'n', px: x + w / 2, py: y }, { id: 'ne', px: x + w, py: y },
      { id: 'w', px: x, py: y + h / 2 }, { id: 'e', px: x + w, py: y + h / 2 },
      { id: 'sw', px: x, py: y + h }, { id: 's', px: x + w / 2, py: y + h }, { id: 'se', px: x + w, py: y + h },
    ];
  }

  drawCropOverlay() {
    const { ctx, canvas } = this;
    const r = this.cropRect;
    const view = this.viewRect();
    const x = (Math.min(r.x0, r.x1) - view.x) / view.w * canvas.width;
    const y = (Math.min(r.y0, r.y1) - view.y) / view.h * canvas.height;
    const w = Math.abs(r.x1 - r.x0) / view.w * canvas.width;
    const h = Math.abs(r.y1 - r.y0) / view.h * canvas.height;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // ---- interactions ----
  hitTest(pt) {
    // topmost first (reverse draw order)
    const ordered = [...this.annotations].sort((a, b) => (DRAW_ORDER[b.type] ?? 3) - (DRAW_ORDER[a.type] ?? 3));
    for (const ann of ordered) {
      const x0 = Math.min(ann.x, ann.x + ann.w) - 0.008;
      const y0 = Math.min(ann.y, ann.y + ann.h) - 0.008;
      const x1 = Math.max(ann.x, ann.x + ann.w) + 0.008;
      const y1 = Math.max(ann.y, ann.y + ann.h) + 0.008;
      if (pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) return ann;
    }
    return null;
  }

  handleAt(e) {
    const sel = this.selected();
    if (!sel) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    for (const hd of this.handles(sel)) {
      if (Math.abs(px - hd.px) <= HANDLE_SIZE && Math.abs(py - hd.py) <= HANDLE_SIZE) return hd.id;
    }
    return null;
  }

  onDown(e) {
    if (!this.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this.toNorm(e);

    if (this.tool === 'crop') {
      this.cropRect = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      this.drag = { kind: 'crop' };
      return;
    }
    if (this.tool === 'select') {
      const handle = this.handleAt(e);
      if (handle) {
        this.drag = { kind: 'resize', handle, start: pt, orig: { ...this.selected() } };
        return;
      }
      const hit = this.hitTest(pt);
      this.select(hit ? hit.id : null);
      if (hit) this.drag = { kind: 'move', start: pt, orig: { ...hit } };
      return;
    }

    // creation tools
    const ann = {
      id: `ann-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      type: this.tool,
      x: pt.x, y: pt.y, w: 0, h: 0,
      text: this.tool === 'tooltip' ? 'Tooltip' : this.tool === 'text' ? 'Text' : '',
      style: this.cb.defaultStyle ? this.cb.defaultStyle(this.tool) : {},
    };
    if (this.tool === 'number') ann.value = this.cb.nextNumber ? this.cb.nextNumber() : 1;
    if (this.tool === 'magnify') ann.zoom = 2;
    if (this.tool === 'blur') ann.radius = 8;
    this.annotations.push(ann);
    this.selectedId = ann.id;
    this.drag = { kind: 'create', start: pt, ann };
  }

  onMove(e) {
    if (!this.drag) return;
    const pt = this.toNorm(e);
    const d = this.drag;

    if (d.kind === 'crop') {
      this.cropRect.x1 = pt.x;
      this.cropRect.y1 = pt.y;
      this.render();
      return;
    }
    if (d.kind === 'create') {
      d.ann.w = pt.x - d.start.x;
      d.ann.h = pt.y - d.start.y;
      this.render();
      return;
    }
    const sel = this.selected();
    if (!sel) return;
    if (d.kind === 'move') {
      sel.x = d.orig.x + (pt.x - d.start.x);
      sel.y = d.orig.y + (pt.y - d.start.y);
      this.render();
    } else if (d.kind === 'resize') {
      this.resizeBy(sel, d, pt);
      this.render();
    }
  }

  resizeBy(ann, d, pt) {
    const dx = pt.x - d.start.x;
    const dy = pt.y - d.start.y;
    const o = d.orig;
    const h = d.handle;
    if (h === 'p1') { ann.x = o.x + dx; ann.y = o.y + dy; ann.w = o.w - dx; ann.h = o.h - dy; return; }
    if (h === 'p2') { ann.w = o.w + dx; ann.h = o.h + dy; return; }
    if (h.includes('w')) { ann.x = o.x + dx; ann.w = o.w - dx; }
    if (h.includes('e')) { ann.w = o.w + dx; }
    if (h.includes('n')) { ann.y = o.y + dy; ann.h = o.h - dy; }
    if (h.includes('s')) { ann.h = o.h + dy; }
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'crop') {
      const r = this.cropRect;
      this.cropRect = null;
      const rect = {
        x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1),
        w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0),
      };
      this.render();
      if (rect.w > 0.02 && rect.h > 0.02 && this.cb.onCrop) this.cb.onCrop(rect);
      return;
    }
    if (d.kind === 'create') {
      // degenerate drags get a sensible default size
      if (Math.abs(d.ann.w) < 0.01 && Math.abs(d.ann.h) < 0.01) {
        const defaults = { number: [0.05, 0.08], text: [0.2, 0.05], tooltip: [0.18, 0.07], cursor: [0.04, 0.06] };
        const [dw, dh] = defaults[d.ann.type] || [0.15, 0.1];
        d.ann.w = dw; d.ann.h = dh;
      }
      this.normalizeRect(d.ann);
      this.changed();
      this.select(d.ann.id);
      if ((d.ann.type === 'text' || d.ann.type === 'tooltip') && this.cb.onRequestText) {
        this.cb.onRequestText(d.ann);
      }
      return;
    }
    if (d.kind === 'move' || d.kind === 'resize') {
      const sel = this.selected();
      if (sel) this.normalizeRect(sel);
      this.changed();
    }
  }

  normalizeRect(ann) {
    if (POINT_TOOLS.has(ann.type)) return; // lines keep direction
    if (ann.w < 0) { ann.x += ann.w; ann.w = -ann.w; }
    if (ann.h < 0) { ann.y += ann.h; ann.h = -ann.h; }
  }

  onDblClick(e) {
    const hit = this.hitTest(this.toNorm(e));
    if (hit && (hit.type === 'text' || hit.type === 'tooltip') && this.cb.onRequestText) {
      this.select(hit.id);
      this.cb.onRequestText(hit);
    }
  }

  nudgeSelected(dx, dy) {
    const sel = this.selected();
    if (!sel) return false;
    const r = this.viewRect();
    sel.x += dx / this.canvas.width * r.w;
    sel.y += dy / this.canvas.height * r.h;
    this.changed();
    return true;
  }

  deleteSelected() {
    if (!this.selectedId) return false;
    this.annotations = this.annotations.filter((a) => a.id !== this.selectedId);
    this.select(null);
    this.changed();
    return true;
  }
}

window.AnnotationCanvas = AnnotationCanvas;
})();
