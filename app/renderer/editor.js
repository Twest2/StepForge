'use strict';

(() => {

const api = window.stepforge;
const dialogs = window.StepForgeDialogs || {};
const shortcuts = window.StepForgeShortcuts || {};
const outline = window.StepForgeOutline || {};
const { stepNumberMap } = outline;

const clone = (value) => JSON.parse(JSON.stringify(value));

/** A step's content as a string, ignoring its revision, so two states can be compared. */
function stepFingerprint(step) {
  return JSON.stringify(step, (key, value) => {
    if (key === 'revision') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
    }
    return value;
  });
}
/**
 * Put back a recorded step order (`recorded`) when the guide now has the
 * steps in `current`. Steps deleted since are left out. A step added since
 * keeps its place relative to the steps around it: a substep goes at the end
 * of its parent's substeps (`currentParents` says where it belongs now), and
 * a top-level step goes just before the top-level step it sits above now, or
 * last. `parents` maps each recorded step to the parent it gets back, so the
 * order stays one the outline can read top to bottom.
 */
/** An annotation's content as a string, without its id: equal for a copy at the same place. */
function annotationContentKey(ann) {
  return JSON.stringify(ann, (key, value) => {
    if (key === 'id') return undefined;
    if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
    }
    return value;
  });
}

function reconcileOrder(recorded, current, parents, currentParents) {
  const known = new Set(current);
  const order = recorded.filter((id) => known.has(id));
  const listed = new Set(order);
  const parentOf = (id) => (id in parents ? parents[id] : currentParents[id]) || null;
  const isWithin = (id, ancestor) => {
    for (let p = parentOf(id); p; p = parentOf(p)) if (p === ancestor) return true;
    return false;
  };
  const rootOf = (id) => {
    let root = id;
    for (let p = parentOf(id); p && listed.has(p); p = parentOf(p)) root = p;
    return root;
  };
  current.forEach((id, i) => {
    if (listed.has(id)) return;
    const parent = currentParents[id] || null;
    let at;
    if (parent && listed.has(parent)) {
      // After the parent and everything already nested under it.
      at = order.indexOf(parent) + 1;
      while (at < order.length && isWithin(order[at], parent)) at += 1;
    } else {
      const next = current.slice(i + 1).find((later) => listed.has(later));
      at = next ? order.indexOf(rootOf(next)) : order.length;
    }
    order.splice(at, 0, id);
    listed.add(id);
  });
  return order;
}

// Retake screenshot: time to open the menu or dialog the step shows once StepForge is hidden.
const RETAKE_DELAY_MS = 3000;
const BLOCK_KIND_ORDER = { text: 0, code: 1, table: 2 };

// Which style fields are meaningful for each annotation type, so the
// annotation editor only shows controls that actually affect that type.
const ANNOTATION_FIELDS = {
  rect: ['stroke', 'fill', 'strokeWidth'],
  oval: ['stroke', 'fill', 'strokeWidth'],
  line: ['stroke', 'strokeWidth'],
  arrow: ['stroke', 'strokeWidth'],
  text: ['text', 'stroke', 'fontSize'],
  tooltip: ['text', 'fill', 'stroke', 'strokeWidth', 'fontSize', 'textColor', 'tail'],
  number: ['value', 'stroke', 'textColor'],
  blur: ['radius'],
  highlight: [],
  magnify: ['zoom', 'stroke', 'strokeWidth'],
  cursor: [],
};

// Display names for annotation types in the "Type" dropdown.
// What a blur added by Find private details hides (core/redaction.js KINDS).
const PRIVATE_DETAIL_LABELS = {
  email: t('email address'), phone: t('phone number'), card: t('card number'), ssn: t('Social Security number'),
  ip: t('IP address'), secret: t('password or key'), url: t('link with a private token'), custom: t('word you asked to hide'),
};

const ANNOTATION_TYPE_LABELS = {
  rect: t('Rectangle'),
  oval: t('Oval'),
  line: t('Line'),
  arrow: t('Arrow'),
  text: t('Text'),
  tooltip: t('Tooltip'),
  number: t('Number'),
  blur: t('Blur'),
  highlight: t('Highlight'),
  magnify: t('Magnify'),
  cursor: t('Cursor'),
};

/** White or near-black text, whichever reads better on a badge or tooltip of color `hex`. */
function readableTextOn(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#111111' : '#ffffff';
}

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
  return kind === 'text' ? t('Text block') : kind === 'code' ? t('Code block') : t('Table');
}

function stepDepth(step, stepMap) {
  let depth = 0;
  let parent = step.parentStepId;
  while (parent && stepMap.has(parent)) {
    depth += 1;
    parent = stepMap.get(parent).parentStepId;
  }
  return depth;
}

