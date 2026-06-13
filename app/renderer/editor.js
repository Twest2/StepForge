'use strict';

(() => {

const api = window.stepforge;
const dialogs = window.StepForgeDialogs || {};

const clone = (value) => JSON.parse(JSON.stringify(value));
const BLOCK_KIND_ORDER = { text: 0, code: 1, table: 2 };

function blockText(block) {
  for (const key of ['code', 'text', 'body', 'value', 'content']) {
    const value = block && block[key];
    if (value != null && value !== '') return String(value);
  }
  return '';
}

function orderedStepBlocks(step) {
  const blocks = [];
  for (const tb of step.textBlocks || []) blocks.push({ kind: 'text', block: tb });
  for (const cb of step.codeBlocks || []) blocks.push({ kind: 'code', block: cb });
  for (const tbl of step.tableBlocks || []) blocks.push({ kind: 'table', block: tbl });
  return blocks.sort((a, b) => (
    (Number.isFinite(a.block.order) ? a.block.order : 0) - (Number.isFinite(b.block.order) ? b.block.order : 0)
    || BLOCK_KIND_ORDER[a.kind] - BLOCK_KIND_ORDER[b.kind]
    || String(a.block.id || '').localeCompare(String(b.block.id || ''))
  ));
}

function nextBlockOrder(step) {
  return orderedStepBlocks(step).reduce((max, entry) => Math.max(max, Number.isFinite(entry.block.order) ? entry.block.order : 0), 0) + 1;
}

function blockLabel(kind) {
  return kind === 'text' ? 'Text block' : kind === 'code' ? 'Code block' : 'Table';
}

function stepNumberMap(steps) {
  const numbers = new Map();
  const childCounts = new Map();
  let top = 0;
  for (const step of steps) {
    let number;
    if (step.parentStepId && numbers.has(step.parentStepId)) {
      const parent = numbers.get(step.parentStepId);
      const next = (childCounts.get(step.parentStepId) || 0) + 1;
      childCounts.set(step.parentStepId, next);
      number = `${parent}.${next}`;
    } else {
      top += 1;
      number = String(top);
    }
    numbers.set(step.stepId, number);
  }
  return numbers;
}

function isEditableTarget(target) {
  return target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

class GuideEditor {
  constructor({ root, onMetaChange = () => {}, onToast = toast, onBack = () => {} } = {}) {
    this.root = root;
    this.onMetaChange = onMetaChange;
    this.onToast = onToast;
    this.onBack = onBack;

    this.guideId = null;
    this.guide = null;
    this.steps = [];
    this.stepMap = new Map();
    this.selectedStepId = null;
    this.stepSelectMode = false;
    this.selectedSteps = new Set();
    this.selectedAnnotationId = null;
    this.currentTool = 'select';
    this.currentZoom = 'fit';
    this.pendingSave = false;
    this.pendingGuideSave = false;
    this.canvasHistory = [];
    this.canvasFuture = [];
    this.beforeCanvasSnapshot = null;
    this.draggedBlock = null;
    this.stepLoadToken = 0;
    this.imageLoadToken = 0;
    this.shellMounted = false;
    this.linkedConflict = false;
    this.descriptionDirty = false;
    this.titleDirty = false;
    this.active = true;

    this.saveStepDebounced = debounce(() => this.flushStep(), 180);
    this.saveGuideDebounced = debounce(() => this.flushGuide(), 180);

    this.onDocumentKeyDown = this.onDocumentKeyDown.bind(this);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  destroy() {
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  setActive(active) {
    this.active = Boolean(active);
  }

  get currentStep() {
    return this.stepMap.get(this.selectedStepId) || null;
  }

  get currentStepNumber() {
    if (!this.currentStep) return '';
    return stepNumberMap(this.steps).get(this.currentStep.stepId) || '';
  }

  getMeta() {
    return {
      guide: this.guide ? clone(this.guide) : null,
      step: this.currentStep ? clone(this.currentStep) : null,
      stepCount: this.steps.length,
      selectedStepId: this.selectedStepId,
      selectedAnnotationId: this.selectedAnnotationId,
      linked: Boolean(this.guide && this.guide.linkedSource),
      dirty: this.pendingSave || this.pendingGuideSave || this.descriptionDirty || this.titleDirty,
      view: 'editor',
    };
  }

  emitMeta() {
    this.onMetaChange(this.getMeta());
  }

  async open(guideId, stepId = null) {
    this.guideId = guideId;
    this.selectedStepId = stepId;
    this.selectedAnnotationId = null;
    this.canvasHistory = [];
    this.canvasFuture = [];
    this.pendingSave = false;
    this.pendingGuideSave = false;
    this.setActive(true);
    await this.reload(stepId);
  }

  async reload(stepId = this.selectedStepId) {
    const token = ++this.stepLoadToken;
    const { guide, steps } = await api.guide.get({ guideId: this.guideId });
    if (token !== this.stepLoadToken) return;
    this.guide = guide;
    this.steps = steps;
    this.stepMap = new Map(steps.map((step) => [step.stepId, step]));
    if (!this.shellMounted) this.mountShell();
    // An explicitly requested step (new capture, added step, restored
    // neighbour) wins; otherwise keep the current selection if it survived.
    if (stepId && this.stepMap.has(stepId)) {
      this.selectedStepId = stepId;
    } else if (!this.selectedStepId || !this.stepMap.has(this.selectedStepId)) {
      this.selectedStepId = (steps[0] && steps[0].stepId) || null;
    }
    this.selectedAnnotationId = null;
    this.renderAll();
  }

  mountShell() {
    this.shellMounted = true;
    this.root.innerHTML = '';
    const toolButtons = [
      ['select', 'Select'],
      ['rect', 'Rect'],
      ['oval', 'Oval'],
      ['line', 'Line'],
      ['arrow', 'Arrow'],
      ['text', 'Text'],
      ['tooltip', 'Tip'],
      ['number', '#'],
      ['blur', 'Blur'],
      ['highlight', 'Hi'],
      ['magnify', 'Mag'],
      ['cursor', 'Cursor'],
      ['crop', 'Crop'],
    ];

    this.dom = {};
    this.dom.root = el('div.editor', {},
      el('aside.pane-steps', {},
        el('div.pane-head', {},
          el('div', {},
            el('div.eyebrow', {}, 'Steps'),
            this.dom.stepCount = el('div.muted', {}, '0 steps'),
          ),
          el('div.row', {},
            this.dom.addStepBtn = el('button.primary', { type: 'button' }, 'Add'),
            this.dom.importBtn = el('button', { type: 'button' }, 'Import'),
            this.dom.selectStepsBtn = el('button', { type: 'button' }, 'Select'),
          ),
        ),
        this.dom.stepsList = el('div.steps-list'),
        this.dom.stepBulkBar = el('div'),
        this.dom.paneFoot = el('div.pane-foot', {},
          this.dom.moveUpBtn = el('button.icon', { type: 'button', title: 'Move step up' }, '↑'),
          this.dom.moveDownBtn = el('button.icon', { type: 'button', title: 'Move step down' }, '↓'),
          this.dom.duplicateBtn = el('button', { type: 'button' }, 'Duplicate'),
          this.dom.deleteBtn = el('button.danger', { type: 'button' }, 'Delete'),
        ),
      ),
      el('section.pane-canvas', {},
        el('div.canvas-toolbar', {},
          ...toolButtons.map(([tool, label]) => this.dom[`tool-${tool}`] = el('button.tool', { type: 'button', dataset: { tool } }, label)),
          el('span.sep'),
          this.dom.zoomFitBtn = el('button.tool', { type: 'button' }, 'Fit'),
          this.dom.zoom100Btn = el('button.tool', { type: 'button' }, '100%'),
          this.dom.zoom125Btn = el('button.tool', { type: 'button' }, '125%'),
          this.dom.zoom150Btn = el('button.tool', { type: 'button' }, '150%'),
          el('span.sep'),
          this.dom.undoBtn = el('button.tool', { type: 'button' }, 'Undo'),
          this.dom.redoBtn = el('button.tool', { type: 'button' }, 'Redo'),
        ),
        this.dom.canvasWrap = el('div.canvas-wrap', {},
          this.dom.canvas = el('canvas', { width: 1, height: 1 }),
          this.dom.canvasEmpty = el('div.canvas-empty', {}, 'Select an image step to edit annotations.'),
        ),
      ),
      el('aside.pane-props', {},
        el('section', {},
          el('h3', {}, 'Step'),
          this.dom.titleInput = el('input', { type: 'text', placeholder: 'Step title' }),
          this.dom.statusSelect = makeSelect('todo', [
            { value: 'todo', label: 'Todo' },
            { value: 'in-progress', label: 'In progress' },
            { value: 'done', label: 'Done' },
          ]),
          el('div.row', {},
            this.dom.hiddenToggle = el('label', {}, el('input', { type: 'checkbox' }), ' Hidden'),
            this.dom.skippedToggle = el('label', {}, el('input', { type: 'checkbox' }), ' Skipped'),
          ),
          el('div.row', {},
            this.dom.forceNewPageToggle = el('label', {}, el('input', { type: 'checkbox' }), ' New page'),
            this.dom.focusedViewToggle = el('label', {}, el('input', { type: 'checkbox' }), ' Focused'),
          ),
          this.dom.focusedControls = el('div.focused-controls.hidden', {},
            el('div.form-row', {}, el('label', {}, 'Zoom'),
              this.dom.fvZoom = el('input', { type: 'range', min: 1, max: 3, step: 0.05, value: 1.5 })),
            el('div.form-row', {}, el('label', {}, 'Pan X'),
              this.dom.fvPanX = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 })),
            el('div.form-row', {}, el('label', {}, 'Pan Y'),
              this.dom.fvPanY = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 })),
            el('div.muted', {}, 'Exports crop to this view; the original image is never modified.'),
          ),
        ),
        el('section', {},
          el('h3', {}, 'Description'),
          this.dom.richToolbar = el('div.rich-toolbar', {},
            this.toolbarBtn('bold', 'Bold'),
            this.toolbarBtn('italic', 'Italic'),
            this.toolbarBtn('insertUnorderedList', 'Bullet'),
            this.toolbarBtn('insertOrderedList', 'Number'),
            this.toolbarBtn('formatBlock', 'Quote', 'blockquote'),
            this.toolbarBtn('createLink', 'Link'),
            this.toolbarBtn('removeFormat', 'Clear'),
          ),
          this.dom.descEditor = el('div.rich-editor', { contentEditable: 'true', spellcheck: true }),
        ),
        el('section', {},
          el('h3', {}, 'Annotations'),
          this.dom.annotationList = el('div', { className: 'annotation-list' }),
          this.dom.annotationEditor = el('div', { className: 'annotation-editor' }),
        ),
        el('section', {},
          el('h3', {}, 'Blocks'),
          this.dom.blocksList = el('div', { className: 'blocks-list' }),
          el('div.row', {},
            this.dom.addTextBlockBtn = el('button', { type: 'button' }, '+ Text block'),
            this.dom.addCodeBlockBtn = el('button', { type: 'button' }, '+ Code'),
            this.dom.addTableBlockBtn = el('button', { type: 'button' }, '+ Table'),
          ),
        ),
        el('section', {},
          el('h3', {}, 'Guide'),
          this.dom.guideSummary = el('div.muted', {}),
          this.dom.linkedBtn = el('button', { type: 'button' }, 'Linked guide'),
          this.dom.saveNowBtn = el('button.primary', { type: 'button' }, 'Save now'),
          this.dom.snapshotBtn = el('button', { type: 'button' }, 'Snapshot'),
        ),
      ),
    );
    this.root.append(this.dom.root);

    // canvas interactions need to snapshot the current step before the drag
    // mutates it, so undo can restore the pre-edit annotations.
    this.dom.canvas.addEventListener('pointerdown', () => {
      if (this.currentStep) this.beforeCanvasSnapshot = { step: clone(this.currentStep) };
    }, true);

    this.canvas = new AnnotationCanvas(this.dom.canvas, {
      onChange: (annotations) => this.onCanvasChange(annotations),
      onSelect: (ann) => this.onCanvasSelect(ann),
      onCrop: (rect) => this.onCanvasCrop(rect),
      onRequestText: (ann) => this.editAnnotationText(ann),
      defaultStyle: (tool) => this.defaultStyleForTool(tool),
      nextNumber: () => this.nextAnnotationNumber(),
    });

    this.resizeObserver = new ResizeObserver(() => this.canvas.applyZoom());
    this.resizeObserver.observe(this.dom.canvasWrap);

    this.bindShellEvents();
  }

  toolbarBtn(action, label, block = null) {
    return el('button', {
      type: 'button',
      onClick: () => this.formatDescription(action, block),
    }, label);
  }

  bindShellEvents() {
    this.dom.addStepBtn.addEventListener('click', () => this.addEmptyStep());
    this.dom.importBtn.addEventListener('click', () => this.importImageSteps());
    this.dom.selectStepsBtn.addEventListener('click', () => this.toggleStepSelectMode());
    this.dom.moveUpBtn.addEventListener('click', () => this.moveSelectedStep(-1));
    this.dom.moveDownBtn.addEventListener('click', () => this.moveSelectedStep(1));
    this.dom.duplicateBtn.addEventListener('click', () => this.duplicateSelectedStep());
    this.dom.deleteBtn.addEventListener('click', () => this.deleteSelectedStep());
    this.dom.saveNowBtn.addEventListener('click', () => this.saveAll());
    this.dom.snapshotBtn.addEventListener('click', () => this.createSnapshot());
    this.dom.linkedBtn.addEventListener('click', () => this.openLinkedGuide());
    this.dom.zoomFitBtn.addEventListener('click', () => this.setZoom('fit'));
    this.dom.zoom100Btn.addEventListener('click', () => this.setZoom(1));
    this.dom.zoom125Btn.addEventListener('click', () => this.setZoom(1.25));
    this.dom.zoom150Btn.addEventListener('click', () => this.setZoom(1.5));
    this.dom.undoBtn.addEventListener('click', () => this.undo());
    this.dom.redoBtn.addEventListener('click', () => this.redo());

    Object.entries(this.dom).forEach(([key, value]) => {
      if (key.startsWith('tool-')) {
        value.addEventListener('click', () => this.setTool(value.dataset.tool));
      }
    });

    this.dom.titleInput.addEventListener('focus', () => {
      if (this.currentStep) this.pushCanvasHistory('title');
    });
    this.dom.titleInput.addEventListener('input', () => {
      if (!this.currentStep) return;
      this.currentStep.title = this.dom.titleInput.value;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.renderStepList();
      this.emitMeta();
    });

    this.dom.statusSelect.addEventListener('change', () => {
      if (!this.currentStep) return;
      this.currentStep.status = this.dom.statusSelect.value;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.renderStepList();
      this.emitMeta();
    });

    const bindCheckbox = (node, field) => node.addEventListener('change', () => {
      if (!this.currentStep) return;
      this.currentStep[field] = node.checked;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.renderStepList();
      this.emitMeta();
    });
    bindCheckbox(this.dom.hiddenToggle.querySelector('input'), 'hidden');
    bindCheckbox(this.dom.skippedToggle.querySelector('input'), 'skipped');
    bindCheckbox(this.dom.forceNewPageToggle.querySelector('input'), 'forceNewPage');

    // Focused view lives under step.focusedView.enabled, not a flat field.
    const focusedInput = this.dom.focusedViewToggle.querySelector('input');
    focusedInput.addEventListener('change', () => {
      if (!this.currentStep) return;
      this.currentStep.focusedView = {
        zoom: 1.5, panX: 0.5, panY: 0.5,
        ...(this.currentStep.focusedView || {}),
        enabled: focusedInput.checked,
      };
      this.pendingSave = true;
      this.saveStepDebounced();
      this.syncFocusedControls();
      this.emitMeta();
    });
    const bindFocusedSlider = (node, field) => node.addEventListener('input', () => {
      const step = this.currentStep;
      if (!step || !step.focusedView) return;
      step.focusedView[field] = Number(node.value);
      this.pendingSave = true;
      this.saveStepDebounced();
    });
    bindFocusedSlider(this.dom.fvZoom, 'zoom');
    bindFocusedSlider(this.dom.fvPanX, 'panX');
    bindFocusedSlider(this.dom.fvPanY, 'panY');

    this.dom.addTextBlockBtn.addEventListener('click', () => this.addBlock('text'));
    this.dom.addCodeBlockBtn.addEventListener('click', () => this.addBlock('code'));
    this.dom.addTableBlockBtn.addEventListener('click', () => this.addBlock('table'));

    this.dom.descEditor.addEventListener('focus', () => {
      if (this.currentStep) this.pushCanvasHistory('description');
    });
    this.dom.descEditor.addEventListener('input', () => {
      if (!this.currentStep) return;
      this.currentStep.descriptionHtml = this.dom.descEditor.innerHTML;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.emitMeta();
    });

    this.dom.descEditor.addEventListener('paste', (e) => {
      // Keep pasted text simple; backend sanitization will handle the rest.
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    this.dom.annotationList.addEventListener('click', (e) => {
      const item = e.target.closest('[data-ann-id]');
      if (!item) return;
      this.canvas.select(item.dataset.annId);
    });
  }

  renderAll() {
    this.renderStepList();
    this.syncStepFields();
    this.syncFocusedControls();
    this.renderCanvas();
    this.renderAnnotationPanel();
    this.renderBlocksPanel();
    this.renderGuidePanel();
    this.emitMeta();
  }

  syncFocusedControls() {
    const fv = this.currentStep?.focusedView;
    const enabled = Boolean(fv && fv.enabled);
    this.dom.focusedControls.classList.toggle('hidden', !enabled);
    if (enabled) {
      this.dom.fvZoom.value = fv.zoom || 1.5;
      this.dom.fvPanX.value = fv.panX ?? 0.5;
      this.dom.fvPanY.value = fv.panY ?? 0.5;
    }
  }

  // ---- text / code / table blocks ----------------------------------------

  addBlock(kind) {
    const step = this.currentStep;
    if (!step) {
      this.onToast('Select a step first.', { error: true });
      return;
    }
    this.syncBlockEditors(step);
    const id = `blk-${Date.now().toString(36)}`;
    if (kind === 'text') {
      step.textBlocks = step.textBlocks || [];
      step.textBlocks.push({ id, order: nextBlockOrder(step), position: 'after-description', level: 'info', title: '', descriptionHtml: '' });
    } else if (kind === 'code') {
      step.codeBlocks = step.codeBlocks || [];
      step.codeBlocks.push({ id, order: nextBlockOrder(step), language: '', code: '' });
    } else if (kind === 'table') {
      step.tableBlocks = step.tableBlocks || [];
      step.tableBlocks.push({ id, order: nextBlockOrder(step), rows: [['Column A', 'Column B'], ['', '']] });
    }
    this.pendingSave = true;
    this.saveStepDebounced();
    this.renderBlocksPanel();
  }

  syncBlockEditors(step = this.currentStep) {
    if (!step || !this.dom?.blocksList) return;
    const findBlock = (kind, id) => {
      const list = kind === 'text'
        ? step.textBlocks || []
        : kind === 'code'
          ? step.codeBlocks || []
          : step.tableBlocks || [];
      return list.find((block) => block.id === id) || null;
    };

    for (const card of this.dom.blocksList.querySelectorAll('.block-card[data-block-id]')) {
      const kind = card.dataset.blockKind;
      const block = findBlock(kind, card.dataset.blockId);
      if (!block) continue;
      if (kind === 'text') {
        const position = card.querySelector('select[data-block-field="position"]');
        const level = card.querySelector('select[data-block-field="level"]');
        const title = card.querySelector('input[data-block-field="title"]');
        const body = card.querySelector('textarea[data-block-field="body"]');
        if (position) block.position = position.value;
        if (level) block.level = level.value;
        if (title) block.title = title.value;
        if (body) block.descriptionHtml = `<p>${escapeHtml(body.value)}</p>`;
      } else if (kind === 'code') {
        const lang = card.querySelector('input[data-block-field="language"]');
        const code = card.querySelector('textarea[data-block-field="code"]');
        if (lang) block.language = lang.value;
        if (code) block.code = code.value;
      } else if (kind === 'table') {
        const grid = card.querySelector('textarea[data-block-field="rows"]');
        if (grid) {
          block.rows = grid.value.split('\n').filter((line) => line.trim() !== '')
            .map((line) => line.split('|').map((cell) => cell.trim()));
        }
      }
    }
  }

  renderBlocksPanel() {
    clearNode(this.dom.blocksList);
    const step = this.currentStep;
    if (!step) {
      this.dom.blocksList.append(el('div.muted', {}, 'Select a step to add blocks.'));
      return;
    }
    const save = () => {
      this.syncBlockEditors(step);
      this.pendingSave = true;
      this.saveStepDebounced();
    };
    const findBlockCard = (kind, id) => {
      for (const card of this.dom.blocksList.querySelectorAll('.block-card[data-block-id]')) {
        if (card.dataset.blockKind === kind && card.dataset.blockId === id) return card;
      }
      return null;
    };
    const refreshBlockCard = (entry, index, total) => {
      const card = findBlockCard(entry.kind, entry.block.id);
      if (!card) return false;
      const orderLabel = card.querySelector('[data-block-order]');
      const moveUpBtn = card.querySelector('[data-block-move="up"]');
      const moveDownBtn = card.querySelector('[data-block-move="down"]');
      if (orderLabel) {
        orderLabel.textContent = `#${Number.isFinite(entry.block.order) ? entry.block.order : index + 1}`;
      }
      if (moveUpBtn) moveUpBtn.disabled = index === 0;
      if (moveDownBtn) moveDownBtn.disabled = index === total - 1;
      this.dom.blocksList.append(card);
      return true;
    };
    const reflowBlockCards = () => {
      const blocksNow = orderedStepBlocks(step);
      for (const [index, entry] of blocksNow.entries()) {
        if (!refreshBlockCard(entry, index, blocksNow.length)) {
          this.renderBlocksPanel();
          return;
        }
      }
    };
    const moveBlock = (source, target) => {
      if (!source || !target || source.kind === target.kind && source.block.id === target.block.id) return;
      const swap = source.block.order;
      source.block.order = target.block.order;
      target.block.order = swap;
      save();
      reflowBlockCards();
    };
    const removeBtn = (onRemove) => el('button.icon.danger', {
      type: 'button', title: 'Remove block',
      onClick: () => { onRemove(); save(); this.renderBlocksPanel(); },
    }, '✕');

    const blocks = orderedStepBlocks(step);
    for (const [index, entry] of blocks.entries()) {
      const { kind, block } = entry;
      const canMoveUp = index > 0;
      const canMoveDown = index < blocks.length - 1;
      const moveUp = () => {
        const currentBlocks = orderedStepBlocks(step);
        const currentIndex = currentBlocks.findIndex((item) => item.kind === kind && item.block.id === block.id);
        if (currentIndex > 0) moveBlock(currentBlocks[currentIndex], currentBlocks[currentIndex - 1]);
      };
      const moveDown = () => {
        const currentBlocks = orderedStepBlocks(step);
        const currentIndex = currentBlocks.findIndex((item) => item.kind === kind && item.block.id === block.id);
        if (currentIndex >= 0 && currentIndex < currentBlocks.length - 1) {
          moveBlock(currentBlocks[currentIndex], currentBlocks[currentIndex + 1]);
        }
      };

      const header = el('div.row', {},
        el('strong', {}, blockLabel(kind)),
        el('span.muted', { dataset: { blockOrder: 'true' } }, `#${Number.isFinite(block.order) ? block.order : index + 1}`),
        el('span.spacer'),
        el('button.icon', { type: 'button', title: 'Move block up', disabled: !canMoveUp, onClick: moveUp, dataset: { blockMove: 'up' } }, '↑'),
        el('button.icon', { type: 'button', title: 'Move block down', disabled: !canMoveDown, onClick: moveDown, dataset: { blockMove: 'down' } }, '↓'),
        removeBtn(() => {
          if (kind === 'text') step.textBlocks = (step.textBlocks || []).filter((b) => b !== block);
          else if (kind === 'code') step.codeBlocks = (step.codeBlocks || []).filter((b) => b !== block);
          else step.tableBlocks = (step.tableBlocks || []).filter((b) => b !== block);
        }),
      );

      const card = el('div.block-card', {
        draggable: true,
        dataset: { blockId: block.id, blockKind: kind },
        onDragStart: (e) => {
          this.draggedBlock = entry;
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        },
        onDragOver: (e) => {
          if (this.draggedBlock) e.preventDefault();
        },
        onDrop: (e) => {
          e.preventDefault();
          if (!this.draggedBlock) return;
          moveBlock(this.draggedBlock, entry);
          this.draggedBlock = null;
        },
        onDragEnd: () => {
          this.draggedBlock = null;
        },
      }, header);

      if (kind === 'text') {
        const position = makeSelect(block.position, [
          { value: 'before-title', label: 'Before title' },
          { value: 'after-title', label: 'After title' },
          { value: 'before-image', label: 'Before image' },
          { value: 'after-image', label: 'After image' },
          { value: 'before-description', label: 'Before description' },
          { value: 'after-description', label: 'After description' },
        ]);
        position.dataset.blockField = 'position';
        const level = makeSelect(block.level, [
          { value: 'info', label: 'Note' },
          { value: 'warn', label: 'Warning' },
          { value: 'error', label: 'Important' },
          { value: 'success', label: 'Tip' },
        ]);
        level.dataset.blockField = 'level';
        const title = el('input', { type: 'text', value: block.title || '', placeholder: 'Block title' });
        title.dataset.blockField = 'title';
        const body = el('textarea', { rows: 2, placeholder: 'Block text' });
        body.dataset.blockField = 'body';
        body.value = (block.descriptionHtml || '').replace(/<[^>]+>/g, '');
        position.addEventListener('change', () => { block.position = position.value; save(); });
        level.addEventListener('change', () => { block.level = level.value; save(); });
        title.addEventListener('input', () => { block.title = title.value; save(); });
        body.addEventListener('input', () => { block.descriptionHtml = `<p>${escapeHtml(body.value)}</p>`; save(); });
        card.append(
          el('div.row', {}, level, position),
          title,
          body,
        );
      } else if (kind === 'code') {
        const lang = el('input', { type: 'text', value: block.language || '', placeholder: 'Language (e.g. bash)' });
        lang.dataset.blockField = 'language';
        const code = el('textarea', { rows: 3, placeholder: 'Code', spellcheck: false });
        code.dataset.blockField = 'code';
        code.value = blockText(block);
        code.style.fontFamily = 'monospace';
        lang.addEventListener('input', () => { block.language = lang.value; save(); });
        code.addEventListener('input', () => { block.code = code.value; save(); });
        card.append(lang, code);
      } else if (kind === 'table') {
        const grid = el('textarea', { rows: 3, placeholder: 'One row per line, cells separated by |', spellcheck: false });
        grid.dataset.blockField = 'rows';
        grid.value = (block.rows || []).map((r) => r.join(' | ')).join('\n');
        grid.addEventListener('input', () => {
          block.rows = grid.value.split('\n').filter((l) => l.trim() !== '')
            .map((line) => line.split('|').map((c) => c.trim()));
          save();
        });
        card.append(
          el('div.muted', {}, 'First line is the header row.'),
          grid,
        );
      }

      this.dom.blocksList.append(card);
    }

    if (!blocks.length) {
      this.dom.blocksList.append(el('div.muted', {}, 'Informational text, code, and table blocks can be reordered with drag handles or arrows.'));
    }
  }

  renderStepList() {
    const current = this.currentStep;
    const numbers = stepNumberMap(this.steps);
    clearNode(this.dom.stepsList);
    this.dom.stepCount.textContent = `${this.steps.length} step${this.steps.length === 1 ? '' : 's'}`;
    this.dom.selectStepsBtn.className = this.stepSelectMode ? 'primary' : '';
    for (const step of this.steps) {
      const number = numbers.get(step.stepId) || '';
      let depth = 0;
      let parent = step.parentStepId;
      while (parent && this.stepMap.has(parent)) {
        depth += 1;
        parent = this.stepMap.get(parent).parentStepId;
      }
      const selected = current && current.stepId === step.stepId;
      const checked = this.selectedSteps.has(step.stepId);
      const item = el('div.step-item', {
        className: `step-item${selected ? ' selected' : ''}${depth ? ' sub' : ''}${step.skipped ? ' skipped' : ''}${step.hidden ? ' hiddenstep' : ''}`,
        dataset: { stepId: step.stepId },
        onClick: () => {
          if (this.stepSelectMode) this.toggleStepSelection(step.stepId);
          else this.selectStep(step.stepId);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          if (this.stepSelectMode) return;
          this.selectStep(step.stepId);
          contextMenu(e.clientX, e.clientY, [
            { label: 'Add substep', action: () => this.addSubstep(step.stepId) },
            { label: 'Duplicate step', action: () => this.duplicateSelectedStep() },
            'sep',
            { label: 'Move up', action: () => this.moveSelectedStep(-1) },
            { label: 'Move down', action: () => this.moveSelectedStep(1) },
            'sep',
            { label: 'Delete step', danger: true, action: () => this.deleteSelectedStep() },
          ]);
        },
      },
      this.stepSelectMode
        ? el('input', {
          type: 'checkbox',
          checked,
          onClick: (e) => e.stopPropagation(),
          onChange: () => this.toggleStepSelection(step.stepId),
        })
        : null,
      el('span.status-dot', { className: `status-dot status-${step.status}` }),
      el('span.num', {}, number || '•'),
      el('span.t', {}, step.title || 'Untitled step'),
      el('span.flags', {}, [
        step.parentStepId ? 'sub' : '',
        step.hidden ? 'hidden' : '',
        step.skipped ? 'skipped' : '',
      ].filter(Boolean).join(' · ')));
      this.dom.stepsList.append(item);
    }
    if (!this.steps.length) {
      this.dom.stepsList.append(el('div.empty-state', { style: { marginTop: '40px' } }, 'No steps yet.'));
    }
    this.renderStepBulkBar();
  }

  toggleStepSelectMode() {
    this.stepSelectMode = !this.stepSelectMode;
    this.selectedSteps = new Set();
    this.renderStepList();
  }

  toggleStepSelection(stepId) {
    if (this.selectedSteps.has(stepId)) this.selectedSteps.delete(stepId);
    else this.selectedSteps.add(stepId);
    this.renderStepList();
  }

  selectAllSteps() {
    this.selectedSteps = new Set(this.steps.map((s) => s.stepId));
    this.renderStepList();
  }

  clearStepSelection() {
    this.selectedSteps = new Set();
    this.renderStepList();
  }

  renderStepBulkBar() {
    clearNode(this.dom.stepBulkBar);
    this.dom.paneFoot.classList.toggle('hidden', this.stepSelectMode);
    if (!this.stepSelectMode) return;
    const n = this.selectedSteps.size;
    const allSelected = this.steps.length > 0 && n === this.steps.length;
    this.dom.stepBulkBar.append(
      el('div.bulk-bar', {},
        el('span', {}, `${n} step${n === 1 ? '' : 's'} selected`),
        el('span.spacer', {}),
        el('button', {
          type: 'button',
          onClick: () => (allSelected ? this.clearStepSelection() : this.selectAllSteps()),
        }, allSelected ? 'Clear' : 'Select all'),
        el('button.danger', { type: 'button', disabled: !n, onClick: () => this.deleteSelectedSteps() }, 'Delete'),
      ),
    );
  }

  async deleteSelectedSteps() {
    const ids = [...this.selectedSteps];
    if (!ids.length) return;
    const ok = await confirmDialog(`Delete ${ids.length} step${ids.length === 1 ? '' : 's'}?`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    for (const stepId of ids) {
      await api.step.delete({ guideId: this.guideId, stepId });
    }
    this.stepSelectMode = false;
    this.selectedSteps = new Set();
    await this.reload(null);
    this.onToast(`${ids.length} step${ids.length === 1 ? '' : 's'} deleted.`);
  }

  syncStepFields() {
    const step = this.currentStep;
    const guide = this.guide;
    if (!step) {
      this.dom.titleInput.value = '';
      this.dom.descEditor.innerHTML = '';
      this.dom.statusSelect.value = 'todo';
      this.dom.hiddenToggle.querySelector('input').checked = false;
      this.dom.skippedToggle.querySelector('input').checked = false;
      this.dom.forceNewPageToggle.querySelector('input').checked = false;
      this.dom.focusedViewToggle.querySelector('input').checked = false;
      this.dom.guideSummary.textContent = guide ? guide.title : '';
      return;
    }
    if (document.activeElement !== this.dom.titleInput) this.dom.titleInput.value = step.title || '';
    if (document.activeElement !== this.dom.descEditor) this.dom.descEditor.innerHTML = step.descriptionHtml || '';
    this.dom.statusSelect.value = step.status || 'todo';
    this.dom.hiddenToggle.querySelector('input').checked = Boolean(step.hidden);
    this.dom.skippedToggle.querySelector('input').checked = Boolean(step.skipped);
    this.dom.forceNewPageToggle.querySelector('input').checked = Boolean(step.forceNewPage);
    this.dom.focusedViewToggle.querySelector('input').checked = Boolean(step.focusedView?.enabled);
    this.dom.guideSummary.textContent = guide
      ? `${guide.title} · ${guide.linkedSource ? 'linked' : 'local'} · ${this.steps.length} steps`
      : '';
  }

  async renderCanvas() {
    const step = this.currentStep;
    const token = ++this.imageLoadToken;
    this.canvas.setTool(this.currentTool);
    this.canvas.setZoom(this.currentZoom);
    if (!step || !step.image) {
      this.canvas.setImage(null, 0, 0);
      this.dom.canvasEmpty.classList.remove('hidden');
      return;
    }
    this.dom.canvasEmpty.classList.add('hidden');
    const src = await api.step.imagePath({
      guideId: this.guideId,
      stepId: step.stepId,
      which: 'working',
    });
    if (token !== this.imageLoadToken || !src) return;
    const img = new Image();
    img.onload = () => {
      if (token !== this.imageLoadToken) return;
      this.canvas.setImage(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
      this.canvas.setAnnotations(step.annotations || []);
      this.canvas.setTool(this.currentTool);
      this.canvas.setZoom(this.currentZoom);
    };
    img.onerror = () => {
      if (token !== this.imageLoadToken) return;
      this.canvas.setImage(null, 0, 0);
      this.dom.canvasEmpty.classList.remove('hidden');
    };
    img.src = src;
  }

  renderAnnotationPanel() {
    clearNode(this.dom.annotationList);
    const step = this.currentStep;
    if (!step) {
      this.dom.annotationList.append(el('div.muted', {}, 'No step selected.'));
      clearNode(this.dom.annotationEditor);
      this.dom.annotationEditor.append(el('div.muted', {}, 'Select a step to edit annotations.'));
      return;
    }

    const anns = step.annotations || [];
    if (!anns.length) {
      this.dom.annotationList.append(el('div.muted', {}, 'No annotations yet. Pick a tool and drag on the canvas.'));
    } else {
      for (const ann of anns) {
        const selected = this.canvas.selected() && this.canvas.selected().id === ann.id;
        this.dom.annotationList.append(el('div.block-card', {
          dataset: { annId: ann.id },
          style: { cursor: 'pointer', borderColor: selected ? 'var(--accent)' : '' },
        },
        el('div.row', {}, el('strong', {}, ann.type), el('span.muted', {}, ann.text || ann.value || '')),
        el('div.muted', {}, `${ann.x.toFixed(3)}, ${ann.y.toFixed(3)} · ${ann.w.toFixed(3)} × ${ann.h.toFixed(3)}`)));
      }
    }

    const selected = this.canvas.selected();
    clearNode(this.dom.annotationEditor);
    if (!selected) {
      this.dom.annotationEditor.append(el('div.muted', {}, 'Select an annotation to edit its style.'));
      return;
    }

    const style = selected.style || {};
    const typeSelect = makeSelect(selected.type, [
      'rect', 'oval', 'line', 'arrow', 'text', 'tooltip', 'number', 'blur', 'highlight', 'magnify', 'cursor',
    ].map((type) => ({ value: type, label: type })));
    const textInput = el('input', { type: 'text', value: selected.text || '', placeholder: 'Annotation text' });
    const valueInput = el('input', { type: 'number', value: Number.isFinite(selected.value) ? selected.value : '', placeholder: 'Value' });
    const strokeInput = el('input', { type: 'color', value: style.stroke || '#E5484D' });
    const fillInput = el('input', { type: 'color', value: style.fill && style.fill !== 'transparent' ? style.fill : '#ffffff' });
    const strokeWidthInput = el('input', { type: 'number', min: 1, step: 1, value: style.strokeWidth || 3 });
    const fontSizeInput = el('input', { type: 'number', min: 0.01, step: 0.001, value: style.fontSize || 0.022 });
    const textColorInput = el('input', { type: 'color', value: style.textColor || '#ffffff' });
    const zoomInput = el('input', { type: 'number', min: 1, step: 0.1, value: selected.zoom || 2 });
    const radiusInput = el('input', { type: 'number', min: 1, step: 1, value: selected.radius || 8 });
    const tailInput = makeSelect(style.tail || 'bottom', [
      { value: 'bottom', label: 'Bottom' },
      { value: 'top', label: 'Top' },
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
    ]);

    // Light-weight apply: mutate the selected annotation, redraw, and let the
    // debounced save flush. Re-rendering the panel here would rebuild the
    // inputs and steal focus mid-keystroke, so only structural changes
    // (type/tail) pass rerender: true.
    const apply = (patch, { rerender = false } = {}) => {
      const ann = this.canvas.selected();
      if (!ann) return;
      Object.assign(ann, patch);
      this.beforeCanvasSnapshot = null;
      step.annotations = clone(this.canvas.annotations || []);
      this.pendingSave = true;
      this.canvas.render();
      this.saveStepDebounced();
      if (rerender) this.renderAnnotationPanel();
      this.emitMeta();
    };

    const annSection = el('div', { className: 'annotation-editor-inner' },
      labeledRow('Type', typeSelect),
      labeledRow('Text', textInput),
      labeledRow('Value', valueInput),
      labeledRow('Stroke', strokeInput),
      labeledRow('Fill', fillInput),
      labeledRow('Stroke width', strokeWidthInput),
      labeledRow('Font size', fontSizeInput),
      labeledRow('Text color', textColorInput),
      labeledRow('Zoom', zoomInput),
      labeledRow('Radius', radiusInput),
      labeledRow('Tail', tailInput),
      el('div.row', {},
        el('button', {
          type: 'button',
          onClick: () => {
            this.canvas.deleteSelected();
          },
        }, 'Delete annotation'),
      ),
      el('div.row', {},
        el('button', { type: 'button', title: 'Copy this style to every annotation of the same type in this step', onClick: () => this.applyStyleAcross('step') }, 'Style → step'),
        el('button', { type: 'button', title: 'Copy this style to every annotation of the same type in the whole guide', onClick: () => this.applyStyleAcross('guide') }, 'Style → guide'),
      ),
    );
    this.dom.annotationEditor.append(annSection);

    typeSelect.addEventListener('change', () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      apply({ type: typeSelect.value }, { rerender: true });
      if (ann.type === 'tooltip') this.editAnnotationText(ann);
    });
    textInput.addEventListener('focus', () => this.pushCanvasHistory('annotation-text'));
    textInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ text: textInput.value });
    });
    valueInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      const next = valueInput.value === '' ? null : Number(valueInput.value);
      await apply({ value: Number.isFinite(next) ? next : null });
    });
    strokeInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, stroke: strokeInput.value } });
    });
    fillInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, fill: fillInput.value } });
    });
    strokeWidthInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, strokeWidth: Number(strokeWidthInput.value || 1) } });
    });
    fontSizeInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, fontSize: Number(fontSizeInput.value || 0.022) } });
    });
    textColorInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, textColor: textColorInput.value } });
    });
    zoomInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ zoom: Number(zoomInput.value || 2) });
    });
    radiusInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ radius: Number(radiusInput.value || 8) });
    });
    tailInput.addEventListener('change', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, tail: tailInput.value } });
    });
  }

  renderGuidePanel() {
    if (!this.guide) return;
    this.dom.linkedBtn.textContent = this.guide.linkedSource ? 'Linked guide' : 'Local guide';
    this.dom.linkedBtn.disabled = !this.guide.linkedSource;
    this.dom.snapshotBtn.textContent = 'Snapshot';
  }

  defaultStyleForTool(tool) {
    switch (tool) {
      case 'highlight': return { fill: '#ffe066', stroke: '#ffbf00', strokeWidth: 1 };
      case 'tooltip': return { fill: '#111827', textColor: '#ffffff', stroke: '#111827', tail: 'bottom' };
      case 'number': return { fill: '#1f6feb', stroke: '#1f6feb', textColor: '#ffffff' };
      case 'blur': return { fill: 'transparent', stroke: '#9ca3af', strokeWidth: 2 };
      case 'cursor': return { fill: '#ffffff', stroke: '#111827', strokeWidth: 2 };
      default: return { fill: 'transparent', stroke: '#E5484D', strokeWidth: 3, textColor: '#ffffff' };
    }
  }

  nextAnnotationNumber() {
    const step = this.currentStep;
    if (!step) return 1;
    const nums = (step.annotations || []).filter((ann) => ann.type === 'number').map((ann) => Number(ann.value) || 0);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }

  setTool(tool) {
    this.currentTool = tool;
    this.canvas.setTool(tool);
    for (const [key, node] of Object.entries(this.dom)) {
      if (!key.startsWith('tool-')) continue;
      node.classList.toggle('active', node.dataset.tool === tool);
    }
  }

  setZoom(mode) {
    this.currentZoom = mode;
    this.canvas.setZoom(mode);
    this.canvas.applyZoom();
    const buttons = [this.dom.zoomFitBtn, this.dom.zoom100Btn, this.dom.zoom125Btn, this.dom.zoom150Btn];
    buttons.forEach((btn) => btn.classList.remove('active'));
    if (mode === 'fit') this.dom.zoomFitBtn.classList.add('active');
    if (mode === 1) this.dom.zoom100Btn.classList.add('active');
    if (mode === 1.25) this.dom.zoom125Btn.classList.add('active');
    if (mode === 1.5) this.dom.zoom150Btn.classList.add('active');
  }

  pushCanvasHistory(recordOrLabel = 'change') {
    if (!this.currentStep) return;
    const record = recordOrLabel && typeof recordOrLabel === 'object' && recordOrLabel.step
      ? recordOrLabel
      : { step: clone(this.currentStep) };
    this.canvasHistory.push(record);
    if (this.canvasHistory.length > 40) this.canvasHistory.shift();
    this.canvasFuture.length = 0;
    this.beforeCanvasSnapshot = null;
  }

  async snapshotCurrentStep(includeImage = false) {
    if (!this.currentStep) return null;
    const record = { step: clone(this.currentStep) };
    if (includeImage && this.currentStep.image) {
      const image = await this.currentStepImageToBase64(this.currentStep);
      if (image) record.image = image;
    }
    return record;
  }

  async restoreHistoryRecord(record) {
    if (!record || !record.step) return;
    const step = clone(record.step);
    this.selectedStepId = step.stepId;
    this.beforeCanvasSnapshot = null;
    this.saveStepDebounced.cancel();
    this.pendingSave = false;
    if (record.image && step.image) {
      const saved = await api.step.setWorkingImage({
        guideId: this.guideId,
        stepId: step.stepId,
        pngBase64: record.image.base64,
        size: record.image.size,
        step,
      });
      this.stepMap.set(saved.stepId, saved);
      const idx = this.steps.findIndex((s) => s.stepId === saved.stepId);
      if (idx >= 0) this.steps[idx] = saved;
    } else {
      await this.flushStep(step);
    }
  }

  async undo() {
    if (!this.currentStep) return;
    if (!this.canvasHistory.length) {
      this.onToast('Nothing to undo.');
      return;
    }
    const current = await this.snapshotCurrentStep(true);
    if (current) this.canvasFuture.push(current);
    const previous = this.canvasHistory.pop();
    await this.restoreHistoryRecord(previous);
    this.renderAll();
  }

  async redo() {
    if (!this.currentStep) return;
    if (!this.canvasFuture.length) {
      this.onToast('Nothing to redo.');
      return;
    }
    const current = await this.snapshotCurrentStep(true);
    if (current) this.canvasHistory.push(current);
    const next = this.canvasFuture.pop();
    await this.restoreHistoryRecord(next);
    this.renderAll();
  }

  async flushStep(step = this.currentStep) {
    if (!step) return;
    this.pendingSave = false;
    const saved = await api.step.save({ guideId: this.guideId, step });
    this.stepMap.set(saved.stepId, saved);
    // Keep the steps array in sync — it holds the objects the list renders.
    const idx = this.steps.findIndex((s) => s.stepId === saved.stepId);
    if (idx >= 0) this.steps[idx] = saved;
    if (this.selectedStepId === saved.stepId) {
      this.renderStepList();
      this.syncStepFields();
      this.canvas.setAnnotations(saved.annotations || []);
      // Rebuilding the annotation editor while the user is typing in one of
      // its inputs would steal focus, so skip it in that case.
      if (!this.dom.annotationEditor.contains(document.activeElement)) {
        this.renderAnnotationPanel();
      }
      this.emitMeta();
    }
    return saved;
  }

  async flushGuide() {
    if (!this.guide) return;
    this.pendingGuideSave = false;
    await api.guide.save({ guide: this.guide });
    this.emitMeta();
  }

  async saveAll() {
    if (this.currentStep) await this.flushStep();
    if (this.guide) await this.flushGuide();
    this.onToast('Saved.');
  }

  async createSnapshot() {
    if (!this.guideId) return;
    await api.snapshots.create({ guideId: this.guideId, label: 'manual' });
    this.onToast('Snapshot created.');
  }

  async selectStep(stepId) {
    if (!this.stepMap.has(stepId)) return;
    this.selectedStepId = stepId;
    this.selectedAnnotationId = null;
    this.canvas.select(null);
    this.syncStepFields();
    this.renderStepList();
    this.renderCanvas();
    this.renderAnnotationPanel();
    this.emitMeta();
  }

  async addEmptyStep() {
    const title = await dialogs.promptText({
      title: 'Add Step',
      label: 'Step title',
      value: '',
      placeholder: 'Untitled step',
    });
    if (title == null) return;
    const step = await api.step.add({
      guideId: this.guideId,
      fields: {
        kind: 'empty',
        title: title.trim() || 'Untitled step',
        status: 'todo',
      },
      position: this.steps.length,
    });
    await this.reload(step.stepId);
    this.onToast('Step added.');
  }

  async addSubstep(parentStepId = this.selectedStepId) {
    if (!parentStepId) return;
    const title = await dialogs.promptText({
      title: 'Add Substep',
      label: 'Substep title',
      value: '',
      placeholder: 'Untitled substep',
    });
    if (title == null) return;
    const parent = this.stepMap.get(parentStepId);
    const parentIndex = this.steps.findIndex((s) => s.stepId === parentStepId);
    const step = await api.step.add({
      guideId: this.guideId,
      fields: {
        kind: 'empty',
        title: title.trim() || 'Untitled substep',
        parentStepId,
        status: 'todo',
      },
      position: parentIndex + 1,
    });
    await this.reload(step.stepId);
    this.onToast(parent ? 'Substep added.' : 'Step added.');
  }

  async duplicateSelectedStep() {
    const step = this.currentStep;
    if (!step) return;
    const copy = clone(step);
    copy.stepId = undefined;
    copy.title = copy.title ? `${copy.title} copy` : 'Untitled step copy';
    const image = await this.currentStepImageToBase64();
    const newStep = await api.step.add({
      guideId: this.guideId,
      fields: {
        ...copy,
        image: undefined,
      },
      imageBase64: image ? image.base64 : null,
      size: image ? image.size : null,
      position: this.steps.findIndex((s) => s.stepId === step.stepId) + 1,
    });
    await this.reload(newStep.stepId);
    this.onToast('Step duplicated.');
  }

  async deleteSelectedStep() {
    const step = this.currentStep;
    if (!step) return;
    const ok = await confirmDialog(`Delete “${step.title || 'Untitled step'}”?`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    await api.step.delete({ guideId: this.guideId, stepId: step.stepId });
    const next = this.steps[this.steps.findIndex((s) => s.stepId === step.stepId) + 1]
      || this.steps[this.steps.findIndex((s) => s.stepId === step.stepId) - 1]
      || null;
    await this.reload(next && next.stepId);
    this.onToast('Step deleted.');
  }

  async moveSelectedStep(delta) {
    const step = this.currentStep;
    if (!step) return;
    const idx = this.steps.findIndex((s) => s.stepId === step.stepId);
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= this.steps.length) return;
    const order = this.steps.map((s) => s.stepId);
    const [item] = order.splice(idx, 1);
    order.splice(nextIdx, 0, item);
    await api.step.reorder({ guideId: this.guideId, order });
    await this.reload(step.stepId);
  }

  async importImageSteps() {
    const result = await api.step.importImage({ guideId: this.guideId });
    if (!result || !result.ok) return;
    const last = result.steps && result.steps[result.steps.length - 1];
    await this.reload(last ? last.stepId : this.selectedStepId);
    this.onToast('Images imported.');
  }

  async captureStep(mode, delayMs = null) {
    const result = mode === 'region'
      ? await api.capture.region({ guideId: this.guideId })
      : await api.capture.shoot({ guideId: this.guideId, mode, delayMs });
    if (result && result.ok) {
      await this.reload(result.step.stepId);
      this.onToast('Captured.');
    } else if (result && result.reason) {
      this.onToast(result.reason, { error: true });
    }
  }

  /** Capture menu anchored at a toolbar button. */
  async openCaptureMenu(event) {
    const rect = event.target.getBoundingClientRect();
    const session = (await api.capture.state())?.active;
    contextMenu(rect.left, rect.bottom + 4, [
      { label: 'Capture full screen', action: () => this.captureStep('fullscreen') },
      { label: 'Capture window', action: () => this.captureStep('window') },
      { label: 'Capture region…', action: () => this.captureStep('region') },
      { label: 'Capture after 3 s delay', action: () => this.captureStep('fullscreen', 3000) },
      'sep',
      { label: 'Paste image as step', action: () => this.pasteClipboardStep() },
      { label: 'Import images…', action: () => this.importImageSteps() },
      'sep',
      session
        ? { label: 'Finish capture session', action: () => this.finishCaptureSession() }
        : { label: 'Start capture session (hotkey)', action: () => this.startCaptureSession() },
    ]);
  }

  async pasteClipboardStep() {
    const result = await api.step.fromClipboard({ guideId: this.guideId });
    if (result && result.ok) {
      await this.reload(result.step.stepId);
      this.onToast('Image pasted as a new step.');
    } else {
      this.onToast(result?.reason || 'Clipboard has no image.', { error: true });
    }
  }

  async shareAsFile() {
    const result = await api.archive.export({ guideId: this.guideId });
    if (result && result.ok) this.onToast(`Shared to ${result.path}`);
  }

  async openBackupsDialog() {
    if (!this.guideId) return;
    const snapshots = await api.snapshots.list({ guideId: this.guideId });
    await dialogs.showBackupsDialog({
      snapshots,
      onCreate: async () => {
        await api.snapshots.create({ guideId: this.guideId, label: 'manual' });
        this.onToast('Snapshot created.');
        return api.snapshots.list({ guideId: this.guideId });
      },
      onRestore: async (name) => {
        const ok = await confirmDialog(
          `Restore "${name}"? Current state is snapshotted first, so this is undoable.`,
          { okLabel: 'Restore' },
        );
        if (!ok) return false;
        await api.snapshots.restore({ guideId: this.guideId, name });
        await this.reload();
        this.onToast('Snapshot restored.');
        return true;
      },
    });
  }

  async openGuidePlaceholders() {
    if (!this.guide) return;
    await dialogs.showPlaceholdersDialog({
      title: 'Guide placeholders',
      hint: 'Use [[Name]] in titles, descriptions, and blocks. Guide values override global ones.',
      values: this.guide.placeholders || {},
      onSave: async (values) => {
        this.guide.placeholders = values;
        await api.guide.save({ guide: this.guide });
        this.onToast('Placeholders saved.');
      },
    });
  }

  openShortcutsHelp() {
    dialogs.showShortcutsDialog();
  }

  /** Copy the selected annotation's style to every annotation of the same type. */
  async applyStyleAcross(scope) {
    const source = this.canvas.selected();
    if (!source) return;
    const patch = clone(source.style || {});
    if (scope === 'step') {
      const step = this.currentStep;
      for (const ann of step.annotations || []) {
        if (ann.type === source.type && ann.id !== source.id) ann.style = { ...ann.style, ...patch };
      }
      step.annotations = clone(step.annotations);
      await this.flushStep(step);
      this.onToast(`Style applied to all ${source.type} annotations in this step.`);
    } else {
      for (const step of this.steps) {
        let touched = false;
        for (const ann of step.annotations || []) {
          if (ann.type === source.type && ann.id !== source.id) {
            ann.style = { ...ann.style, ...patch };
            touched = true;
          }
        }
        if (touched || step.stepId === this.currentStep?.stepId) {
          await api.step.save({ guideId: this.guideId, step });
        }
      }
      await this.reload(this.selectedStepId);
      this.onToast(`Style applied to all ${source.type} annotations in the guide.`);
    }
  }

  async startCaptureSession() {
    await api.capture.session({ action: 'start', guideId: this.guideId });
    this.onToast('Capture session ready — click "Start recording" in the red bar when you\'re set.');
    this.emitMeta();
  }

  async pauseCaptureSession() {
    await api.capture.session({ action: 'pause', guideId: this.guideId });
    this.onToast('Capture paused.');
    this.emitMeta();
  }

  async resumeCaptureSession() {
    await api.capture.session({ action: 'resume', guideId: this.guideId });
    this.onToast('Capture resumed.');
    this.emitMeta();
  }

  async finishCaptureSession() {
    await api.capture.session({ action: 'finish', guideId: this.guideId });
    this.onToast('Capture session finished.');
    this.emitMeta();
  }

  async openSettings() {
    const settings = await api.settings.all();
    const placeholders = await api.settings.globalPlaceholders();
    await dialogs.showSettingsDialog({
      settings,
      placeholders,
      onSave: async (next) => {
        await api.settings.set({ keyPath: 'appearance', value: next.appearance });
        await api.settings.set({ keyPath: 'spellcheck', value: next.spellcheck });
        await api.settings.set({ keyPath: 'capture', value: next.capture });
        await api.settings.set({ keyPath: 'editor', value: next.editor });
        await api.settings.set({ keyPath: 'exports', value: next.exports });
        await api.settings.set({ keyPath: 'backups', value: next.backups });
        await api.settings.setGlobalPlaceholders(next.placeholders || {});
      },
    });
  }

  async openExportDialog() {
    const formats = (await api.export.formats()).map((id) => ({ id, label: id.replace(/-/g, ' ') }));
    const templatesByFormat = {};
    for (const format of formats) {
      templatesByFormat[format.id] = await api.templates.list({ format: format.id });
    }
    const settings = await api.settings.all();
    await dialogs.showExportDialog({
      formats,
      templatesByFormat,
      defaultFormat: 'pdf',
      defaultOutDir: settings.exports?.lastOutputDirs?.pdf || '',
      onChooseDir: async (format) => api.export.chooseDir({ format }),
      onLoadDefaults: async (format) => api.export.defaults({ format }),
      onLoadTemplate: async (format, name) => api.templates.load({ format, name }),
      onSaveTemplate: async (format, name, options) => {
        await api.templates.save({ format, name, options });
        this.onToast(`Template “${name}” saved.`);
      },
      onManageTemplates: async (format, mode) => {
        if (mode === 'manage') {
          await dialogs.showTemplateManager({
            format,
            names: await api.templates.list({ format }),
            onRename: async (name, newName) => {
              await api.templates.rename({ format, name, newName });
              return api.templates.list({ format });
            },
            onDuplicate: async (name) => {
              await api.templates.duplicate({ format, name });
              return api.templates.list({ format });
            },
            onDelete: async (name) => {
              await api.templates.delete({ format, name });
              return api.templates.list({ format });
            },
            onImport: async () => {
              const res = await api.templates.import();
              if (res?.ok) this.onToast(`Imported template for ${res.format}.`);
              return api.templates.list({ format });
            },
            onExport: async (name) => {
              const res = await api.templates.export({ format, name });
              if (res?.ok) this.onToast('Template shared as .sfglt.');
            },
          });
        }
        return api.templates.list({ format });
      },
      onPreview: async ({ format, options }) => {
        const preview = await api.export.preview({ guideId: this.guideId, format, options });
        if (preview && preview.file) {
          await api.shell.openPath({ target: preview.file }); // open in default viewer
          this.onToast('Preview opened (first steps only).');
        }
        return true;
      },
      onExport: async ({ format, options, outDir }) => {
        const result = await api.export.run({ guideId: this.guideId, format, options, outDir });
        if (result && result.ok === false) return false;
        if (result && result.file) this.onToast(`Exported ${format}.`);
        return true;
      },
    });
  }

  async openLinkedGuide() {
    if (!this.guide || !this.guide.linkedSource) {
      await dialogs.showInfoDialog('Linked Guide', 'This guide is stored locally and is not linked to a shared archive.');
      return;
    }
    const library = await api.library.list();
    const guideMeta = library.guides.find((g) => g.guideId === this.guideId) || this.guide;
    const locked = Boolean(guideMeta.locked);
    await dialogs.showLinkedGuideDialog({
      guide: guideMeta,
      lock: locked ? { acquired: false } : { acquired: true },
      onSave: async () => {
        const result = await api.archive.saveLinked({ guideId: this.guideId, force: false });
        if (result.saved) this.onToast('Linked archive saved.');
        else this.onToast('Could not save linked archive.', { error: true });
      },
      onForceSave: async () => {
        const result = await api.archive.saveLinked({ guideId: this.guideId, force: true });
        if (result.saved) this.onToast('Linked archive force-saved.');
        else this.onToast('Could not save linked archive.', { error: true });
      },
      onOpenArchive: async () => {
        await api.shell.showItemInFolder({ target: this.guide.linkedSource.path });
      },
    });
  }

  async openQuickActions() {
    const commands = [
      { kind: 'cmd', label: 'New guide', description: 'Create a blank guide', action: () => this.onBack('new') },
      { kind: 'cmd', label: 'Export', description: 'Export the current guide', action: () => this.openExportDialog() },
      { kind: 'cmd', label: 'Settings', description: 'Open application settings', action: () => this.openSettings() },
      { kind: 'cmd', label: 'Linked guide', description: 'Show linked archive details', action: () => this.openLinkedGuide() },
      { kind: 'cmd', label: 'Start capture session', description: 'Enable hotkey capture for this guide', action: () => this.startCaptureSession() },
    ];

    await dialogs.showQuickActions({
      commands,
      searchFn: async (query) => {
        const results = await api.search.query({ q: query });
        return results.map((r) => ({
          kind: r.stepId ? 'step' : 'guide',
          label: r.title || '(untitled)',
          description: r.snippet || '',
          action: () => this.openSearchResult(r),
        }));
      },
    });
  }

  async openSearchResult(result) {
    if (!result) return;
    if (result.stepId) {
      await this.onBack();
      await this.open(result.guideId, result.stepId);
    } else {
      await this.onBack();
      await this.open(result.guideId, null);
    }
  }

  async currentStepImageToBase64(step = this.currentStep) {
    if (!step || !step.image) return null;
    const file = await api.step.imagePath({ guideId: this.guideId, stepId: step.stepId, which: 'working' });
    if (!file) return null;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = canvas.toDataURL('image/png').split(',')[1];
        resolve({ base64: data, size: { width: canvas.width, height: canvas.height } });
      };
      img.onerror = () => resolve(null);
      img.src = file;
    });
  }

  async onCanvasChange(annotations) {
    const step = this.currentStep;
    if (!step) return;
    if (this.beforeCanvasSnapshot) {
      this.canvasHistory.push(this.beforeCanvasSnapshot);
      if (this.canvasHistory.length > 40) this.canvasHistory.shift();
      this.canvasFuture.length = 0;
      this.beforeCanvasSnapshot = null;
    }
    step.annotations = clone(annotations || []);
    this.pendingSave = true;
    this.saveStepDebounced();
    this.renderAnnotationPanel();
    this.renderStepList();
    this.emitMeta();
  }

  onCanvasSelect(ann) {
    this.selectedAnnotationId = ann ? ann.id : null;
    this.renderAnnotationPanel();
    this.emitMeta();
  }

  async onCanvasCrop(rect) {
    const step = this.currentStep;
    if (!step || !step.image) return;
    const ok = await confirmDialog('Crop the working image to the selected area?');
    if (!ok) return;
    this.saveStepDebounced.cancel();
    const snapshot = this.beforeCanvasSnapshot || await this.snapshotCurrentStep(true);
    if (snapshot) {
      if (!snapshot.image) snapshot.image = await this.currentStepImageToBase64(step);
      this.pushCanvasHistory(snapshot);
    }
    this.beforeCanvasSnapshot = null;
    const src = await api.step.imagePath({ guideId: this.guideId, stepId: step.stepId, which: 'working' });
    if (!src) return;
    const img = await loadImage(src);
    if (!img) return;
    const crop = rect;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.w * img.naturalWidth));
    canvas.height = Math.max(1, Math.round(crop.h * img.naturalHeight));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      img,
      Math.round(crop.x * img.naturalWidth),
      Math.round(crop.y * img.naturalHeight),
      Math.round(crop.w * img.naturalWidth),
      Math.round(crop.h * img.naturalHeight),
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const nextAnnotations = (step.annotations || []).map((ann) => {
      const next = clone(ann);
      next.x = (ann.x - crop.x) / crop.w;
      next.y = (ann.y - crop.y) / crop.h;
      next.w = ann.w / crop.w;
      next.h = ann.h / crop.h;
      return next;
    });
    await api.step.setWorkingImage({
      guideId: this.guideId,
      stepId: step.stepId,
      pngBase64: canvas.toDataURL('image/png').split(',')[1],
      size: { width: canvas.width, height: canvas.height },
    });
    step.image.size = { width: canvas.width, height: canvas.height };
    step.annotations = nextAnnotations;
    await this.flushStep(step);
    await this.reload(step.stepId);
    this.onToast('Image cropped.');
  }

  async editAnnotationText(ann) {
    const step = this.currentStep;
    if (!step || !ann) return;
    const value = await dialogs.promptText({
      title: ann.type === 'tooltip' ? 'Edit tooltip' : 'Edit text',
      label: 'Text',
      value: ann.text || '',
      multiline: true,
    });
    if (value == null) return;
    ann.text = value;
    step.annotations = clone(step.annotations || []);
    this.pendingSave = true;
    await this.flushStep(step);
    this.renderAnnotationPanel();
    this.emitMeta();
  }

  formatDescription(command, block = null) {
    const editor = this.dom.descEditor;
    editor.focus();
    switch (command) {
      case 'bold':
        document.execCommand('bold');
        break;
      case 'italic':
        document.execCommand('italic');
        break;
      case 'insertUnorderedList':
        document.execCommand('insertUnorderedList');
        break;
      case 'insertOrderedList':
        document.execCommand('insertOrderedList');
        break;
      case 'formatBlock':
        document.execCommand('formatBlock', false, block || 'blockquote');
        break;
      case 'createLink': {
        const url = window.prompt('Link URL');
        if (url) document.execCommand('createLink', false, url);
        break;
      }
      case 'removeFormat':
        document.execCommand('removeFormat');
        break;
      default:
        break;
    }
    if (this.currentStep) {
      this.currentStep.descriptionHtml = editor.innerHTML;
      this.pendingSave = true;
      this.saveStepDebounced();
    }
  }

  onDocumentKeyDown(e) {
    if (!this.active || !this.guide) return;
    if ((e.ctrlKey || e.metaKey) && e.key === '/' && !e.shiftKey) {
      e.preventDefault();
      this.openQuickActions();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.saveAll();
      return;
    }
    if (e.key === 'Escape' && !isEditableTarget(e.target)) {
      // Escape deselects; Delete is the destructive key.
      if (this.selectedAnnotationId) {
        e.preventDefault();
        this.canvas.select(null);
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !isEditableTarget(e.target)) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (!isEditableTarget(e.target)) {
      // Tool palette hotkeys (Folge-style single keys).
      const TOOL_KEYS = {
        s: 'select', r: 'rect', o: 'oval', l: 'line', a: 'arrow', t: 'text',
        g: 'tooltip', n: 'number', b: 'blur', h: 'highlight', m: 'magnify',
        u: 'cursor', c: 'crop',
      };
      if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
        e.preventDefault();
        this.setTool(TOOL_KEYS[e.key.toLowerCase()]);
        return;
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        const idx = this.steps.findIndex((s) => s.stepId === this.selectedStepId);
        const next = this.steps[idx + (e.key === 'PageDown' ? 1 : -1)];
        if (next) this.selectStep(next.stepId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.setZoom(Math.min(3, (Number(this.currentZoom) || 1) + 0.25));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        this.setZoom(Math.max(0.25, (Number(this.currentZoom) || 1) - 0.25));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        this.setZoom('fit');
        return;
      }
      // Copy / paste the selected annotation.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && this.selectedAnnotationId) {
        e.preventDefault();
        this.annotationClipboard = clone(this.canvas.selected());
        this.onToast('Annotation copied.');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (this.annotationClipboard && this.currentStep?.image) {
          const copy = clone(this.annotationClipboard);
          copy.id = `ann-${Date.now().toString(36)}`;
          copy.x = Math.min(0.92, copy.x + 0.03);
          copy.y = Math.min(0.92, copy.y + 0.03);
          this.currentStep.annotations.push(copy);
          this.canvas.setAnnotations(this.currentStep.annotations);
          this.canvas.select(copy.id);
          this.pendingSave = true;
          this.saveStepDebounced();
        } else {
          this.pasteClipboardStep(); // OS clipboard image -> new step
        }
        return;
      }
      if (e.key === 'Delete' && this.selectedAnnotationId) {
        e.preventDefault();
        if (this.canvas.deleteSelected()) this.saveStepDebounced();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Delete') {
        e.preventDefault();
        this.deleteSelectedStep();
        return;
      }
      if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        this.moveSelectedStep(-1);
        return;
      }
      if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        this.moveSelectedStep(1);
        return;
      }
      if (e.key.startsWith('Arrow')) {
        const speed = e.shiftKey ? 10 : 1; // shift nudges faster
        const dx = (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0) * speed;
        const dy = (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0) * speed;
        if (dx || dy) {
          const moved = this.canvas.nudgeSelected(dx, dy);
          if (moved) {
            const step = this.currentStep;
            if (step) {
              step.annotations = clone(this.canvas.annotations || []);
              this.pendingSave = true;
              this.saveStepDebounced();
            }
            e.preventDefault();
          }
        }
      }
    }
  }
}

function labeledRow(labelText, control) {
  return el('div.form-row', {}, el('label', {}, labelText), control);
}

function makeSelect(value, options) {
  return el('select', {}, options.map((opt) => el('option', { value: opt.value, selected: opt.value === value }, opt.label)));
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

window.GuideEditor = GuideEditor;
})();