function isEditableTarget(target) {
  return target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

function zoomShortcutFromEvent(e) {
  if (shortcuts.zoomShortcutFromKeyboardEvent) {
    return shortcuts.zoomShortcutFromKeyboardEvent(e);
  }

  if (!(e.ctrlKey || e.metaKey)) return null;

  const { key, code, shiftKey } = e;
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'fit';
  if (
    key === '+' || key === '=' || key === 'Add' || key === 'Plus' ||
    code === 'Equal' || code === 'NumpadAdd' ||
    (key === '=' && shiftKey) || (code === 'Equal' && shiftKey)
  ) return 'in';
  if (key === '-' || key === '_' || key === 'Subtract' || key === 'Minus' || code === 'Minus' || code === 'NumpadSubtract') return 'out';
  return null;
}

class GuideEditor {
  constructor({ root, onMetaChange = () => {}, onToast = toast, onBack = () => {}, onPublish = null } = {}) {
    this.root = root;
    this.onMetaChange = onMetaChange;
    this.onToast = onToast;
    this.onBack = onBack;
    this.onPublish = onPublish; // (format) => Share → Publish to Confluence/Wiki.js for this guide

    this.guideId = null;
    this.guide = null;
    this.steps = [];
    this.stepMap = new Map();
    this.selectedStepId = null;
    this.stepSelectMode = false;
    this.selectedSteps = new Set();
    this.stepSelectionAnchor = null;
    this.selectedAnnotationId = null;
    this.currentTool = 'select';
    this.currentZoom = 'fit';
    this.pendingSave = false;
    this.pendingGuideSave = false;
    this.saveError = null;
    this.canvasHistory = [];
    this.canvasFuture = [];
    this.beforeCanvasSnapshot = null;
    this.draggedBlock = null;
    this.stepLoadToken = 0;
    this.imageLoadToken = 0;
    this.shellMounted = false;
    this.linkedConflict = false;
    this.linkedSaveInFlight = null; // a linked save (runLinkedSave) while it runs
    this.descriptionDirty = false;
    this.titleDirty = false;
    this.active = true;
    this.settings = {};

    this.saveStepDebounced = debounce(() => this.flushStep(), 180);
    this.saveGuideDebounced = debounce(() => this.flushGuide(), 180);

    if (api.editor && typeof api.editor.onZoomShortcut === 'function') {
      api.editor.onZoomShortcut((kind) => {
        if (!this.active || !this.guide) return;
        this.applyZoomShortcut(kind);
      });
    }

    this.onDocumentKeyDown = this.onDocumentKeyDown.bind(this);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  destroy() {
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  setActive(active) {
    this.active = Boolean(active);
    if (api.editor && typeof api.editor.setCanvasZoomActive === 'function') {
      api.editor.setCanvasZoomActive(this.active);
    }
    if (!this.active && this.guideId) {
      // Leaving the editor: flush pending debounced saves so navigation can
      // never drop the last edit (failures keep the dirty state and retry),
      // and cancel any in-flight AI request for this guide so a slow response
      // can't resolve against a guide the user has closed.
      if (this.pendingSave || this.pendingGuideSave) {
        this.saveAll().catch(() => {});
      }
      this.stopAiWriting({ quiet: true });
    }
  }

  setSettings(settings) {
    this.settings = settings || {};
    void this.loadBrandAnnotations();
  }

  /**
   * The active brand profile's annotation colors when it sets its own
   * (Settings → Branding), else null for StepForge's. New shapes start in them.
   */
  async loadBrandAnnotations() {
    const id = this.settings?.branding?.activeProfileId;
    try {
      const profile = id ? (await api.branding.list()).find((p) => p.id === id) : null;
      this.brandAnnotations = profile?.annotations?.custom ? profile.annotations : null;
    } catch {
      this.brandAnnotations = null;
    }
  }

  isAiEnabled() {
    return Boolean(this.settings?.ai?.enabled);
  }

  /** Items for the AI ▾ menu in the guide toolbar. */
  aiMenuItems() {
    if (this.aiRun) {
      return [{ label: t('Stop writing'), action: () => this.stopAiWriting() }];
    }
    const enabled = this.isAiEnabled();
    const hasStep = Boolean(this.currentStep);
    const unavailable = (available) => !enabled || !available;
    return [
      ...(enabled ? [] : [{ label: t('Turn on AI in Settings…'), action: () => this.openSettings('ai') }, 'sep']),
      { label: t('Write the whole guide'), disabled: unavailable(this.steps.length > 0), action: () => this.writeGuideWithAi() },
      { label: t('Write the whole step'), disabled: unavailable(hasStep), action: () => this.writeStepWithAi('step') },
      'sep',
      { label: t('Write the title'), disabled: unavailable(hasStep), action: () => this.writeStepWithAi('title') },
      { label: t('Write the description'), disabled: unavailable(hasStep), action: () => this.writeStepWithAi('description') },
      { label: t('Write the blocks'), disabled: unavailable(hasStep), action: () => this.writeStepWithAi('blocks') },
    ];
  }

  /** Short progress text for the AI button while AI is writing, else ''. */
  aiProgressLabel() {
    return this.aiRun ? this.aiRun.progress || t('writing…') : '';
  }

  setAiProgress(progress) {
    if (!this.aiRun) return;
    this.aiRun.progress = progress;
    this.emitMeta();
  }

  /** Cancel the AI run in progress: the current request and any steps still queued. */
  stopAiWriting({ quiet = false } = {}) {
    if (this.guideId) api.ai.cancel({ guideId: this.guideId }).catch(() => {});
    if (!this.aiRun) return;
    this.aiRun.cancelled = true;
    if (!quiet) this.onToast(t('Stopping AI…'));
  }

  /** Show an AI-written step without losing edits the user made meanwhile. */
  applyAiStep(saved) {
    if (!saved || !saved.stepId || !this.stepMap.has(saved.stepId)) return false;
    // The user is the authority: if they are mid-edit on this step, their
    // pending save wins and the AI text is not pushed into the form.
    if (this.pendingSave && this.selectedStepId === saved.stepId) return false;
    // AI may have rewritten the blocks, so take its arrays; renderAll below
    // rebuilds the block cards. Keeping the old ones showed stale blocks and
    // wrote them back over the AI's on the next save.
    this.commitSavedStep(saved, { replaceBlocks: true });
    this.renderStepList();
    if (this.selectedStepId === saved.stepId) this.renderAll();
    return true;
  }

  async writeStepWithAi(target) {
    const step = this.currentStep;
    if (!step || this.aiRun) return;
    if (!this.isAiEnabled()) {
      this.onToast(t('Turn on AI in Settings first.'), { error: true });
      return;
    }
    if (this.pendingSave) await this.flushStep();
    const failure = {
      step: t('AI could not write this step.'), title: t('AI could not write the title.'),
      description: t('AI could not write the description.'), blocks: t('AI could not write the blocks.'),
    }[target];
    const success = {
      step: t('AI wrote this step.'), title: t('AI wrote the title.'),
      description: t('AI wrote the description.'), blocks: t('AI wrote the blocks.'),
    }[target];
    const run = { cancelled: false, progress: '' };
    this.aiRun = run;
    this.emitMeta();
    const before = clone(step);
    try {
      const result = await api.ai.fillStep({ guideId: this.guideId, stepId: step.stepId, target });
      if (run.cancelled) return;
      if (!result || !result.ok) {
        this.onToast(result?.reason || failure, { error: true });
        return;
      }
      if (this.applyAiStep(result.step)) {
        this.pushCanvasHistory(this.multiStepRecord([before], [result.step]));
        this.onToast(`${success} ${t('Press Ctrl+Z to undo.')}`);
      } else {
        this.onToast(success);
      }
    } catch (err) {
      if (!run.cancelled) this.onToast(err.message || failure, { error: true });
    } finally {
      if (this.aiRun === run) this.aiRun = null;
      this.emitMeta();
    }
  }

  /**
   * AI ▾ → Write the whole guide: every step's title, description and blocks,
   * then the guide's own title and description. A snapshot is taken first so
   * the whole run can be undone from Backups & snapshots.
   */
  async writeGuideWithAi() {
    if (this.aiRun || !this.steps.length) return;
    if (!this.isAiEnabled()) {
      this.onToast(t('Turn on AI in Settings first.'), { error: true });
      return;
    }
    // A step with no screenshot and no text gives AI nothing to work from.
    const hasText = (step) => Boolean(step.title || (step.descriptionHtml || '').replace(/<[^>]*>/g, '').trim()
      || (step.textBlocks || []).length || (step.codeBlocks || []).length || (step.tableBlocks || []).length);
    const queue = (this.guide?.stepsOrder || [])
      .map((id) => this.stepMap.get(id))
      .filter((step) => step && (step.image || hasText(step)));
    if (!queue.length) {
      this.onToast(t('There is nothing for AI to write from yet. Capture some steps first.'), { error: true });
      return;
    }
    const ok = await confirmDialog(
      `${tn(queue.length, 'AI will write the title, description and blocks for {count} step.',
        'AI will write the title, description and blocks for {count} steps, make substeps where steps belong together, and add placeholders for values that repeat.')} ${
        t('Then it writes the guide’s title and description. Text you already wrote is polished, not replaced with something new.')} ${
        t('A snapshot is saved first, so you can undo this from More → Backups & snapshots.')}`,
      { okLabel: t('Write the whole guide') },
    );
    if (!ok) return;
    if (this.pendingSave) await this.flushStep();
    if (this.pendingGuideSave) await this.flushGuide();
    try {
      await api.snapshots.create({ guideId: this.guideId, label: t('before AI') });
    } catch (err) {
      this.onToast(t('Could not save a snapshot first, so AI did not start: {error}', { error: err.message || err }), { error: true });
      return;
    }

    const guideId = this.guideId;
    const run = { cancelled: false, progress: '' };
    this.aiRun = run;
    let written = 0;
    let substeps = 0;
    let newPlaceholders = [];
    const problems = [];
    try {
      for (const [index, step] of queue.entries()) {
        if (run.cancelled) break;
        this.setAiProgress(`${index + 1}/${queue.length}`);
        if (this.pendingSave) await this.flushStep();
        let result = null;
        try {
          result = await api.ai.fillStep({ guideId, stepId: step.stepId, target: 'step' });
        } catch (err) {
          result = { ok: false, reason: err.message };
        }
        if (run.cancelled) break;
        if (result?.ok) {
          written += 1;
          this.applyAiStep(result.step);
        } else {
          problems.push(result?.reason || t('AI could not write a step.'));
        }
      }
      if (!run.cancelled && written) {
        this.setAiProgress('organizing');
        if (this.pendingSave) await this.flushStep();
        if (this.pendingGuideSave) await this.flushGuide();
        const organized = await api.ai.organizeGuide({ guideId }).catch((err) => ({ ok: false, reason: err.message }));
        if (organized?.ok) {
          substeps = organized.substeps || 0;
          newPlaceholders = (organized.placeholders || []).map((p) => `[[${p.name}]]`);
        } else if (!run.cancelled) {
          problems.push(organized?.reason || t('AI could not organize the guide.'));
        }
      }
      if (!run.cancelled && written) {
        this.setAiProgress('guide title');
        if (this.pendingGuideSave) await this.flushGuide();
        const result = await api.ai.fillGuide({ guideId }).catch((err) => ({ ok: false, reason: err.message }));
        if (!run.cancelled && result?.ok) {
          this.guide = result.guide;
        } else if (!run.cancelled) {
          problems.push(result?.reason || t('AI could not write the guide title.'));
        }
      }
    } finally {
      if (this.aiRun === run) this.aiRun = null;
      this.emitMeta();
    }
    if (this.guideId !== guideId) return;
    // Substeps and placeholders changed steps and numbering: show the guide as saved.
    await this.reloadAfterOutsideChange();
    const extras = [
      substeps ? tn(substeps, 'Made {count} substep.', 'Made {count} substeps.') : '',
      newPlaceholders.length ? t('Added {placeholders}.', { placeholders: newPlaceholders.join(', ') }) : '',
    ].filter(Boolean).join(' ');
    if (run.cancelled) {
      this.onToast(tn(queue.length, 'Stopped. AI wrote {written} of {count} step.', 'Stopped. AI wrote {written} of {count} steps.', { written }));
    } else if (problems.length) {
      this.onToast(`${tn(queue.length, 'AI wrote {written} of {count} step.', 'AI wrote {written} of {count} steps.', { written })} ${problems[0]}`, { error: true, ms: 6000 });
    } else {
      this.onToast(`${tn(written, 'AI wrote the whole guide ({count} step).', 'AI wrote the whole guide ({count} steps).')}${extras ? ` ${extras}` : ''}`, { ms: 5000 });
    }
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
      saveError: this.saveError || null,
      aiProgress: this.aiProgressLabel(),
      view: 'editor',
    };
  }

  emitMeta() {
    this.onMetaChange(this.getMeta());
  }

  async open(guideId, stepId = null) {
    if (this.guideId !== guideId) this.stopAiWriting({ quiet: true });
    this.guideId = guideId;
    this.stepSelectMode = false;
    this.selectedSteps = new Set();
    this.stepSelectionAnchor = null;
    this.selectedStepId = stepId;
    this.selectedAnnotationId = null;
    this.canvasHistory = [];
    this.canvasFuture = [];
    this.pendingSave = false;
    this.pendingGuideSave = false;
    this.setActive(true);
    await this.reload(stepId);
  }

  /**
   * Show changes made outside the editor (AI organizing, an AI agent).
   * Pending edits are saved first, so the user's own unsaved work always wins.
   */
  async reloadAfterOutsideChange() {
    if (this.pendingSave) {
      const { guide } = await api.guide.get({ guideId: this.guideId });
      if (!guide.stepsOrder.includes(this.selectedStepId)) {
        this.saveStepDebounced.cancel();
        this.pendingSave = false;
        this.saveError = null;
        this.onToast('An AI agent deleted the step you were editing. Its saved version is in Backups & snapshots.');
      } else {
        await this.flushStep();
        if (this.pendingSave) return; // Keep unsaved edits if the write failed.
      }
    }
    if (this.pendingGuideSave) await this.flushGuide();
    await this.reload(this.selectedStepId);
  }

  async reload(stepId = this.selectedStepId) {
    const token = ++this.stepLoadToken;
    const { guide, steps } = await api.guide.get({ guideId: this.guideId });
    if (token !== this.stepLoadToken) return;
    this.guide = guide;
    this.steps = steps;
    this.stepMap = new Map(steps.map((step) => [step.stepId, step]));
    this.selectedSteps = new Set([...this.selectedSteps].filter((id) => this.stepMap.has(id)));
    if (!this.stepMap.has(this.stepSelectionAnchor)) this.stepSelectionAnchor = null;
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
      ['rect', 'Rectangle'],
      ['oval', 'Oval'],
      ['line', 'Line'],
      ['arrow', 'Arrow'],
      ['text', 'Text'],
      ['tooltip', 'Tip'],
      ['number', '#'],
      ['blur', 'Blur'],
      ['highlight', 'Highlight'],
      ['magnify', 'Mag'],
      ['cursor', 'Cursor'],
      ['crop', 'Crop'],
    ];

    this.dom = {};
    this.dom.root = el('div.editor', {},
      el('aside.pane-steps', {},
        el('div.pane-head', {},
          el('div', {},
            el('div.eyebrow', {}, t('Steps')),
            this.dom.stepCount = el('div.muted', {}, tn(0, '{count} step', '{count} steps')),
          ),
          el('div.row', {},
            this.dom.addStepBtn = el('button.primary', { type: 'button' }, t('Add')),
            this.dom.importBtn = el('button', { type: 'button' }, t('Import')),
            this.dom.selectStepsBtn = el('button', { type: 'button', title: t('Select steps; Shift-click to select a range') }, t('Select')),
          ),
        ),
        this.dom.stepsList = el('div.steps-list'),
        this.dom.stepBulkBar = el('div'),
        this.dom.paneFoot = el('div.pane-foot', {},
          this.dom.moveUpBtn = el('button.icon', { type: 'button', title: t('Move step up') }, '↑'),
          this.dom.moveDownBtn = el('button.icon', { type: 'button', title: t('Move step down') }, '↓'),
          this.dom.duplicateBtn = el('button', { type: 'button' }, t('Duplicate')),
          this.dom.deleteBtn = el('button.danger', { type: 'button' }, t('Delete')),
        ),
      ),
      el('section.pane-canvas', {},
        el('div.canvas-toolbar', {},
          ...toolButtons.map(([tool, label]) => this.dom[`tool-${tool}`] = el('button.tool', { type: 'button', dataset: { tool } }, label)),
          el('span.sep'),
          this.dom.zoomFitBtn = el('button.tool', { type: 'button' }, t('Fit')),
          this.dom.zoom100Btn = el('button.tool', { type: 'button' }, '100%'),
          this.dom.zoom125Btn = el('button.tool', { type: 'button' }, '125%'),
          this.dom.zoom150Btn = el('button.tool', { type: 'button' }, '150%'),
          el('span.sep'),
          this.dom.undoBtn = el('button.tool', { type: 'button' }, t('Undo')),
          this.dom.redoBtn = el('button.tool', { type: 'button' }, t('Redo')),
        ),
        this.dom.canvasWrap = el('div.canvas-wrap', {},
          this.dom.canvas = el('canvas', { width: 1, height: 1 }),
          this.dom.canvasEmpty = el('div.canvas-empty', {}, t('Select an image step to edit annotations.')),
        ),
      ),
      el('aside.pane-props', {},
        el('section', {},
          el('h3', {}, t('Step')),
          el('div.row', {},
            this.dom.titleInput = el('input', { type: 'text', placeholder: t('Step title'), style: { flex: 1 } }),
          ),
          this.dom.statusSelect = makeSelect('todo', [
            { value: 'todo', label: t('Todo') },
            { value: 'in-progress', label: t('In progress') },
            { value: 'done', label: t('Done') },
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
            el('div.form-row', {}, el('label', {}, t('Zoom')),
              this.dom.fvZoom = el('input', { type: 'range', min: 1, max: 3, step: 0.05, value: 1.5 })),
            el('div.form-row', {}, el('label', {}, t('Pan X')),
              this.dom.fvPanX = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 })),
            el('div.form-row', {}, el('label', {}, t('Pan Y')),
              this.dom.fvPanY = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 })),
            el('div.muted', {}, t('Exports crop to this view; the original image is never modified.')),
          ),
        ),
        el('section', {},
          el('h3', {}, t('Description')),
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
          el('h3', {}, t('Annotations')),
          this.dom.annotationList = el('div', { className: 'annotation-list' }),
          this.dom.annotationEditor = el('div', { className: 'annotation-editor' }),
        ),
        el('section', {},
          el('h3', {}, t('Blocks')),
          this.dom.blocksList = el('div', { className: 'blocks-list' }),
          el('div.row', {},
            this.dom.addTextBlockBtn = el('button', { type: 'button' }, t('+ Text block')),
            this.dom.addCodeBlockBtn = el('button', { type: 'button' }, t('+ Code')),
            this.dom.addTableBlockBtn = el('button', { type: 'button' }, t('+ Table')),
          ),
        ),
        el('section', {},
          el('h3', {}, t('Guide')),
          this.dom.guideSummary = el('div.muted', {}),
          this.dom.saveNowBtn = el('button.primary', { type: 'button', title: t('Save changes. For guides linked to a shared archive, also writes the archive file.') }, t('Save now')),
          this.dom.snapshotBtn = el('button', { type: 'button' }, t('Snapshot')),
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
    const btn = el('button', {
      type: 'button',
      onClick: () => this.formatDescription(action, block),
    }, label);
    btn.dataset.action = action;
    if (block) btn.dataset.block = block;
    return btn;
  }

  /** Reflect the current selection's formatting state on the toolbar buttons. */
  updateToolbarState() {
    if (!this.dom.richToolbar) return;
    for (const btn of this.dom.richToolbar.children) {
      const { action, block } = btn.dataset;
      let active = false;
      try {
        if (action === 'formatBlock') {
          active = document.queryCommandValue('formatBlock').toLowerCase() === (block || 'blockquote');
        } else if (action === 'bold' || action === 'italic' || action === 'insertUnorderedList' || action === 'insertOrderedList') {
          active = document.queryCommandState(action);
        }
      } catch {
        active = false;
      }
      btn.classList.toggle('active', active);
    }
  }

  bindShellEvents() {
    this.dom.addStepBtn.addEventListener('click', () => this.addEmptyStep());
    this.dom.importBtn.addEventListener('click', () => this.importImageSteps());
    this.dom.selectStepsBtn.addEventListener('click', () => this.toggleStepSelectMode());
    this.dom.stepsList.addEventListener('dragover', (e) => this.onStepDragOver(e));
    this.dom.stepsList.addEventListener('dragleave', (e) => {
      if (!this.dom.stepsList.contains(e.relatedTarget)) this.hideStepDropLine();
    });
    this.dom.stepsList.addEventListener('drop', (e) => this.onStepDrop(e));
    this.dom.moveUpBtn.addEventListener('click', () => this.moveSelectedStep(-1));
    this.dom.moveDownBtn.addEventListener('click', () => this.moveSelectedStep(1));
    this.dom.duplicateBtn.addEventListener('click', () => this.duplicateSelectedStep());
    this.dom.deleteBtn.addEventListener('click', () => this.deleteSelectedStep());
    this.dom.saveNowBtn.addEventListener('click', () => this.saveAll());
    this.dom.snapshotBtn.addEventListener('click', () => this.createSnapshot());
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
      const row = [...this.dom.stepsList.children].find((node) => node.dataset.stepId === this.selectedStepId);
      if (row) row.querySelector('.t').textContent = this.currentStep.title || t('Untitled step');
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
      this.pushCanvasHistory();
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
      this.canvas.setFocusedView(step.focusedView);
    });
    bindFocusedSlider(this.dom.fvZoom, 'zoom');
    bindFocusedSlider(this.dom.fvPanX, 'panX');
    bindFocusedSlider(this.dom.fvPanY, 'panY');

    this.dom.addTextBlockBtn.addEventListener('click', () => this.addBlock('text'));
    this.dom.addCodeBlockBtn.addEventListener('click', () => this.addBlock('code'));
    this.dom.addTableBlockBtn.addEventListener('click', () => this.addBlock('table'));

    this.dom.descEditor.addEventListener('focus', () => {
      // Make Enter start a new paragraph (<p>) rather than a plain <div>,
      // so line breaks survive sanitization and show up in exports.
      document.execCommand('defaultParagraphSeparator', false, 'p');
      if (this.currentStep) this.pushCanvasHistory('description');
      this.updateToolbarState();
    });
    this.dom.descEditor.addEventListener('blur', () => {
      for (const btn of this.dom.richToolbar.children) btn.classList.remove('active');
    });
    this.dom.descEditor.addEventListener('input', () => {
      if (!this.currentStep) return;
      this.currentStep.descriptionHtml = this.dom.descEditor.innerHTML;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.emitMeta();
      this.updateToolbarState();
    });
    this.dom.descEditor.addEventListener('keyup', () => this.updateToolbarState());
    this.dom.descEditor.addEventListener('mouseup', () => this.updateToolbarState());
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === this.dom.descEditor) this.updateToolbarState();
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
    this.canvas.setFocusedView(fv);
  }

  // ---- text / code / table blocks ----------------------------------------

  addBlock(kind) {
    const step = this.currentStep;
    if (!step) {
      this.onToast(t('Select a step first.'), { error: true });
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
      this.dom.blocksList.append(el('div.muted', {}, t('Select a step to add blocks.')));
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
      type: 'button', title: t('Remove block'),
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
        el('button.icon', { type: 'button', title: t('Move block up'), disabled: !canMoveUp, onClick: moveUp, dataset: { blockMove: 'up' } }, '↑'),
        el('button.icon', { type: 'button', title: t('Move block down'), disabled: !canMoveDown, onClick: moveDown, dataset: { blockMove: 'down' } }, '↓'),
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
        card.dataset.level = block.level || 'info';
        const position = makeSelect(block.position, [
          { value: 'before-title', label: t('Before title') },
          { value: 'after-title', label: t('After title') },
          { value: 'before-image', label: t('Before image') },
          { value: 'after-image', label: t('After image') },
          { value: 'before-description', label: t('Before description') },
          { value: 'after-description', label: t('After description') },
        ]);
        position.dataset.blockField = 'position';
        const level = makeSelect(block.level, [
          { value: 'info', label: t('Note') },
          { value: 'warn', label: t('Warning') },
          { value: 'error', label: t('Important') },
          { value: 'success', label: t('Tip') },
        ]);
        level.dataset.blockField = 'level';
        const title = el('input', { type: 'text', value: block.title || '', placeholder: t('Block title') });
        title.dataset.blockField = 'title';
        const body = el('textarea', { rows: 2, placeholder: t('Block text') });
        body.dataset.blockField = 'body';
        body.value = (block.descriptionHtml || '').replace(/<[^>]+>/g, '');
        position.addEventListener('change', () => { block.position = position.value; save(); });
        level.addEventListener('change', () => { block.level = level.value; card.dataset.level = level.value; save(); });
        title.addEventListener('input', () => { block.title = title.value; save(); });
        body.addEventListener('input', () => { block.descriptionHtml = `<p>${escapeHtml(body.value)}</p>`; save(); });
        card.append(
          el('div.row', {}, level, position),
          title,
          body,
        );
      } else if (kind === 'code') {
        const lang = el('input', { type: 'text', value: block.language || '', placeholder: t('Language (e.g. bash)') });
        lang.dataset.blockField = 'language';
        const code = el('textarea', { rows: 3, placeholder: t('Code'), spellcheck: false });
        code.dataset.blockField = 'code';
        code.value = blockText(block);
        code.style.fontFamily = 'monospace';
        lang.addEventListener('input', () => { block.language = lang.value; save(); });
        code.addEventListener('input', () => { block.code = code.value; save(); });
        card.append(lang, code);
      } else if (kind === 'table') {
        const grid = el('textarea', { rows: 3, placeholder: t('One row per line, cells separated by |'), spellcheck: false });
        grid.dataset.blockField = 'rows';
        grid.value = (block.rows || []).map((r) => r.join(' | ')).join('\n');
        grid.addEventListener('input', () => {
          block.rows = grid.value.split('\n').filter((l) => l.trim() !== '')
            .map((line) => line.split('|').map((c) => c.trim()));
          save();
        });
        card.append(
          el('div.muted', {}, t('First line is the header row.')),
          grid,
        );
      }

      this.dom.blocksList.append(card);
    }

    if (!blocks.length) {
      this.dom.blocksList.append(el('div.muted', {}, t('Informational text, code, and table blocks can be reordered with drag handles or arrows.')));
    }
  }

  renderStepList() {
    const current = this.currentStep;
    const numbers = stepNumberMap(this.steps);
    clearNode(this.dom.stepsList);
    this.dom.stepCount.textContent = tn(this.steps.length, '{count} step', '{count} steps');
    this.dom.selectStepsBtn.className = this.stepSelectMode ? 'primary' : '';
    for (const step of this.steps) {
      const number = numbers.get(step.stepId) || '';
      const depth = stepDepth(step, this.stepMap);
      const selected = current && current.stepId === step.stepId;
      const checked = this.selectedSteps.has(step.stepId);
      const itemProps = {
        className: `step-item${selected ? ' selected' : ''}${depth ? ' sub' : ''}${step.skipped ? ' skipped' : ''}${step.hidden ? ' hiddenstep' : ''}`,
        dataset: { stepId: step.stepId },
        draggable: !this.stepSelectMode,
        onDragStart: (e) => this.onStepDragStart(e, step.stepId),
        onDragEnd: () => this.endStepDrag(),
        onMouseDown: (e) => {
          if (this.stepSelectMode && e.shiftKey) e.preventDefault();
        },
        onClick: (e) => {
          if (this.stepSelectMode) this.toggleStepSelection(step.stepId, e.shiftKey);
          else this.selectStep(step.stepId);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          if (this.stepSelectMode) return;
          this.selectStep(step.stepId);
          contextMenu(e.clientX, e.clientY, [
            { label: t('Add substep'), action: () => this.addSubstep(step.stepId) },
            {
              label: t('Make substep of…'),
              submenu: () => {
                const subtreeIds = new Set([step.stepId, ...this.getStepDescendantIds(step.stepId)]);
                return this.steps
                  .filter((s) => !subtreeIds.has(s.stepId))
                  .map((s) => ({
                    label: `${numbers.get(s.stepId)}  ${s.title || t('Untitled step')}`,
                    action: () => this.makeSubstepOf(step.stepId, s.stepId),
                  }));
              },
            },
            { label: t('Duplicate step'), action: () => this.duplicateSelectedStep() },
            { label: t('Choose image…'), action: () => this.chooseScreenshot(step.stepId) },
            {
              label: t('Retake screenshot'),
              submenu: [
                { label: t('Full screen'), action: () => this.retakeScreenshot(step.stepId, 'fullscreen') },
                { label: t('Window'), action: () => this.retakeScreenshot(step.stepId, 'window') },
                { label: t('Region…'), action: () => this.retakeScreenshot(step.stepId, 'region') },
              ],
            },
            'sep',
            { label: t('Move up'), action: () => this.moveSelectedStep(-1) },
            { label: t('Move down'), action: () => this.moveSelectedStep(1) },
            { label: t('Move to…'), action: () => this.moveStepTo(step.stepId) },
            'sep',
            { label: t('Delete step'), danger: true, action: () => this.deleteSelectedStep() },
          ]);
        },
      };
      if (depth) itemProps.style = { marginLeft: `${depth * 18}px` };
      const item = el('div.step-item', itemProps,
        this.stepSelectMode
          ? el('input', {
            type: 'checkbox',
            checked,
            'aria-label': t('Select step {step}', { step: number || step.title || '' }),
            onClick: (e) => {
              e.stopPropagation();
              this.toggleStepSelection(step.stepId, e.shiftKey);
            },
          })
          : null,
        el('span.status-dot', { className: `status-dot status-${step.status}` }),
        el('span.num', {}, number || '•'),
        el('span.t', {}, step.title || t('Untitled step')),
        el('span.flags', {}, [
          step.parentStepId ? 'sub' : '',
          step.hidden ? 'hidden' : '',
          step.skipped ? 'skipped' : '',
        ].filter(Boolean).join(' · ')),
      );
      this.dom.stepsList.append(item);
    }
    if (!this.steps.length) {
      this.dom.stepsList.append(el('div.empty-state', { style: { marginTop: '40px' } }, t('No steps yet.')));
    }
    this.renderStepBulkBar();
  }

  toggleStepSelectMode() {
    this.stepSelectMode = !this.stepSelectMode;
    this.selectedSteps = new Set();
    this.stepSelectionAnchor = null;
    this.renderStepList();
  }

  toggleStepSelection(stepId, shiftKey = false) {
    const target = this.steps.findIndex((step) => step.stepId === stepId);
    if (target < 0) return;
    const anchor = this.steps.findIndex((step) => step.stepId === this.stepSelectionAnchor);
    if (shiftKey && anchor >= 0) {
      for (let i = Math.min(anchor, target); i <= Math.max(anchor, target); i++) {
        this.selectedSteps.add(this.steps[i].stepId);
      }
    } else {
      if (this.selectedSteps.has(stepId)) this.selectedSteps.delete(stepId);
      else this.selectedSteps.add(stepId);
      this.stepSelectionAnchor = stepId;
    }
    this.renderStepList();
  }

  selectAllSteps() {
    this.selectedSteps = new Set(this.steps.map((s) => s.stepId));
    this.stepSelectionAnchor = null;
    this.renderStepList();
  }

  clearStepSelection() {
    this.selectedSteps = new Set();
    this.stepSelectionAnchor = null;
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
        }, allSelected ? t('Clear') : t('Select all')),
        this.annotationClipboard
          ? el('button', {
            type: 'button',
            disabled: !n,
            title: t('Add the copied annotation at the same position on each selected step'),
            onClick: () => this.pasteAnnotationToSelectedSteps(),
          }, tn(n, 'Paste annotation to {count} step', 'Paste annotation to {count} steps'))
          : null,
        el('button.danger', { type: 'button', disabled: !n, onClick: () => this.deleteSelectedSteps() }, t('Delete')),
      ),
    );
  }

  async deleteSelectedSteps() {
    const ids = [...this.selectedSteps];
    if (!ids.length) return;
    const ok = await confirmDialog(`Delete ${ids.length} step${ids.length === 1 ? '' : 's'}?`, { danger: true, okLabel: t('Delete') });
    if (!ok) return;
    if (this.pendingSave) await this.flushStep();
    const order = this.steps.map((s) => s.stepId);
    const entries = [];
    for (const stepId of ids) {
      const step = this.stepMap.get(stepId);
      if (step) entries.push(await this.snapshotStepForDeletion(step));
    }
    for (const stepId of ids) {
      await api.step.delete({ guideId: this.guideId, stepId });
    }
    if (entries.length) this.pushCanvasHistory({ type: 'delete-step', steps: entries, order });
    this.stepSelectMode = false;
    this.selectedSteps = new Set();
    this.stepSelectionAnchor = null;
    await this.reload(null);
    this.onToast(`${ids.length} step${ids.length === 1 ? '' : 's'} deleted. Press Ctrl+Z to undo.`);
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
      ? `${guide.title} · ${guide.linkedSource ? t('linked') : t('local')} · ${tn(this.steps.length, '{count} step', '{count} steps')}`
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
      this.canvas.setFocusedView(step.focusedView);
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
      this.dom.annotationList.append(el('div.muted', {}, t('No step selected.')));
      clearNode(this.dom.annotationEditor);
      this.dom.annotationEditor.append(el('div.muted', {}, t('Select a step to edit annotations.')));
      return;
    }

    const anns = step.annotations || [];
    if (!anns.length) {
      this.dom.annotationList.append(el('div.muted', {}, t('No annotations yet. Pick a tool and drag on the canvas.')));
    } else {
      for (const ann of anns) {
        const selected = this.canvas.selected() && this.canvas.selected().id === ann.id;
        this.dom.annotationList.append(el('div.block-card', {
          dataset: { annId: ann.id },
          style: { cursor: 'pointer', borderColor: selected ? 'var(--accent)' : '' },
        },
        el('div.row', {}, el('strong', {}, ANNOTATION_TYPE_LABELS[ann.type] || ann.type),
          // Blurs StepForge added for a private detail say what they hide.
          el('span.muted', {}, ann.redact ? t('Private detail: {kind}', { kind: PRIVATE_DETAIL_LABELS[ann.redact.kind] || t('added by StepForge') }) : ann.text || ann.value || '')),
        el('div.muted', {}, `${ann.x.toFixed(3)}, ${ann.y.toFixed(3)} · ${ann.w.toFixed(3)} × ${ann.h.toFixed(3)}`)));
      }
    }

    const selected = this.canvas.selected();
    clearNode(this.dom.annotationEditor);
    if (!selected) {
      this.dom.annotationEditor.append(el('div.muted', {}, t('Select an annotation to edit its style.')));
      return;
    }

    const style = selected.style || {};
    const typeSelect = makeSelect(selected.type, [
      'rect', 'oval', 'line', 'arrow', 'text', 'tooltip', 'number', 'blur', 'highlight', 'magnify', 'cursor',
    ].map((type) => ({ value: type, label: ANNOTATION_TYPE_LABELS[type] || type })));
    const valueInput = el('input', { type: 'number', value: Number.isFinite(selected.value) ? selected.value : '', placeholder: t('Value') });
    const strokeInput = el('input', { type: 'color', value: style.stroke || '#E5484D' });
    const fillInput = el('input', { type: 'color', value: style.fill && style.fill !== 'transparent' ? style.fill : '#ffffff' });
    const strokeWidthInput = el('input', { type: 'number', min: 1, step: 1, value: style.strokeWidth || 3 });
    const fontSizeInput = el('input', { type: 'number', min: 0.01, step: 0.001, value: style.fontSize || 0.022 });
    const textColorInput = el('input', { type: 'color', value: style.textColor || '#ffffff' });
    const zoomInput = el('input', { type: 'number', min: 1, step: 0.1, value: selected.zoom || 2 });
    const radiusInput = el('input', { type: 'number', min: 1, step: 1, value: selected.radius || 8 });
    const tailInput = makeSelect(style.tail || 'bottom', [
      { value: 'bottom', label: t('Bottom') },
      { value: 'top', label: t('Top') },
      { value: 'left', label: t('Left') },
      { value: 'right', label: t('Right') },
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

    const fields = new Set(ANNOTATION_FIELDS[selected.type] || []);
    const strokeLabel = (selected.type === 'text' || selected.type === 'number') ? t('Color') : t('Stroke');
    const typeLabel = ANNOTATION_TYPE_LABELS[selected.type] || selected.type;
    const textInput = fields.has('text')
      ? el('textarea', {
        rows: Math.max(3, Math.min(8, String(selected.text || '').split('\n').length)),
        placeholder: t('Annotation text'),
        spellcheck: true,
      })
      : el('input', { type: 'text', value: selected.text || '', placeholder: t('Annotation text') });
    if (fields.has('text')) textInput.value = selected.text || '';

    const rows = [labeledRow(t('Type'), typeSelect)];
    if (fields.has('text')) rows.push(labeledRow(t('Text'), textInput, { stacked: true }));
    if (fields.has('value')) rows.push(labeledRow(t('Value'), valueInput));
    if (fields.has('stroke')) rows.push(labeledRow(strokeLabel, strokeInput));
    if (fields.has('fill')) rows.push(labeledRow(t('Fill'), fillInput));
    if (fields.has('strokeWidth')) rows.push(labeledRow(t('Stroke width'), strokeWidthInput));
    if (fields.has('fontSize')) rows.push(labeledRow(t('Font size'), fontSizeInput));
    if (fields.has('textColor')) rows.push(labeledRow(t('Text color'), textColorInput));
    if (fields.has('zoom')) rows.push(labeledRow(t('Zoom'), zoomInput));
    if (fields.has('radius')) rows.push(labeledRow(t('Radius'), radiusInput));
    if (fields.has('tail')) rows.push(labeledRow(t('Tail'), tailInput));
    rows.push(
      el('div.muted', {}, t('Copy this style to every other “{type}” annotation:', { type: typeLabel })),
      el('div.row', {},
        el('button', {
          type: 'button',
          title: t('Overwrite the style of every “{type}” annotation on this step with the style shown above.', { type: typeLabel }),
          onClick: () => this.applyStyleAcross('step'),
        }, t('This step')),
        el('button', {
          type: 'button',
          title: t('Overwrite the style of every “{type}” annotation across all steps in this guide with the style shown above.', { type: typeLabel }),
          onClick: () => this.applyStyleAcross('guide'),
        }, t('Entire guide')),
      ),
    );

    const annSection = el('div', { className: 'annotation-editor-inner' }, ...rows);
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

  defaultStyleForTool(tool) {
    // A brand profile's own colors for shapes, number badges and tooltips.
    const brand = this.brandAnnotations;
    switch (tool) {
      case 'highlight': return { fill: '#ffe066', stroke: '#ffbf00', strokeWidth: 1 };
      case 'tooltip': return brand
        ? { fill: brand.tooltips, textColor: readableTextOn(brand.tooltips), stroke: brand.tooltips, tail: 'bottom' }
        : { fill: '#111827', textColor: '#ffffff', stroke: '#111827', tail: 'bottom' };
      case 'number': return brand
        ? { fill: brand.numbers, stroke: brand.numbers, textColor: readableTextOn(brand.numbers) }
        : { fill: '#1f6feb', stroke: '#1f6feb', textColor: '#ffffff' };
      case 'blur': return { fill: 'transparent', stroke: '#9ca3af', strokeWidth: 2 };
      case 'cursor': return { fill: '#ffffff', stroke: '#111827', strokeWidth: 2 };
      default: return { fill: 'transparent', stroke: brand?.shapes || '#E5484D', strokeWidth: 3, textColor: '#ffffff' };
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

  applyZoomShortcut(kind) {
    if (kind === 'in') {
      this.setZoom(Math.min(3, (Number(this.currentZoom) || 1) + 0.25));
      return true;
    }
    if (kind === 'out') {
      this.setZoom(Math.max(0.25, (Number(this.currentZoom) || 1) - 0.25));
      return true;
    }
    if (kind === 'fit') {
      this.setZoom('fit');
      return true;
    }
    return false;
  }

  /**
   * Push an undo record. Ctrl+Z pops the newest record and puts the state it
   * describes back, Ctrl+Y does the reverse; every record is "the state to go
   * back to", so undo and redo each swap it with the state they replace. Records:
   *   { step, image?, original? }  one step's fields (and images); the default,
   *                                taken from the current step when called bare.
   *   { type: 'delete-step', steps, order }
   *                                steps removed, with their images and position.
   *   { type: 'move-steps', order, parents }
   *                                the guide's step order and each step's parent
   *                                (stepId -> parentStepId | null); see
   *                                outlineRecord().
   *   { type: 'multi-step', steps, after }
   *                                full clones of several steps, restored by id
   *                                with no images; `after` is each step's
   *                                stepFingerprint() right after the edit, to
   *                                spot later changes. See multiStepRecord().
   * Typed records do not need a current step.
   */
  pushCanvasHistory(recordOrLabel = 'change') {
    const typed = !!(recordOrLabel && typeof recordOrLabel === 'object' && recordOrLabel.type);
    if (!typed && !this.currentStep) return;
    const record = typed || (recordOrLabel && typeof recordOrLabel === 'object' && recordOrLabel.step)
      ? recordOrLabel
      : { step: clone(this.currentStep) };
    this.canvasHistory.push(record);
    if (this.canvasHistory.length > 40) this.canvasHistory.shift();
    this.canvasFuture.length = 0;
    this.beforeCanvasSnapshot = null;
  }

  /** A 'move-steps' record of the guide's step order and parents as they are now. */
  outlineRecord() {
    return {
      type: 'move-steps',
      order: this.steps.map((s) => s.stepId),
      parents: Object.fromEntries(this.steps.map((s) => [s.stepId, s.parentStepId || null])),
    };
  }

  /**
   * A 'multi-step' record. `before` are step clones taken before an edit;
   * `after` are the steps as the edit saved them. Their content lets undo
   * notice a step that an AI pass or agent changed since, and ask first.
   */
  multiStepRecord(before, after = []) {
    return {
      type: 'multi-step',
      steps: before.map((step) => clone(step)),
      after: Object.fromEntries(after.filter((s) => s && s.stepId).map((s) => [s.stepId, stepFingerprint(s)])),
    };
  }

  /**
   * Put a 'move-steps' record's order and parents back. Returns the record for
   * the state it replaced, or undefined (the record is dropped) if it could
   * not be restored. Steps added since the move (a live capture, a paste, a
   * new substep) are kept, and deleted ones are skipped; see reconcileOrder().
   */
  async applyOutlineRecord(record) {
    const now = this.outlineRecord();
    const recorded = record.parents || {};
    const order = reconcileOrder(record.order, now.order, { ...now.parents, ...recorded }, now.parents);
    const parentOf = new Map(order.map((id) => [id, (id in recorded ? recorded[id] : now.parents[id]) || null]));
    // The recorded outline may be one an old move broke, which the move being
    // undone repaired. Put the order back but keep those recorded steps
    // flattened, as the store refuses to break a valid outline. Steps added
    // since keep the parents they have now.
    if (outline.isValidOutline && !outline.isValidOutline(order, parentOf)) {
      const repaired = outline.repairOutline(order, parentOf);
      for (const id of order) if (id in recorded) parentOf.set(id, repaired.get(id));
    }
    // Only send parents that differ.
    const parents = {};
    for (const [id, parentId] of parentOf) {
      if (now.parents[id] !== (parentId || null)) parents[id] = parentId || null;
    }
    try {
      await api.step.reorder({ guideId: this.guideId, order, parents });
    } catch (err) {
      this.onToast(t('Could not undo the move: {error}', { error: err.message || err }), { error: true });
      return undefined;
    }
    await this.reload(this.selectedStepId);
    return now;
  }

  /**
   * Put a 'multi-step' record's steps back. Returns the record for the
   * states it replaced, or null if nothing was restored (the user said no,
   * or none of the steps exist any more).
   */
  async applyMultiStepRecord(record) {
    // Compare against what is on disk, not what this editor last saw.
    await this.reload(this.selectedStepId);
    const targets = record.steps.filter((step) => this.stepMap.has(step.stepId));
    const stale = targets.filter((step) => {
      const expected = record.after && record.after[step.stepId];
      return expected !== undefined && stepFingerprint(this.stepMap.get(step.stepId)) !== expected;
    });
    if (stale.length) {
      const ok = await confirmDialog(
        tn(stale.length, 'A step was changed since this edit, perhaps by AI or another app. Undo anyway and overwrite those changes?',
          '{count} steps were changed since this edit, perhaps by AI or another app. Undo anyway and overwrite those changes?'),
        { danger: true, okLabel: t('Undo anyway') },
      );
      if (!ok) return null;
    }
    const replaced = [];
    const saved = [];
    const failed = [];
    let error = null;
    for (const step of targets) {
      const current = this.stepMap.get(step.stepId);
      const restored = clone(step);
      restored.revision = current.revision; // a restore is a new revision, not an old one
      try {
        const result = await api.step.save({ guideId: this.guideId, step: restored });
        replaced.push(clone(current));
        saved.push(this.commitBatchSave(result));
      } catch (err) {
        error = error || err;
        failed.push(step);
      }
    }
    if (error) this.onToast(t('Could not undo every step: {error}', { error: error.message || error }), { error: true });
    await this.reload(this.selectedStepId);
    if (!saved.length) return null;
    const inverse = this.multiStepRecord(replaced, saved);
    if (!failed.length) return inverse;
    // Some steps were put back and some were not. The ones put back can be
    // redone; the ones that failed stay on this stack, so pressing the key
    // again retries just those and no step's earlier state is lost.
    const rest = { ...record, steps: failed };
    return { partial: true, inverse, rest };
  }

  async snapshotCurrentStep(includeImage = false, target = this.currentStep) {
    if (!target) return null;
    const record = { step: clone(target) };
    if (includeImage && target.image) {
      const image = await this.currentStepImageToBase64(target);
      if (image) record.image = image;
      // Choose image… replaces the original too, so undo needs it.
      const original = await this.stepImageToBase64(target, 'original');
      if (original) record.original = original;
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
      const saved = record.original
        ? await api.step.setImages({
          guideId: this.guideId,
          step,
          originalBase64: record.original.base64,
          workingBase64: record.image.base64,
          size: record.image.size,
        })
        : await api.step.setWorkingImage({
          guideId: this.guideId,
          stepId: step.stepId,
          pngBase64: record.image.base64,
          size: record.image.size,
          step,
        });
      this.commitSavedStep(saved);
    } else {
      await this.flushStep(step);
    }
  }

  async undo() {
    if (!this.canvasHistory.length) {
      this.onToast(t('Nothing to undo.'));
      return;
    }
    if (!(await this.settlePendingSave())) return;
    const previous = this.canvasHistory.pop();
    const current = await this.swapHistoryRecord(previous, 'undo');
    if (!current) {
      if (current === null) this.canvasHistory.push(previous);
      return;
    }
    if (current.partial) {
      this.canvasHistory.push(current.rest);
      this.canvasFuture.push(current.inverse);
    } else {
      this.canvasFuture.push(current);
    }
    this.renderAll();
  }

  async redo() {
    if (!this.canvasFuture.length) {
      this.onToast(t('Nothing to redo.'));
      return;
    }
    if (!(await this.settlePendingSave())) return;
    const next = this.canvasFuture.pop();
    const current = await this.swapHistoryRecord(next, 'redo');
    if (!current) {
      if (current === null) this.canvasFuture.push(next);
      return;
    }
    if (current.partial) {
      this.canvasFuture.push(current.rest);
      this.canvasHistory.push(current.inverse);
    } else {
      this.canvasHistory.push(current);
    }
    this.renderAll();
  }

  /**
   * Put `record`'s state back and return a record of the state it replaced, so
   * the caller can park it on the opposite stack. Returns null when nothing was
   * restored (the record stays where it was), undefined when the record was
   * unusable (it is dropped), and { partial, inverse, rest } when only some
   * steps of a 'multi-step' record were restored: `inverse` goes on the
   * opposite stack and `rest` (the steps that failed) stays for a retry.
   */
  async swapHistoryRecord(record, direction) {
    if (record.type === 'delete-step') {
      if (direction === 'undo') await this.restoreDeletedSteps(record);
      else await this.deleteStepsAgain(record);
      return record;
    }
    if (record.type === 'move-steps') return this.applyOutlineRecord(record);
    if (record.type === 'multi-step') return this.applyMultiStepRecord(record);
    const target = this.stepMap.get(record.step && record.step.stepId);
    if (!target) return undefined;
    const current = await this.snapshotCurrentStep(true, target);
    await this.restoreHistoryRecord(record);
    return current;
  }

  /**
   * Before an edit that saves several steps itself (undo, bulk paste, find
   * and replace): stop the autosave timer, so it can't later write an old copy
   * of a step over the batch, and save the current step's pending edits.
   * False if that save failed; the caller must then stop, leaving the edits
   * in the editor for the retry instead of reloading over them.
   */
  async settlePendingSave() {
    this.saveStepDebounced.cancel();
    if (!this.pendingSave) return true;
    return (await this.flushStep()) !== null;
  }

  /**
   * Take a step a batch edit saved into the live editor state, so an autosave
   * or a later edit starts from it rather than from the copy before the batch.
   */
  commitBatchSave(saved) {
    return this.commitSavedStep(saved, { replaceBlocks: true });
  }

  async flushStep(step = this.currentStep) {
    if (!step) return;
    if (this.linkedSaveInFlight) {
      // A linked save may be merging another session's changes into the
      // library copy; writing this older copy now would undo them. Wait, then
      // save the step as it is after the merge (with these edits put back).
      const live = this.stepMap.get(step.stepId) === step;
      while (this.linkedSaveInFlight) await this.linkedSaveInFlight;
      if (live) step = this.stepMap.get(step.stepId) || step;
    }
    // Clear the dirty flag only AFTER a durable save. Clearing it first meant
    // a rejected IPC save silently lost the unsaved state (and this runs from
    // a debounce that does not handle rejections). Keep it dirty on failure,
    // surface it, and retry on the next edit or explicit save.
    let saved;
    try {
      saved = await api.step.save({ guideId: this.guideId, step });
    } catch (err) {
      this.pendingSave = true;
      this.saveError = (err && err.message) || t('Save failed');
      this.emitMeta();
      this.onToast(t('Could not save this step — your changes are kept. Retrying…'), { error: true });
      return null;
    }
    this.pendingSave = false;
    this.saveError = null;
    const committed = this.commitSavedStep(saved);
    if (this.selectedStepId === committed.stepId) {
      this.renderStepList();
      this.syncStepFields();
      this.canvas.setAnnotations(committed.annotations || []);
      // Rebuilding the annotation editor while the user is typing in one of
      // its inputs would steal focus, so skip it in that case.
      if (!this.dom.annotationEditor.contains(document.activeElement)) {
        this.renderAnnotationPanel();
      }
      this.emitMeta();
    }
    return committed;
  }

  commitSavedStep(saved, { replaceBlocks = false } = {}) {
    if (!saved || !saved.stepId) return saved;
    const existing = this.stepMap.get(saved.stepId);
    if (!existing || existing === saved) {
      this.stepMap.set(saved.stepId, saved);
      const idx = this.steps.findIndex((s) => s.stepId === saved.stepId);
      if (idx >= 0) this.steps[idx] = saved;
      return saved;
    }

    // Keep the live block arrays so block-card closures keep pointing at the
    // same objects after the backend returns a fresh saved step. A caller
    // that re-renders the blocks (an AI write) takes the saved ones instead.
    const preservedBlocks = replaceBlocks ? {} : {
      textBlocks: existing.textBlocks,
      codeBlocks: existing.codeBlocks,
      tableBlocks: existing.tableBlocks,
    };
    for (const key of Object.keys(existing)) {
      if (!(key in saved)) delete existing[key];
    }
    Object.assign(existing, saved, preservedBlocks);
    this.stepMap.set(existing.stepId, existing);
    const idx = this.steps.findIndex((s) => s.stepId === existing.stepId);
    if (idx >= 0) this.steps[idx] = existing;
    return existing;
  }

  async flushGuide() {
    while (this.linkedSaveInFlight) await this.linkedSaveInFlight; // see flushStep
    if (!this.guide) return;
    try {
      await api.guide.save({ guide: this.guide });
    } catch (err) {
      this.pendingGuideSave = true;
      this.saveError = (err && err.message) || t('Save failed');
      this.emitMeta();
      this.onToast(t('Could not save guide details — your changes are kept. Retrying…'), { error: true });
      return;
    }
    this.pendingGuideSave = false;
    this.saveError = null;
    this.emitMeta();
  }

  /** More → Find private details…: check the screenshots, then review what was blurred. */
  async findPrivateDetails() {
    if (!this.guideId) return;
    await this.saveAll();
    const { changed, show } = await showPrivacyDialog({ api, guideId: this.guideId, canShow: true });
    if (changed || show) await this.reload(show?.stepId || this.selectedStepId);
    if (show) this.canvas.select(show.annotationId);
  }

  async saveAll() {
    if (this.currentStep) await this.flushStep();
    if (this.guide) await this.flushGuide();
    if (this.guide && this.guide.linkedSource) {
      const result = await this.runLinkedSave({ force: false });
      if (result.saved) {
        if (this.guide.linkedSource) this.guide.linkedSource.lastSavedAt = new Date().toISOString();
        this.toastLinkedSave(result, t('Saved and synced to linked archive.'));
      } else {
        this.onToast(t('Saved locally, but the linked archive is locked by another session.'), { error: true });
      }
      return;
    }
    this.onToast(t('Saved.'));
  }

  /**
   * Write a linked guide to its shared archive. If another session saved it
   * meanwhile, the main process merges the two into the library copy first,
   * so until this finishes the editor holds an older copy: step and guide
   * saves wait for it (see flushStep / flushGuide) rather than write that
   * copy over the merge. A merge reloads the guide, and edits made during the
   * write are put back on top of it, field by field (reapplyEditsAfterMerge).
   */
  async runLinkedSave({ force = false } = {}) {
    while (this.linkedSaveInFlight) await this.linkedSaveInFlight;
    if (this.pendingSave) await this.flushStep();
    if (this.pendingGuideSave) await this.flushGuide();
    const snapshot = { guide: clone(this.guide), steps: new Map(this.steps.map((step) => [step.stepId, clone(step)])) };
    let finished;
    this.linkedSaveInFlight = new Promise((resolve) => { finished = resolve; });
    try {
      const result = await api.archive.saveLinked({ guideId: this.guideId, force });
      if (result && result.saved && result.merged) await this.reapplyEditsAfterMerge(snapshot);
      return result;
    } finally {
      this.linkedSaveInFlight = null;
      finished();
    }
  }

  /**
   * Reload the merged guide, then put back what was edited since `snapshot`
   * (taken when the linked save started): only the fields that changed, so
   * whatever the merge brought in elsewhere in the step or guide is kept.
   */
  async reapplyEditsAfterMerge(snapshot) {
    const liveSteps = new Map(this.steps.map((step) => [step.stepId, step]));
    const liveGuide = this.guide;
    await this.reload();
    const BOOKKEEPING = new Set(['revision', 'updatedAt', 'createdAt', 'stepsOrder', 'linkedSource']);
    const changedKeys = (now, then) => [...new Set([...Object.keys(now || {}), ...Object.keys(then || {})])]
      .filter((key) => !BOOKKEEPING.has(key) && JSON.stringify(now[key]) !== JSON.stringify(then[key]));
    const apply = (target, source, keys) => {
      for (const key of keys) {
        if (source[key] === undefined) delete target[key];
        else target[key] = clone(source[key]);
      }
    };
    const others = [];
    for (const [stepId, then] of snapshot.steps) {
      const now = liveSteps.get(stepId);
      const fresh = this.stepMap.get(stepId);
      if (!now || !fresh) continue;
      const keys = changedKeys(now, then);
      if (!keys.length) continue;
      apply(fresh, now, keys);
      if (stepId === this.selectedStepId) this.pendingSave = true;
      else others.push(fresh);
    }
    // Saved directly: flushStep would wait for the save this is part of.
    for (const step of others) this.commitSavedStep(await api.step.save({ guideId: this.guideId, step }));
    const guideKeys = liveGuide && this.guide ? changedKeys(liveGuide, snapshot.guide) : [];
    if (guideKeys.length) {
      apply(this.guide, liveGuide, guideKeys);
      this.pendingGuideSave = true;
    }
    this.renderAll();
    if (this.pendingSave) this.saveStepDebounced();
    if (this.pendingGuideSave) this.saveGuideDebounced();
  }

  /** Toast a linked save, saying when it merged another session's changes. */
  toastLinkedSave(result, message) {
    if (!result.merged) return this.onToast(message);
    const conflicts = result.conflicts
      ? ` ${tn(result.conflicts, '{count} conflict was settled in favor of the most recent edit.', '{count} conflicts were settled in favor of the most recent edit.')}`
      : '';
    return this.onToast(`${message} ${t('Merged changes from another session.')}${conflicts}`);
  }

  async createSnapshot() {
    if (!this.guideId) return;
    const label = await dialogs.promptText({
      title: t('Create snapshot'),
      label: t('Snapshot name'),
      placeholder: 'manual',
    });
    if (label == null) return;
    if (this.currentStep) await this.flushStep();
    if (this.guide) await this.flushGuide();
    await api.snapshots.create({ guideId: this.guideId, label: label.trim() || 'manual' });
    this.onToast(t('Snapshot created.'));
  }

  async selectStep(stepId) {
    if (!this.stepMap.has(stepId)) return;
    // Persist any unsaved edits on the outgoing step before switching, so a
    // later guide-wide reload (e.g. applyStyleAcross('guide')) doesn't
    // discard them by re-fetching a stale on-disk copy.
    if (this.pendingSave) await this.flushStep();
    this.selectedStepId = stepId;
    this.selectedAnnotationId = null;
    this.canvas.select(null);
    this.syncStepFields();
    this.syncFocusedControls();
    this.renderStepList();
    this.renderCanvas();
    this.renderAnnotationPanel();
    this.renderBlocksPanel();
    this.emitMeta();
  }

  async addEmptyStep() {
    const title = await dialogs.promptText({
      title: t('Add Step'),
      label: t('Step title'),
      value: '',
      placeholder: t('Untitled step'),
    });
    if (title == null) return;
    const step = await api.step.add({
      guideId: this.guideId,
      fields: {
        kind: 'empty',
        title: title.trim() || t('Untitled step'),
        status: 'todo',
      },
      position: this.steps.length,
    });
    await this.reload(step.stepId);
    this.onToast(t('Step added.'));
  }

  async addSubstep(parentStepId = this.selectedStepId) {
    if (!parentStepId) return;
    const title = await dialogs.promptText({
      title: t('Add Substep'),
      label: t('Substep title'),
      value: '',
      placeholder: t('Untitled substep'),
    });
    if (title == null) return;
    const parent = this.stepMap.get(parentStepId);
    const parentIndex = this.steps.findIndex((s) => s.stepId === parentStepId);
    const step = await api.step.add({
      guideId: this.guideId,
      fields: {
        kind: 'empty',
        title: title.trim() || t('Untitled substep'),
        parentStepId,
        status: 'todo',
      },
      position: parentIndex + 1,
    });
    await this.reload(step.stepId);
    this.onToast(parent ? t('Substep added.') : t('Step added.'));
  }

  /** All step ids whose ancestor chain leads back to `stepId`. */
  getStepDescendantIds(stepId) {
    const result = [];
    const queue = [stepId];
    while (queue.length) {
      const current = queue.shift();
      for (const s of this.steps) {
        if (s.parentStepId === current) {
          result.push(s.stepId);
          queue.push(s.stepId);
        }
      }
    }
    return result;
  }

  async makeSubstepOf(stepId, targetStepId) {
    const step = this.stepMap.get(stepId);
    const target = this.stepMap.get(targetStepId);
    if (!step || !target) return;
    const numbers = stepNumberMap(this.steps);
    const subtreeIds = new Set([stepId, ...this.getStepDescendantIds(stepId)]);
    if (subtreeIds.has(targetStepId)) {
      this.onToast(t('A step cannot be made a substep of itself or one of its own substeps.'), { error: true });
      return;
    }
    if (step.parentStepId === targetStepId) {
      this.onToast(t('“{title}” is already a substep of step {number}.', { title: step.title || t('Untitled step'), number: numbers.get(targetStepId) }));
      return;
    }

    const before = this.outlineRecord();
    step.parentStepId = targetStepId;
    await api.step.save({ guideId: this.guideId, step });

    // Move the step (with its own substeps) to sit right after the target
    // step's existing substeps, so it becomes the target's last substep.
    const order = this.steps.map((s) => s.stepId);
    const remaining = order.filter((id) => !subtreeIds.has(id));
    const targetSubtree = new Set([targetStepId, ...this.getStepDescendantIds(targetStepId)]);
    let insertAt = remaining.indexOf(targetStepId) + 1;
    while (insertAt < remaining.length && targetSubtree.has(remaining[insertAt])) insertAt++;
    const movedBlock = order.filter((id) => subtreeIds.has(id));
    remaining.splice(insertAt, 0, ...movedBlock);
    await api.step.reorder({ guideId: this.guideId, order: remaining });
    this.pushCanvasHistory(before);

    await this.reload(stepId);
    this.onToast(t('“{title}” is now a substep of step {number}.', { title: step.title || t('Untitled step'), number: numbers.get(targetStepId) }));
  }

  async duplicateSelectedStep() {
    const step = this.currentStep;
    if (!step) return;
    const copy = clone(step);
    copy.stepId = undefined;
    copy.title = copy.title ? `${copy.title} copy` : t('Untitled step copy');
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
    this.onToast(t('Step duplicated.'));
  }

  /**
   * Step menu → Choose image…: use an image file as the step's
   * screenshot. Its title, description and annotations stay; Ctrl+Z puts
   * the old screenshot back.
   */
  async chooseScreenshot(stepId) {
    await this.replaceStepScreenshot(stepId, (step) => api.step.chooseImage({ guideId: this.guideId, stepId: step.stepId }));
  }

  /**
   * Step menu → Retake screenshot: StepForge hides itself, counts down and
   * grabs a new screenshot for this step. Like Choose image…, the text
   * and annotations stay and Ctrl+Z puts the old screenshot back.
   */
  async retakeScreenshot(stepId, mode = 'fullscreen', delayMs = RETAKE_DELAY_MS) {
    if (stepId && stepId !== this.selectedStepId) await this.selectStep(stepId);
    if ((await api.capture.state())?.active) {
      this.onToast(t('Stop the recording session before retaking a screenshot.'), { error: true });
      return;
    }
    await this.replaceStepScreenshot(stepId, (step) => api.step.retake({ guideId: this.guideId, stepId: step.stepId, mode, delayMs }), 'retaken');
  }

  /**
   * Shared by Choose image… and Retake screenshot: `pick(step)` swaps the
   * image in the main process; this records the old images for undo.
   */
  async replaceStepScreenshot(stepId, pick, verb = 'replaced') {
    if (stepId && stepId !== this.selectedStepId) await this.selectStep(stepId);
    const step = this.currentStep;
    if (!step) return;
    if (this.pendingSave) await this.flushStep();
    const before = await this.snapshotCurrentStep(true);
    let result;
    try {
      result = await pick(step);
    } catch (err) {
      this.onToast(err.message, { error: true });
      return;
    }
    if (!result || !result.ok) {
      if (result && result.reason) this.onToast(result.reason, { error: true });
      return;
    }
    if (before) this.pushCanvasHistory(before);
    await this.reload(step.stepId);
    const kept = (result.step.annotations || []).length;
    const done = verb === 'retaken' ? t('Screenshot retaken.') : t('Screenshot replaced.');
    const blurs = result.removedBlurs ? ` ${t('Private details will be checked again before publishing.')}` : '';
    this.onToast(`${done}${kept ? ` ${t('Its annotations were kept, so check they still line up.')}` : ''}${blurs} ${t('Press Ctrl+Z to undo.')}`);
  }

  async deleteSelectedStep() {
    const step = this.currentStep;
    if (!step) return;
    const ok = await confirmDialog(`Delete “${step.title || 'Untitled step'}”?`, { danger: true, okLabel: t('Delete') });
    if (!ok) return;
    if (this.pendingSave) await this.flushStep();
    const order = this.steps.map((s) => s.stepId);
    const entry = await this.snapshotStepForDeletion(step);
    await api.step.delete({ guideId: this.guideId, stepId: step.stepId });
    this.pushCanvasHistory({ type: 'delete-step', steps: [entry], order });
    const next = this.steps[this.steps.findIndex((s) => s.stepId === step.stepId) + 1]
      || this.steps[this.steps.findIndex((s) => s.stepId === step.stepId) - 1]
      || null;
    await this.reload(next && next.stepId);
    this.onToast(t('Step deleted. Press Ctrl+Z to undo.'));
  }

  /** Move the current step, with its substeps, past the neighbouring step and its substeps. */
  async moveSelectedStep(delta) {
    const step = this.currentStep;
    if (!step) return;
    const moved = outline.moveSubtreeBy(this.steps.map((s) => s.stepId), outline.parentMap(this.steps), step.stepId, delta);
    if (moved) await this.applyStepMove(step.stepId, moved);
  }

  /**
   * Save a move planned by core/step-outline.js ({ order, parentOf }) as one
   * undo step. Returns false if nothing changed or the move was refused.
   */
  async applyStepMove(stepId, moved) {
    if (!(await this.settlePendingSave())) return false;
    const before = this.outlineRecord();
    // Send only the parents the move changes, so it can't put back a parent
    // that changed elsewhere since the move was planned.
    const parents = {};
    for (const [id, parentId] of moved.parentOf) {
      if ((parentId || null) !== before.parents[id]) parents[id] = parentId || null;
    }
    const unchanged = moved.order.every((id, i) => id === before.order[i]) && !Object.keys(parents).length;
    if (unchanged) return false;
    try {
      await api.step.reorder({ guideId: this.guideId, order: moved.order, parents });
    } catch (err) {
      this.onToast(t('Could not move the step: {error}', { error: err.message || err }), { error: true });
      return false;
    }
    this.pushCanvasHistory(before);
    await this.reload(stepId);
    return true;
  }

  /** "Move to…": pick a place and a level for a step and its substeps in a dialog. */
  async moveStepTo(stepId) {
    const step = this.stepMap.get(stepId);
    if (!step) return;
    const order = this.steps.map((s) => s.stepId);
    const parentOf = outline.parentMap(this.steps);
    const numbers = stepNumberMap(this.steps);
    const nameOf = (id) => `${numbers.get(id)}  ${this.stepMap.get(id).title || t('Untitled step')}`;
    const index = order.indexOf(stepId);
    const blockEnd = index + outline.subtreeOf(order, parentOf, stepId).length;
    const positions = [];
    for (let gap = 0; gap <= order.length; gap++) {
      if (gap > index && gap <= blockEnd) continue; // inside the step's own substeps, or the same spot again
      // Each distinct level the gap allows, keyed by the parent the step would get.
      const levels = new Map();
      const deepest = gap > 0 ? outline.depthOf(parentOf, order[gap - 1]) + 1 : 0;
      for (let depth = 0; depth <= deepest; depth++) {
        const result = outline.moveSubtree(order, parentOf, stepId, gap, depth);
        const parentId = result && result.parentOf.get(stepId);
        if (!result || levels.has(parentId || '')) continue;
        levels.set(parentId || '', {
          value: String(depth),
          depth: parentId ? outline.depthOf(result.parentOf, parentId) + 1 : 0,
          label: parentId ? `Substep of ${nameOf(parentId)}` : t('Top level'),
        });
      }
      positions.push({
        value: String(gap),
        label: gap === 0 ? t('At the top') : `After ${nameOf(order[gap - 1])}`,
        current: gap === index,
        levels: [...levels.values()].sort((a, b) => a.depth - b.depth),
      });
    }
    const choice = await dialogs.showMoveStepDialog({
      title: t('Move “{title}”', { title: step.title || t('Untitled step') }),
      hint: this.getStepDescendantIds(stepId).length ? t('Its substeps move with it.') : '',
      positions,
      currentDepth: outline.depthOf(parentOf, stepId),
    });
    if (!choice) return;
    // The guide may have changed while the dialog was open (an agent, a
    // sync), so plan the move again on the outline as it is now, keeping the
    // chosen place as "after this step" rather than as a position.
    const anchor = Number(choice.gap) > 0 ? order[Number(choice.gap) - 1] : null;
    const nowOrder = this.steps.map((s) => s.stepId);
    const nowGap = anchor ? nowOrder.indexOf(anchor) + 1 : 0;
    const moved = this.stepMap.has(stepId) && (!anchor || nowGap > 0)
      ? outline.moveSubtree(nowOrder, outline.parentMap(this.steps), stepId, nowGap, Number(choice.depth))
      : null;
    if (!moved) {
      this.onToast(t('The guide changed while you were choosing, so the step was not moved. Try Move to… again.'), { error: true });
      return;
    }
    if (await this.applyStepMove(stepId, moved)) this.onToast(t('Step moved. Press Ctrl+Z to undo.'));
  }

  /** Where a dragged step would land for a pointer at (x, y): { gap, depth, moved } with moved null if refused. */
  stepDropTarget(x, y) {
    const drag = this.stepDrag;
    if (!drag) return null;
    const rows = [...this.dom.stepsList.querySelectorAll('.step-item')];
    let gap = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { gap = i; break; }
    }
    // Dragging sideways changes the level, one indent per 18px, relative to where the drag began.
    const hint = Math.max(0, drag.depth + Math.round((x - drag.startX) / 18));
    const parentOf = outline.parentMap(this.steps);
    const moved = outline.moveSubtree(this.steps.map((s) => s.stepId), parentOf, drag.stepId, gap, hint);
    return { gap, rows, moved, depth: moved ? outline.depthOf(moved.parentOf, drag.stepId) : hint };
  }

  onStepDragStart(e, stepId) {
    if (this.stepSelectMode) { e.preventDefault(); return; }
    const parentOf = outline.parentMap(this.steps);
    this.stepDrag = { stepId, startX: e.clientX, depth: outline.depthOf(parentOf, stepId) };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', stepId);
    }
    // Dim the step and its substeps, after the browser has taken its drag image.
    const ids = new Set(outline.subtreeOf(this.steps.map((s) => s.stepId), parentOf, stepId));
    setTimeout(() => {
      for (const row of this.dom.stepsList.children) {
        if (ids.has(row.dataset.stepId)) row.classList.add('dragging');
      }
    }, 0);
  }

  onStepDragOver(e) {
    if (!this.stepDrag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const list = this.dom.stepsList;
    const rect = list.getBoundingClientRect();
    const edge = 40;
    if (e.clientY < rect.top + edge) list.scrollTop -= Math.ceil((rect.top + edge - e.clientY) / 4);
    else if (e.clientY > rect.bottom - edge) list.scrollTop += Math.ceil((e.clientY - (rect.bottom - edge)) / 4);
    this.showStepDropLine(this.stepDropTarget(e.clientX, e.clientY));
  }

  async onStepDrop(e) {
    if (!this.stepDrag) return;
    e.preventDefault();
    const { stepId } = this.stepDrag;
    const target = this.stepDropTarget(e.clientX, e.clientY);
    this.endStepDrag();
    if (!target) return;
    if (!target.moved) {
      this.onToast(t('A step can’t be dropped inside its own substeps.'), { error: true });
      return;
    }
    await this.applyStepMove(stepId, target.moved);
  }

  endStepDrag() {
    this.stepDrag = null;
    this.hideStepDropLine();
    for (const row of this.dom.stepsList.children) row.classList.remove('dragging');
  }

  /** Draw the drop line at the gap, indented to the level the step would end up at. */
  showStepDropLine(target) {
    if (!target) { this.hideStepDropLine(); return; }
    const { gap, rows, moved, depth } = target;
    if (!this.dom.stepDropLine) this.dom.stepDropLine = el('div.step-drop-line');
    const line = this.dom.stepDropLine;
    if (line.parentNode !== this.dom.stepsList) this.dom.stepsList.append(line);
    const last = rows[rows.length - 1];
    line.style.top = `${gap < rows.length ? rows[gap].offsetTop - 2 : last.offsetTop + last.offsetHeight + 2}px`;
    line.style.left = `${10 + depth * 18}px`;
    line.classList.toggle('refused', !moved);
  }

  hideStepDropLine() {
    if (this.dom.stepDropLine) this.dom.stepDropLine.remove();
  }

  async importImageSteps() {
    const result = await api.step.importImage({ guideId: this.guideId });
    if (!result || !result.ok) return;
    const last = result.steps && result.steps[result.steps.length - 1];
    await this.reload(last ? last.stepId : this.selectedStepId);
    this.onToast(t('Images imported.'));
  }

  async captureStep(mode, delayMs = null) {
    const result = mode === 'region'
      ? await api.capture.region({ guideId: this.guideId })
      : await api.capture.shoot({ guideId: this.guideId, mode, delayMs });
    if (result && result.ok) {
      await this.reload(result.step.stepId);
      this.onToast(t('Captured.'));
    } else if (result && result.reason) {
      this.onToast(result.reason, { error: true });
    }
  }

  /** Capture menu anchored at a toolbar button. */
  async openCaptureMenu(event) {
    const rect = event.target.getBoundingClientRect();
    const session = (await api.capture.state())?.active;
    const items = [
      { label: t('Capture full screen'), action: () => this.captureStep('fullscreen') },
      { label: t('Capture window'), action: () => this.captureStep('window') },
      { label: t('Capture region…'), action: () => this.captureStep('region') },
      'sep',
      { label: t('Paste image as step'), action: () => this.pasteClipboardStep() },
      { label: t('Import images…'), action: () => this.importImageSteps() },
    ];
    if (!session) {
      items.push('sep', { label: t('Start capture session (hotkey)'), action: () => this.startCaptureSession() });
    }
    contextMenu(rect.left, rect.bottom + 4, items);
  }

  async pasteClipboardStep() {
    const result = await api.step.fromClipboard({ guideId: this.guideId });
    if (result && result.ok) {
      await this.reload(result.step.stepId);
      this.onToast(t('Image pasted as a new step.'));
    } else {
      this.onToast(result?.reason || t('Clipboard has no image.'), { error: true });
    }
  }

  async shareAsFile() {
    const result = await api.archive.export({ guideId: this.guideId });
    if (result && result.ok) this.onToast(t('Shared to {path}', { path: result.path }));
  }

  async openBackupsDialog() {
    if (!this.guideId) return;
    const snapshots = await api.snapshots.list({ guideId: this.guideId });
    const restore = async (name) => {
      const ok = await confirmDialog(
        t('Restore “{name}”? Current state is snapshotted first, so this is undoable.', { name }),
        { okLabel: t('Restore') },
      );
      if (!ok) return false;
      await api.snapshots.restore({ guideId: this.guideId, name });
      await this.reload();
      this.onToast(t('Snapshot restored.'));
      return true;
    };
    await dialogs.showBackupsDialog({
      snapshots,
      onCreate: async () => {
        await api.snapshots.create({ guideId: this.guideId, label: 'manual' });
        this.onToast(t('Snapshot created.'));
        return api.snapshots.list({ guideId: this.guideId });
      },
      onRestore: restore,
      onCompare: (name) => this.compareSnapshot(name, restore),
    });
  }

  /**
   * Show what changed since snapshot `name`. Pending edits are saved first,
   * so "now" is exactly the guide on disk. Resolves true when the snapshot
   * was restored from the Compare view.
   */
  async compareSnapshot(name, restore) {
    if (this.pendingSave) await this.flushStep();
    if (this.pendingGuideSave) await this.flushGuide();
    let diff;
    try {
      diff = await api.snapshots.compare({ guideId: this.guideId, name });
    } catch (err) {
      this.onToast(t('Could not compare with this snapshot: {error}', { error: err.message || err }), { error: true });
      return false;
    }
    return window.StepForgeCompare.showSnapshotCompare({
      label: dialogs.snapshotLabel(name),
      diff,
      loadImage: (side, file) => api.snapshots.compareImage({ guideId: this.guideId, name: side === 'before' ? name : null, file }),
      onRestore: () => restore(name),
      storageKey: `stepforge.compare.viewed.${this.guideId}.${name}`,
    });
  }

  async openGuidePlaceholders() {
    if (!this.guide) return;
    await dialogs.showPlaceholdersDialog({
      title: t('Guide placeholders'),
      hint: t('Use [[Name]] in titles, descriptions, and blocks. Guide values override global ones.'),
      values: this.guide.placeholders || {},
      onSave: async (values) => {
        this.guide.placeholders = values;
        await api.guide.save({ guide: this.guide });
        this.onToast(t('Placeholders saved.'));
      },
    });
  }

  async openGuideInfo() {
    if (!this.guide) return;
    await dialogs.showGuideInfoDialog({
      values: {
        ...this.guide.metadata,
        description: htmlToPlainText(this.guide.descriptionHtml || ''),
        sharingEnabled: this.guide.cloud?.sharingEnabled !== false,
      },
      reviewDefaultDays: this.settings?.library?.reviewAfterDays,
      onSave: async ({ description, sharingEnabled, ...metadata }) => {
        this.guide.metadata = metadata;
        this.guide.descriptionHtml = textToHtml(description);
        this.guide.cloud = { ...(this.guide.cloud || {}), sharingEnabled };
        await api.guide.save({ guide: this.guide });
        this.onToast(t('Guide information saved.'));
      },
      onCloudSnapshots: async () => {
        try {
          const snapshots = await api.cloud.history({ guideId: this.guideId });
          await dialogs.showCloudSnapshotsDialog({
            snapshots,
            onRestore: async (snapshot) => {
              const ok = await confirmDialog(t('Restore this cloud snapshot? Your current local guide is kept as a cloud snapshot first.'), { okLabel: t('Restore') });
              if (!ok) return;
              await api.cloud.restore({ guideId: this.guideId, versionId: snapshot.id });
              await this.reload();
              this.onToast(t('Cloud snapshot restored.'));
            },
          });
        } catch (err) { this.onToast(err.message); }
      },
      onDeleteCloudSnapshots: async () => {
        const ok = await confirmDialog(t('Remove every cloud snapshot for this guide? This also turns off cloud sync for the guide. The local guide is kept.'), { danger: true, okLabel: t('Remove cloud copies') });
        if (!ok) return;
        try {
          await api.cloud.deleteGuideSnapshots({ guideId: this.guideId });
          this.guide.cloud = { ...(this.guide.cloud || {}), sharingEnabled: false };
          this.onToast(t('Cloud copies removed.'));
        } catch (err) { this.onToast(err.message); }
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
    const before = [];
    const after = [];
    const restyle = (step) => {
      let touched = false;
      for (const ann of step.annotations || []) {
        if (ann.type === source.type && ann.id !== source.id) {
          if (!touched) before.push(clone(step));
          ann.style = { ...ann.style, ...patch };
          touched = true;
        }
      }
      return touched;
    };
    if (scope === 'step') {
      const step = this.currentStep;
      restyle(step);
      step.annotations = clone(step.annotations);
      const saved = await this.flushStep(step);
      if (saved) after.push(saved);
      const undo = this.pushStyleHistory(before, after);
      this.onToast(`${t('Style applied to all “{type}” annotations in this step.', { type: ANNOTATION_TYPE_LABELS[source.type] || source.type })}${undo}`);
    } else {
      for (const step of this.steps) {
        const touched = restyle(step);
        if (touched || step.stepId === this.currentStep?.stepId) {
          const saved = await api.step.save({ guideId: this.guideId, step });
          if (touched) after.push(saved);
        }
      }
      const undo = this.pushStyleHistory(before, after);
      await this.reload(this.selectedStepId);
      this.onToast(`${t('Style applied to all “{type}” annotations in the guide.', { type: ANNOTATION_TYPE_LABELS[source.type] || source.type })}${undo}`);
    }
  }

  /** One undo step for a style applied to several steps. Returns the toast hint, or '' if nothing changed. */
  pushStyleHistory(before, after) {
    if (!before.length) return '';
    this.pushCanvasHistory(this.multiStepRecord(before, after));
    return ` ${t('Press Ctrl+Z to undo.')}`;
  }

  async startCaptureSession() {
    await api.capture.session({ action: 'start', guideId: this.guideId });
    this.emitMeta();
  }

  async pauseCaptureSession() {
    await api.capture.session({ action: 'pause', guideId: this.guideId });
    this.onToast(t('Capture paused.'));
    this.emitMeta();
  }

  async resumeCaptureSession() {
    await api.capture.session({ action: 'resume', guideId: this.guideId });
    this.onToast(t('Capture resumed.'));
    this.emitMeta();
  }

  async openSettings(section) {
    const settings = await api.settings.all();
    const placeholders = await api.settings.globalPlaceholders();
    let newLanguage = null;
    await dialogs.showSettingsDialog({
      api,
      settings,
      placeholders,
      section,
      // Update now closes StepForge; save this guide first.
      flushEdits: async () => {
        try {
          if (this.pendingSave || this.pendingGuideSave) await this.saveAll();
        } catch {
          return false;
        }
        return !this.pendingSave && !this.pendingGuideSave;
      },
      onSave: async (next) => {
        await api.settings.set({ keyPath: 'appearance', value: next.appearance });
        await api.settings.set({ keyPath: 'spellcheck', value: next.spellcheck });
        await api.settings.set({ keyPath: 'capture', value: next.capture });
        await api.settings.set({ keyPath: 'editor', value: next.editor });
        await api.settings.set({ keyPath: 'ai', value: next.ai });
        await api.settings.set({ keyPath: 'redaction', value: next.redaction });
        await api.settings.set({ keyPath: 'exports', value: next.exports });
        await api.settings.set({ keyPath: 'branding', value: next.branding });
        await api.settings.set({ keyPath: 'backups', value: next.backups });
        await api.settings.setGlobalPlaceholders(next.placeholders || {});
        if (next.language !== settings.language) newLanguage = next.language;
      },
    });
    // The quick-actions and AI menus open Settings here too. A language
    // reload must wait for the guide to be saved, just as in the app toolbar.
    if (newLanguage) {
      try {
        if (this.pendingSave || this.pendingGuideSave) await this.saveAll();
      } catch {
        return;
      }
      if (this.pendingSave || this.pendingGuideSave) return;
      const result = await api.app.setLanguage({ language: newLanguage });
      if (result.reloaded) return;
    }
    this.setSettings(await api.settings.all());
  }

  async openExportDialog() {
    const formats = (await api.export.formats()).map((format) => (
      typeof format === 'string'
        ? { id: format, label: format.replace(/-/g, ' ') }
        : format
    ));
    const templatesByFormat = {};
    for (const format of formats) {
      templatesByFormat[format.id] = await api.templates.list({ format: format.id });
    }
    const settings = await api.settings.all();
    const brandProfiles = await api.branding.list().catch(() => []);
    // HTML exports can also be published to GitHub Pages (Settings → Accounts).
    const github = await api.github.status().catch(() => null);
    // Check what's on screen, including edits still waiting to be saved.
    if (this.pendingSave) await this.flushStep();
    if (this.pendingGuideSave) await this.flushGuide();
    const quality =await api.guide.quality({ guideId: this.guideId }).catch(() => []);
    let publishRequest = null;
    let publishInstead = null;
    let finding = null;
    await dialogs.showExportDialog({
      formats,
      templatesByFormat,
      quality,
      onShowFinding: (picked) => { finding = picked; },
      publishTargets: this.onPublish ? { confluence: 'Confluence', wikijs: 'Wiki.js' } : {},
      onPublishInstead: (format) => { publishInstead = format; },
      webPublish: github?.available ? {
        ready: Boolean(github.connected && github.repo && !github.needsSignIn),
        formats: ['html-simple', 'html-rich'],
        expiryDays: github.expiryDays,
        defaultExpiryDays: github.defaultExpiryDays,
      } : null,
      branding: { profiles: brandProfiles, activeId: settings.branding?.activeProfileId || '' },
      defaultFormat: 'pdf',
      defaultOutDir: settings.exports?.lastOutputDirs?.pdf || '',
      onChooseDir: async (format) => api.export.chooseDir({ format }),
      onChooseImage: async () => api.export.chooseImage(),
      onLoadDefaults: async (format, brandProfileId) => api.export.defaults({ format, brandProfileId }),
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
              if (res?.ok) this.onToast(t('Imported template for {format}.', { format: res.format }));
              return api.templates.list({ format });
            },
            onExport: async (name) => {
              const res = await api.templates.export({ format, name });
              if (res?.ok) this.onToast(t('Template shared as .sfglt.'));
            },
          });
        }
        return api.templates.list({ format });
      },
      onPreview: async ({ format, options, brandProfileId }) => {
        const preview = await api.export.preview({ guideId: this.guideId, format, options, brandProfileId });
        if (preview && preview.file) {
          await api.shell.openProduced({ target: preview.file }); // open in default viewer
          this.onToast(t('Preview opened (first steps only).'));
        }
        return true;
      },
      onExport: async ({ format, options, outDir, publish, brandProfileId }) => {
        const result = await api.export.run({ guideId: this.guideId, format, options, outDir, brandProfileId });
        if (result && result.ok === false) return false;
        if (result && result.file) this.onToast(`Exported ${format}.`);
        // Published after the Export dialog closes, in a dialog that shows
        // progress. The local export is done either way.
        if (publish) publishRequest = { days: publish.days, format, options, brandProfileId };
        return true;
      },
    });
    if (publishInstead) {
      await this.onPublish(publishInstead);
      return;
    }
    if (publishRequest) {
      await showPublishProgressDialog({ api, guideId: this.guideId, guideTitle: this.guide?.title || t('This guide'), request: publishRequest });
      // Publishing blurs private details in screenshots that weren't checked yet.
      await this.reload();
    }
    if (finding) await this.showQualityFinding(finding);
  }

  /**
   * Jump to a quality-check finding (app/renderer/quality.js): its step,
   * with the title field focused when the title is what needs fixing, or
   * the guide's placeholders for a finding in the guide itself.
   */
  async showQualityFinding(finding) {
    if (!finding.stepId) {
      await this.openGuidePlaceholders();
      return;
    }
    if (!this.stepMap.has(finding.stepId)) return;
    await this.selectStep(finding.stepId);
    if (finding.kind === 'title') {
      this.dom.titleInput.focus();
      this.dom.titleInput.select();
    }
  }

  async openLinkedGuide() {
    if (!this.guide || !this.guide.linkedSource) {
      await dialogs.showInfoDialog(t('Linked Guide'), 'This guide is stored locally and is not linked to a shared archive.');
      return;
    }
    const library = await api.library.list();
    const guideMeta = library.guides.find((g) => g.guideId === this.guideId) || this.guide;
    const locked = Boolean(guideMeta.locked);
    await dialogs.showLinkedGuideDialog({
      guide: guideMeta,
      lock: locked ? { acquired: false } : { acquired: true },
      onSave: async () => {
        const result = await this.runLinkedSave({ force: false });
        if (result.saved) this.toastLinkedSave(result, t('Linked archive saved.'));
        else this.onToast(t('Could not save linked archive.'), { error: true });
      },
      onForceSave: async () => {
        const result = await this.runLinkedSave({ force: true });
        if (result.saved) this.toastLinkedSave(result, t('Linked archive force-saved.'));
        else this.onToast(t('Could not save linked archive.'), { error: true });
      },
      onOpenArchive: async () => {
        await api.shell.revealLinkedArchive({ guideId: this.guideId });
      },
    });
  }

  async openQuickActions() {
    const commands = [
      { kind: 'cmd', label: t('New guide'), description: t('Create a blank guide'), action: () => this.onBack('new') },
      { kind: 'cmd', label: t('Export'), description: t('Export the current guide'), action: () => this.openExportDialog() },
      { kind: 'cmd', label: t('Settings'), description: t('Open application settings'), action: () => this.openSettings() },
      { kind: 'cmd', label: t('Linked guide'), description: t('Show linked archive details'), action: () => this.openLinkedGuide() },
      { kind: 'cmd', label: t('Start capture session'), description: t('Enable hotkey capture for this guide'), action: () => this.startCaptureSession() },
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

  /** Ctrl+H: find and replace across every step; see core/find-replace.js. */
  async openFindReplace() {
    if (!this.guideId || !this.steps.length || this.findReplaceOpen) return;
    this.findReplaceOpen = true; // Ctrl+H again while it is open would stack a second dialog
    try {
      // Search what is saved; if the current step can't be saved, don't open.
      if (!(await this.settlePendingSave())) return;
      await dialogs.showFindReplace({
        stepNumbers: Object.fromEntries(stepNumberMap(this.steps)),
        find: (options) => api.findReplace.find({ guideId: this.guideId, ...options }),
        replace: (matches, replacement) => this.replaceMatches(matches, replacement),
      });
    } finally {
      this.findReplaceOpen = false;
    }
  }

  /**
   * Replace the chosen find-and-replace matches. The edited steps are saved
   * one by one and pushed as one 'multi-step' undo record, so a single Ctrl+Z
   * puts every step back. Returns the number of matches replaced.
   */
  async replaceMatches(matches, replacement) {
    // Stop if the current step's edits can't be saved: the reload at the end
    // would otherwise replace them with what is on disk.
    if (!(await this.settlePendingSave())) throw new Error('This step’s changes could not be saved, so nothing was replaced.');
    const result = await api.findReplace.apply({ guideId: this.guideId, matches, replacement });
    const saved = [];
    try {
      // Each saved step goes into the live editor state at once, so an
      // autosave during the batch saves the replacement, not the old text.
      for (const step of result.steps) saved.push(this.commitBatchSave(await api.step.save({ guideId: this.guideId, step })));
    } catch (err) {
      this.onToast(t('Could not save every step: {error}', { error: err.message || err }), { error: true });
    }
    if (saved.length) this.pushCanvasHistory(this.multiStepRecord(result.before.slice(0, saved.length), saved));
    await this.reload(this.selectedStepId);
    const skipped = result.refused.length + result.stale.length;
    const skippedText = skipped ? ` ${t('{count} skipped.', { count: skipped })}` : '';
    this.onToast(saved.length
      ? `${tn(saved.length, 'Replaced {applied} in {count} step.', 'Replaced {applied} in {count} steps.', { applied: result.applied })}${skippedText} ${t('Press Ctrl+Z to undo.')}`
      : `${t('Nothing was replaced.')}${skippedText}`);
    return saved.length ? result.applied : 0;
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
    return this.stepImageToBase64(step, 'working');
  }

  // The stored bytes, unchanged, so putting an image back restores the same file.
  async stepImageToBase64(step, which = 'working') {
    if (!step || !step.image) return null;
    return api.step.imageData({ guideId: this.guideId, stepId: step.stepId, which });
  }

  /** Snapshot a step (and its images, if any) before deletion so it can be undone. */
  async snapshotStepForDeletion(step) {
    const position = this.steps.findIndex((s) => s.stepId === step.stepId);
    const childIds = this.steps.filter((s) => s.parentStepId === step.stepId).map((s) => s.stepId);
    let images = null;
    if (step.image) {
      const [original, working] = await Promise.all([
        this.stepImageToBase64(step, 'original'),
        this.stepImageToBase64(step, 'working'),
      ]);
      images = { original, working };
    }
    return { step: clone(step), position, childIds, images };
  }

  /** Undo a 'delete-step' history record: recreate the deleted steps and their order. */
  async restoreDeletedSteps(record) {
    for (const entry of record.steps) {
      await api.step.restore({
        guideId: this.guideId,
        step: entry.step,
        originalBase64: entry.images?.original?.base64 || null,
        workingBase64: entry.images?.working?.base64 || null,
        position: entry.position,
      });
    }
    await api.step.reorder({ guideId: this.guideId, order: record.order });
    this.saveStepDebounced.cancel();
    this.pendingSave = false;
    await this.reload(record.steps[0].step.stepId);
    for (const entry of record.steps) {
      for (const childId of entry.childIds) {
        const child = this.stepMap.get(childId);
        if (child && child.parentStepId !== entry.step.stepId) {
          child.parentStepId = entry.step.stepId;
          await api.step.save({ guideId: this.guideId, step: child });
        }
      }
    }
    if (record.steps.some((entry) => entry.childIds.length)) await this.reload(record.steps[0].step.stepId);
    this.onToast(`Restored ${record.steps.length} step${record.steps.length === 1 ? '' : 's'}.`);
  }

  /** Redo of an undone 'delete-step' record: delete those steps again. */
  async deleteStepsAgain(record) {
    for (const entry of record.steps) {
      await api.step.delete({ guideId: this.guideId, stepId: entry.step.stepId });
    }
    const deletedIds = new Set(record.steps.map((entry) => entry.step.stepId));
    const remaining = record.order.filter((id) => !deletedIds.has(id));
    this.saveStepDebounced.cancel();
    this.pendingSave = false;
    await this.reload(remaining[0] || null);
    this.onToast(`Deleted ${record.steps.length} step${record.steps.length === 1 ? '' : 's'}.`);
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

  /** Ctrl+V with a copied annotation: add a copy to the current step as one undo step. False if there is nothing to paste. */
  pasteAnnotation() {
    const step = this.currentStep;
    if (!this.annotationClipboard || !step?.image) return false;
    this.pushCanvasHistory();
    const copy = clone(this.annotationClipboard);
    copy.id = `ann-${Date.now().toString(36)}`;
    // Nudge it only when pasting back into the step it came from, so it
    // doesn't land exactly on top of the original. Elsewhere it keeps its spot.
    if (step.stepId === this.annotationClipboardStepId) {
      copy.x = Math.min(0.92, copy.x + 0.03);
      copy.y = Math.min(0.92, copy.y + 0.03);
    }
    step.annotations = step.annotations || [];
    step.annotations.push(copy);
    this.canvas.setAnnotations(step.annotations);
    this.canvas.select(copy.id);
    this.pendingSave = true;
    this.saveStepDebounced();
    return true;
  }

  /**
   * Paste the copied annotation onto every selected step at the same
   * normalized position, as one 'multi-step' undo record. Steps whose image
   * has a different aspect ratio than the source (a crop, another window) are
   * skipped, since the same position would land on something else, and so are
   * steps that already have this very annotation (same place, text and style:
   * the source step, or a second paste).
   */
  async pasteAnnotationToSelectedSteps() {
    const source = this.annotationClipboard;
    if (!source) return;
    const ids = this.steps.map((s) => s.stepId).filter((id) => this.selectedSteps.has(id));
    if (!ids.length) return;
    // Stop if the current step's edits can't be saved: reloading at the end
    // would otherwise replace them with what is on disk.
    if (!(await this.settlePendingSave())) return;
    const sourceAspect = this.annotationClipboardAspect || 0;
    // The same annotation is the same type, place, text and style; only its id may differ.
    const sourceKey = annotationContentKey(source);
    const alreadyThere = (step) => (step.annotations || []).some((ann) => annotationContentKey(ann) === sourceKey);
    const numbers = stepNumberMap(this.steps);
    const skipped = [];
    const before = [];
    const after = [];
    const stamp = Date.now().toString(36);
    let failed = null;
    for (const stepId of ids) {
      const step = this.stepMap.get(stepId);
      if (!step) continue;
      const aspect = alreadyThere(step) ? 0 : await this.stepImageAspect(step);
      if (!aspect || !sourceAspect || Math.abs(aspect / sourceAspect - 1) > 0.01) {
        skipped.push(numbers.get(stepId) || stepId);
        continue;
      }
      const edited = clone(step);
      const copy = clone(source);
      copy.id = `ann-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
      edited.annotations = [...(edited.annotations || []), copy];
      const original = clone(step);
      try {
        const saved = await api.step.save({ guideId: this.guideId, step: edited });
        before.push(original);
        // Into the live step at once, so an autosave during the rest of the
        // batch saves the paste rather than the copy from before it.
        after.push(this.commitBatchSave(saved));
      } catch (err) {
        failed = err;
        break;
      }
    }
    if (before.length) this.pushCanvasHistory(this.multiStepRecord(before, after));
    await this.reload(this.selectedStepId);
    let text = before.length
      ? `${tn(before.length, 'Annotation pasted onto {count} step.', 'Annotation pasted onto {count} steps.')} ${t('Press Ctrl+Z to undo.')}`
      : t('No steps changed.');
    if (skipped.length) {
      text += ` ${tn(skipped.length, 'Skipped {count} step (already there, no image, or a different image shape): {steps}.',
        'Skipped {count} steps (already there, no image, or a different image shape): {steps}.', { steps: skipped.join(', ') })}`;
    }
    if (failed) text += ` ${t('Stopped early: {error}', { error: failed.message || failed })}`;
    this.onToast(text, failed ? { error: true } : undefined);
  }

  /**
   * Width / height of a step's working image, or 0 without one. Steps added
   * without a size (some imports, older guides) store { 0, 0 }; for those the
   * image itself is measured, so they are not skipped for no visible reason.
   */
  async stepImageAspect(step) {
    if (!step || !step.image) return 0;
    const size = step.image.size;
    if (size && size.width > 0 && size.height > 0) return size.width / size.height;
    const file = await api.step.imagePath({ guideId: this.guideId, stepId: step.stepId, which: 'working' });
    const img = file ? await loadImage(file) : null;
    const width = img ? img.naturalWidth || img.width : 0;
    const height = img ? img.naturalHeight || img.height : 0;
    return width > 0 && height > 0 ? width / height : 0;
  }

  onCanvasSelect(ann) {
    this.selectedAnnotationId = ann ? ann.id : null;
    this.renderAnnotationPanel();
    this.emitMeta();
  }

  async onCanvasCrop(rect) {
    const step = this.currentStep;
    if (!step || !step.image) return;
    const ok = await confirmDialog(t('Crop the working image to the selected area?'));
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
    this.onToast(t('Image cropped.'));
  }

  async editAnnotationText(ann) {
    const step = this.currentStep;
    if (!step || !ann) return;
    const originalText = ann.text ?? '';
    const applyText = (nextText, { persist = true } = {}) => {
      const selected = this.canvas.selected();
      if (!selected) return;
      selected.text = nextText;
      step.annotations = clone(this.canvas.annotations || []);
      this.pendingSave = true;
      this.canvas.setAnnotations(step.annotations || []);
      this.renderAnnotationPanel();
      this.emitMeta();
      if (persist) this.saveStepDebounced();
    };
    const value = await dialogs.promptText({
      title: ann.type === 'tooltip' ? t('Edit tooltip') : t('Edit text'),
      label: t('Text'),
      value: originalText,
      multiline: true,
      onInput: applyText,
    });
    this.saveStepDebounced.cancel();
    if (value == null) {
      const current = this.canvas.selected();
      if ((current?.text ?? '') !== originalText) {
        applyText(originalText, { persist: false });
      }
      await this.flushStep(step);
      return;
    }
    const current = this.canvas.selected();
    if ((current?.text ?? '') !== value) {
      applyText(value, { persist: false });
    }
    await this.flushStep(step);
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
      case 'formatBlock': {
        const want = block || 'blockquote';
        const current = document.queryCommandValue('formatBlock').toLowerCase();
        document.execCommand('formatBlock', false, current === want ? 'p' : want);
        break;
      }
      case 'createLink': {
        const selectedText = window.getSelection().toString();
        const text = selectedText || t('Text');
        document.execCommand('insertText', false, `[${text}](Link)`);
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
    this.updateToolbarState();
  }

  onDocumentKeyDown(e) {
    if (!this.active || !this.guide) return;
    const zoomShortcut = zoomShortcutFromEvent(e);
    if (zoomShortcut) {
      e.preventDefault();
      this.applyZoomShortcut(zoomShortcut);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/' && !e.shiftKey) {
      e.preventDefault();
      this.openQuickActions();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.openFindReplace();
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
      // Copy / paste the selected annotation.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && this.selectedAnnotationId) {
        e.preventDefault();
        this.annotationClipboard = clone(this.canvas.selected());
        this.annotationClipboardStepId = this.currentStep?.stepId || null;
        // The canvas has the image loaded, so its size is known even when the step stored { 0, 0 }.
        const size = this.currentStep?.image?.size;
        const { imgW, imgH } = this.canvas;
        this.annotationClipboardAspect = size && size.width > 0 && size.height > 0 ? size.width / size.height
          : imgW > 0 && imgH > 0 ? imgW / imgH : 0;
        this.renderStepBulkBar();
        this.onToast(t('Annotation copied.'));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (!this.pasteAnnotation()) this.pasteClipboardStep(); // OS clipboard image -> new step
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedAnnotationId) {
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
