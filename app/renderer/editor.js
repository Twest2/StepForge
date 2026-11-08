'use strict';

(() => {

const api = window.stepforge;
const dialogs = window.StepForgeDialogs || {};
const shortcuts = window.StepForgeShortcuts || {};
const outline = window.StepForgeOutline || {};
const { stepNumberMap } = outline;
const focused = window.StepForgeFocusedView || {};

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
  pen: ['stroke', 'strokeWidth'],
  arrow: ['stroke', 'strokeWidth'],
  curvedArrow: ['stroke', 'strokeWidth'],
  text: ['text', 'stroke', 'fontSize'],
  tooltip: ['text', 'fill', 'stroke', 'strokeWidth', 'fontSize', 'textColor', 'tail'],
  number: ['value', 'stroke', 'textColor'],
  blur: ['radius'],
  highlight: [],
  magnify: ['zoom', 'stroke', 'strokeWidth'],
  cursor: [],
  spotlight: ['shape', 'darkness', 'cornerRadius'],
};
// Types whose fill can be Transparent. A tooltip's text sits on its fill, so it keeps one.
const CLEARABLE_FILL_TYPES = new Set(['rect', 'oval']);

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
  pen: t('Pen'),
  arrow: t('Arrow'),
  curvedArrow: t('Curved arrow'),
  text: t('Text'),
  tooltip: t('Tooltip'),
  number: t('Number'),
  blur: t('Blur'),
  highlight: t('Highlight'),
  magnify: t('Magnify'),
  cursor: t('Cursor'),
  spotlight: t('Spotlight'),
};

// Canvas toolbar icons: simple outlines drawn for StepForge (no icon font or
// remote asset). Each uses stroke="currentColor", so it follows the theme and
// the active state. The tool names are the button's title and aria-label.
// Single-key shortcuts for the annotation tools (no modifier keys). The
// toolbar shows each one in its button's tooltip, e.g. "Rectangle (R)".
const TOOL_KEYS = {
  s: 'select', r: 'rect', o: 'oval', l: 'line', p: 'pen', a: 'arrow', j: 'curvedArrow', t: 'text',
  g: 'tooltip', n: 'number', b: 'blur', h: 'highlight', m: 'magnify',
  u: 'cursor', k: 'spotlight', c: 'crop',
};
const TOOL_SHORTCUTS = Object.fromEntries(Object.entries(TOOL_KEYS).map(([key, tool]) => [tool, key.toUpperCase()]));

const TOOL_ICON_PATHS = {
  select: '<path d="M5 3v15l4-3.5 2.5 5.5 2.2-1-2.4-5.3H17z"/>',
  rect: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/>',
  oval: '<ellipse cx="12" cy="12" rx="8.5" ry="6"/>',
  line: '<path d="M4.5 19.5 19.5 4.5"/>',
  pen: '<path d="M15 5l4 4L9 19l-5.5 1.5L5 15z"/><path d="M13 7l4 4"/>',
  arrow: '<path d="M4.5 19.5 19 5M9 5h10v10"/>',
  curvedArrow: '<path d="M4 20C4 11 9 6 19 6M15 2l4 4-4 4"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  tooltip: '<path d="M4 5h16v11H10l-4 3.5V16H4z"/>',
  number: '<circle cx="12" cy="12" r="8.5"/><path d="M10.5 9.5 12 8.5v7"/>',
  blur: '<path d="M4 8q2-2 4 0t4 0 4 0 4 0M4 12q2-2 4 0t4 0 4 0 4 0M4 16q2-2 4 0t4 0 4 0 4 0"/>',
  highlight: '<path d="M14.5 4.5l5 5L11 18l-5-5zM4 20h7"/>',
  magnify: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  cursor: '<path d="M6 4v12l3.2-2.8 2.2 5 2-.9-2.2-4.9h4.6z"/><path d="M17.5 3.5l1 1.5M20.5 8h1.5M3 3l1.5 1.5"/>',
  spotlight: '<path d="M3.5 9.5 8.5 4.5l4.5 4.5-5 5z"/><path d="M15.5 11.5l3.5 2.5M12 15.5l2 3.5M16.5 7.5l4 .5"/><path d="M6.5 12.5 5 20M3 20h5"/>',
  crop: '<path d="M6 3v13h13M3 6h13v15"/>',
  'flow-select': '<path d="M5 3v15l4-3.5 2.5 5.5 2.2-1-2.4-5.3H17z"/>',
  'flow-process': '<rect x="3" y="6.5" width="18" height="11" rx="1.5"/>',
  'flow-decision': '<path d="M12 3 21 12 12 21 3 12z"/>',
  'flow-terminal': '<rect x="2.5" y="7" width="19" height="10" rx="5"/>',
  'flow-connect': '<rect x="2.5" y="3" width="8" height="6" rx="1"/><rect x="13.5" y="15" width="8" height="6" rx="1"/><path d="M6.5 9v9h5"/><path d="m9.5 15.5 2.5 2.5-2.5 2.5"/>',
  'flow-shapes': '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><circle cx="17.25" cy="6.75" r="3.75"/><path d="M6.75 13.5 10.5 21H3z"/><path d="M17.25 13.5 21 17.25 17.25 21 13.5 17.25z"/>',
  'flow-arrange': '<rect x="9" y="2.5" width="6" height="4.5" rx="1"/><rect x="2.5" y="17" width="6" height="4.5" rx="1"/><rect x="15.5" y="17" width="6" height="4.5" rx="1"/><path d="M12 7v5M5.5 17v-5h13v5"/>',
  'flow-delete': '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
};

// A picture icon (the Fill menu's Image… item).
const IMAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/></svg>';

// The flowchart tools (app/renderer/flowchart-editor.js), as [tool, label].
const FLOW_TOOLS = () => [
  ['select', t('Select')],
  ['process', t('Step box')],
  ['decision', t('Decision')],
  ['terminal', t('Start or end')],
  ['connect', t('Connect')],
];

// Every flowchart shape (core/flowchart.js) in groups, as [group name, [[shape, name], …]].
const FLOW_SHAPE_GROUPS = () => [
  [t('Basic'), [['process', t('Step box')], ['rectangle', t('Rectangle')], ['square', t('Square')], ['text', t('Text')],
    ['ellipse', t('Ellipse')], ['circle', t('Circle')], ['triangle', t('Triangle')], ['hexagon', t('Hexagon')]]],
  [t('Flowchart'), [['terminal', t('Start or end')], ['decision', t('Decision')], ['parallelogram', t('Parallelogram')],
    ['document', t('Document')], ['subprocess', t('Subprocess')], ['delay', t('Delay')], ['display', t('Display')],
    ['dataStorage', t('Data storage')], ['internalStorage', t('Internal storage')], ['cylinder', t('Cylinder')],
    ['trapezoid', t('Trapezoid')], ['step', t('Chevron')], ['tape', t('Tape')], ['card', t('Card')]]],
  [t('More'), [['note', t('Note')], ['callout', t('Callout')], ['cloud', t('Cloud')], ['cube', t('Cube')], ['actor', t('Person')],
    ['container', t('Container')], ['blockArrow', t('Block arrow')], ['doubleArrow', t('Double block arrow')]]],
];
const FLOW_SHAPES = () => FLOW_SHAPE_GROUPS().flatMap(([, shapes]) => shapes);

function toolIconSvg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${TOOL_ICON_PATHS[name]}</svg>`;
}

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

// Steps pane geometry (style.css): each level indents the row 18px, and a
// thread line runs under the status dot, 14px into the row's padding box.
const STEP_INDENT = 18;
const THREAD_X = 14;
const THREAD_HIT = 12; // clickable width of a thread line

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
    target.tagName === 'SELECT' ||
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
    // Steps whose substeps are folded away in the Steps pane, per guide. View only: never saved or exported.
    this.collapsedStepsByGuide = new Map();
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
    this.canvas?.destroy();
    this.cancelPaneDrag();
    this.paneLayoutObserver?.disconnect();
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  setActive(active) {
    this.active = Boolean(active);
    if (!this.active) this.cancelPaneDrag();
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
    const previousWidths = JSON.stringify(this.settings?.editor?.paneWidths);
    this.settings = settings || {};
    if (this.shellMounted && previousWidths !== JSON.stringify(this.settings.editor?.paneWidths)) {
      this.paneWidths = window.StepForgePaneLayout.normalizeWidths(this.settings.editor?.paneWidths);
      this.updatePaneLayout();
    }
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
      // The profile's own colors, offered first when picking a fill.
      this.brandColors = profile ? [
        profile.colors?.primary, profile.colors?.accent, profile.colors?.text,
        ...(this.brandAnnotations ? [profile.annotations.shapes, profile.annotations.numbers, profile.annotations.tooltips] : []),
      ].filter(Boolean) : null;
    } catch {
      this.brandAnnotations = null;
      this.brandColors = null;
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
      'sep',
      { label: t('Create a flowchart'), disabled: unavailable(hasStep && this.steps.length > 0), action: () => this.generateFlowchartWithAi() },
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
        this.setAiProgress(t('organizing'));
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
        this.setAiProgress(t('guide title'));
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
        this.onToast(t('An AI agent deleted the step you were editing. Its saved version is in Backups & snapshots.'));
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
    this.savedGuideBaseline = clone(guide);
    this.steps = steps;
    this.stepMap = new Map(steps.map((step) => [step.stepId, step]));
    this.savedStepBaselines = new Map(steps.map((step) => [step.stepId, clone(step)]));
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
    // No Select button: Select is what the editor is in when no other tool
    // is picked. Clicking the picked tool again, Escape or S goes back to it.
    const toolButtons = [
      ['rect', t('Rectangle')],
      ['oval', t('Oval')],
      ['line', t('Line')],
      ['pen', t('Pen')],
      ['arrow', t('Arrow')],
      ['curvedArrow', t('Curved arrow')],
      ['text', t('Text')],
      ['tooltip', t('Tooltip')],
      ['number', t('Number')],
      ['blur', t('Blur')],
      ['highlight', t('Highlight')],
      ['magnify', t('Magnify')],
      ['cursor', t('Cursor')],
      ['spotlight', t('Spotlight')],
      ['crop', t('Crop')],
    ];

    this.dom = {};
    this.dom.root = el('div.editor', {},
      this.dom.stepsPane = el('aside.pane-steps', { id: 'editor-steps-pane' },
        el('div.pane-head', {},
          el('div', {},
            el('div.eyebrow', {}, t('Steps')),
            this.dom.stepCount = el('div.muted', {}, tn(0, '{count} step', '{count} steps')),
          ),
          el('div.row', {},
            this.dom.addStepBtn = el('button.primary', { type: 'button' }, t('Add')),
            this.dom.selectStepsBtn = el('button', { type: 'button', title: t('Select steps; Shift-click to select a range') }, t('Select')),
          ),
        ),
        this.dom.stepsList = el('div.steps-list', { role: 'list', 'aria-label': t('Steps') }),
        this.dom.stepBulkBar = el('div'),
        this.dom.paneFoot = el('div.pane-foot', {},
          this.dom.moveUpBtn = el('button.icon', { type: 'button', title: t('Move step up'), 'aria-label': t('Move step up') }, '↑'),
          this.dom.moveDownBtn = el('button.icon', { type: 'button', title: t('Move step down'), 'aria-label': t('Move step down') }, '↓'),
          this.dom.duplicateBtn = el('button', { type: 'button' }, t('Duplicate')),
          this.dom.deleteBtn = el('button.danger', { type: 'button' }, t('Delete')),
        ),
      ),
      this.dom.stepsDivider = el('div.pane-divider', { role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
        'aria-label': t('Resize steps pane'), 'aria-controls': 'editor-steps-pane' }),
      this.dom.canvasPane = el('section.pane-canvas', {},
        el('div.canvas-toolbar', {},
          this.dom.imageTools = el('span.toolbar-group', {},
          ...toolButtons.map(([tool, name]) => {
            const key = TOOL_SHORTCUTS[tool];
            return this.dom[`tool-${tool}`] = el('button.tool.tool-icon', {
              type: 'button', dataset: { tool },
              title: key ? t('{tool} ({key})', { tool: name, key }) : name,
              'aria-label': name,
              ...(key ? { 'aria-keyshortcuts': key } : {}),
              innerHTML: toolIconSvg(tool),
            });
          }),
          el('span.sep'),
          this.dom.zoomSelect = el('select.zoom-select', { title: t('Zoom'), 'aria-label': t('Zoom') },
            el('option', { value: 'fit' }, t('Fit')),
            el('option', { value: '1' }, '100%'),
            el('option', { value: '1.25' }, '125%'),
            el('option', { value: '1.5' }, '150%'),
          ),
          el('span.sep'),
          ),
          // Shown instead of the image tools while the menu on the right is on Flowchart.
          this.dom.flowTools = el('span.toolbar-group', { hidden: true },
            ...FLOW_TOOLS().map(([tool, name]) => (this.dom[`flow-${tool}`] = el('button.tool.tool-icon', {
              type: 'button', dataset: { flowTool: tool }, title: name, 'aria-label': name, innerHTML: toolIconSvg(`flow-${tool}`),
            }))),
            this.dom.flowShapesBtn = el('button.tool.tool-icon', {
              type: 'button', title: t('More shapes'), 'aria-label': t('More shapes'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', innerHTML: toolIconSvg('flow-shapes'),
            }),
            el('span.sep'),
            this.dom.flowArrangeBtn = el('button.tool.tool-icon', { type: 'button', title: t('Arrange'), 'aria-label': t('Arrange'), innerHTML: toolIconSvg('flow-arrange') }),
            this.dom.flowDeleteBtn = el('button.tool.tool-icon', { type: 'button', title: t('Delete selected'), 'aria-label': t('Delete selected'), innerHTML: toolIconSvg('flow-delete') }),
            el('span.sep'),
          ),
          this.dom.undoBtn = el('button.tool.tool-icon', { type: 'button', title: t('Undo'), 'aria-label': t('Undo'), innerHTML: toolIconSvg('undo') }),
          this.dom.redoBtn = el('button.tool.tool-icon', { type: 'button', title: t('Redo'), 'aria-label': t('Redo'), innerHTML: toolIconSvg('redo') }),
          el('span.toolbar-spacer'),
          this.dom.flowPlacementSelect = el('select.flowchart-placement', { hidden: true, title: t('Where the flowchart shows in exports'), 'aria-label': t('Where the flowchart shows in exports') },
            el('option', { value: 'visual' }, t('Instead of image')),
            el('option', { value: 'block' }, t('As a block')),
          ),
          this.dom.visualSelect = el('select.visual-select', { title: t('Edit the image or the flowchart'), 'aria-label': t('Edit the image or the flowchart') },
            el('option', { value: 'image' }, t('Image')),
            el('option', { value: 'flowchart' }, t('Flowchart')),
          ),
        ),
        this.dom.canvasWrap = el('div.canvas-wrap', {},
          this.dom.canvas = el('canvas', { width: 1, height: 1, tabIndex: -1, role: 'group', 'aria-label': t('Screenshot editor'), 'aria-describedby': 'screenshot-keyboard-help' }, t('Select annotations in the list to edit their properties.')),
          el('span.sr-only', { id: 'screenshot-keyboard-help' }, t('Select an annotation from the list, then focus the screenshot. Use arrow keys to move it and Delete to remove it.')),
          this.dom.canvasEmpty = el('div.canvas-empty', {}, t('Select an image step to edit annotations.')),
        ),
        this.dom.flowSurface = el('div.flowchart-surface', { hidden: true, role: 'group', 'aria-label': t('Flowchart') }),
      ),
      this.dom.propertiesDivider = el('div.pane-divider', { role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
        'aria-label': t('Resize step details pane'), 'aria-controls': 'editor-details-pane' }),
      this.dom.propertiesPane = el('aside.pane-props', { id: 'editor-details-pane' },
        el('section', {},
          el('h3', {}, t('Step')),
          el('div.row', {},
            this.dom.titleInput = el('input', { type: 'text', placeholder: t('Step title'), 'aria-label': t('Step title'), style: { flex: 1 } }),
          ),
          this.dom.statusSelect = makeSelect('todo', [
            { value: 'todo', label: t('Todo') },
            { value: 'in-progress', label: t('In progress') },
            { value: 'done', label: t('Done') },
          ]),
          el('div.row', {},
            this.dom.hiddenToggle = el('label', {}, el('input', { type: 'checkbox' }), ' ', t('Hidden')),
            this.dom.skippedToggle = el('label', {}, el('input', { type: 'checkbox' }), ' ', t('Skipped')),
          ),
          el('div.row', {},
            this.dom.forceNewPageToggle = el('label', {}, el('input', { type: 'checkbox' }), ' ', t('New page')),
            this.dom.focusedViewToggle = el('label.focused-toggle', {}, el('input', { type: 'checkbox' }), ' ', t('Focused')),
          ),
          // Pan shows as a percentage, 0% at the left and top edges (core/focused-view.js).
          this.dom.focusedControls = el('div.focused-controls.hidden', {},
            el('div.form-row', {}, el('label', {}, t('Zoom')),
              this.dom.fvZoom = el('input', { type: 'range', min: 1, max: 3, step: 0.05, value: 1.5, 'aria-label': t('Zoom') }),
              this.dom.fvZoomNum = el('input', { type: 'number', min: 1, max: 3, step: 0.05, value: '1.50', 'aria-label': t('{label} value', { label: t('Zoom') }) }),
              el('span.fv-unit', {}, '×')),
            el('div.form-row', { title: t('0% is the left edge, 100% the right edge.') }, el('label', {}, t('Pan X')),
              this.dom.fvPanX = el('input', { type: 'range', min: 0, max: 100, step: 1, value: 50, 'aria-label': t('Pan X') }),
              this.dom.fvPanXNum = el('input', { type: 'number', min: 0, max: 100, step: 1, value: 50, 'aria-label': t('{label} value', { label: t('Pan X') }) }),
              el('span.fv-unit', {}, '%')),
            el('div.form-row', { title: t('0% is the top edge, 100% the bottom edge.') }, el('label', {}, t('Pan Y')),
              this.dom.fvPanY = el('input', { type: 'range', min: 0, max: 100, step: 1, value: 50, 'aria-label': t('Pan Y') }),
              this.dom.fvPanYNum = el('input', { type: 'number', min: 0, max: 100, step: 1, value: 50, 'aria-label': t('{label} value', { label: t('Pan Y') }) }),
              el('span.fv-unit', {}, '%')),
            el('div.muted', {}, t('Exports crop to this view; the original image is never modified.')),
          ),
        ),
        el('section', {},
          el('div.description-head', {},
            el('h3', {}, t('Description')),
            this.dom.descModeSelect = el('select.description-mode', { title: t('Description format'), 'aria-label': t('Description format') },
              el('option', { value: 'rich' }, t('Rich text')),
              el('option', { value: 'markdown' }, t('Markdown')),
            ),
            this.dom.descPreviewBtn = el('button.description-preview-toggle', { type: 'button', hidden: true, 'aria-pressed': 'false' }, t('Preview')),
          ),
          this.dom.richToolbar = el('div.rich-toolbar', {},
            this.toolbarBtn('bold', t('Bold')),
            this.toolbarBtn('italic', t('Italic')),
            this.toolbarBtn('insertUnorderedList', t('Bullet')),
            this.toolbarBtn('insertOrderedList', t('Number')),
            this.toolbarBtn('formatBlock', t('Quote'), 'blockquote'),
            this.toolbarBtn('createLink', t('Link')),
            this.toolbarBtn('removeFormat', t('Clear')),
            this.toolbarBtn('insertStep', t('Step')),
          ),
          this.dom.descEditor = el('div.rich-editor', { contentEditable: 'true', spellcheck: true, role: 'textbox', 'aria-label': t('Description'), 'aria-multiline': 'true' }),
          // Description → Markdown: the source, and its preview.
          this.dom.descSource = el('textarea.description-source', {
            hidden: true, spellcheck: true, rows: 8, 'aria-label': t('Description (Markdown)'),
            placeholder: t('Markdown: **bold**, *italic*, # headings, - lists, | tables |, `code`, [links](https://example.com) and HTML.'),
          }),
          this.dom.descPreview = el('div.rich-editor.description-preview', { hidden: true, 'aria-label': t('Description preview') }),
        ),
        this.dom.flowSection = el('section', { hidden: true },
          el('h3', {}, t('Flowchart')),
          this.dom.flowProps = el('div.flowchart-props'),
        ),
        this.dom.annotationsSection = el('section', {},
          el('h3', {}, t('Annotations')),
          this.dom.annotationList = el('div', { className: 'annotation-list' }),
          this.dom.annotationEditor = el('div', { className: 'annotation-editor' }),
        ),
        el('section', {},
          el('h3', {}, t('Blocks')),
          this.dom.blocksList = el('div', { className: 'blocks-list' }),
          el('div.row.block-add-row', {},
            this.dom.addTextBlockBtn = el('button', { type: 'button' }, t('+ Text block')),
            this.dom.addCodeBlockBtn = el('button', { type: 'button' }, t('+ Code')),
            this.dom.addTableBlockBtn = el('button', { type: 'button' }, t('+ Table')),
            this.dom.addFlowchartBtn = el('button', { type: 'button' }, t('+ Flowchart')),
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
    this.dom.statusSelect.setAttribute?.('aria-label', t('Status'));
    for (const row of this.dom.focusedControls.querySelectorAll?.('.form-row') || []) labelControl(row.querySelector('label'), [...row.querySelectorAll('input')]);

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
      onToolUsed: () => this.onCanvasToolUsed(),
      defaultStyle: (tool) => this.defaultStyleForTool(tool),
      nextNumber: () => this.nextAnnotationNumber(),
    });

    this.resizeObserver = new ResizeObserver(() => this.canvas.applyZoom());
    this.resizeObserver.observe(this.dom.canvasWrap);

    this.bindShellEvents();
    this.setupPaneResizing();
  }

  setupPaneResizing() {
    const layout = window.StepForgePaneLayout;
    this.paneWidths = layout.normalizeWidths(this.settings?.editor?.paneWidths);
    this.lastSavedPaneWidths = JSON.stringify(this.paneWidths);
    const hint = t('Drag to resize. Use Left/Right arrows, Shift for larger changes, or Home/End.');
    for (const side of ['steps', 'properties']) {
      const divider = this.dom[`${side}Divider`];
      divider.title = hint;
      divider.setAttribute('aria-description', hint);
      divider.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Focused for the drag so Escape can cancel it; a mouse drag hands focus back afterwards.
        const keepFocus = document.activeElement === divider;
        divider.focus();
        this.paneDrag = { side, pointerId: event.pointerId, divider, startX: event.clientX,
          startWidth: this.effectivePaneWidths[side], keepFocus };
        divider.setPointerCapture(event.pointerId);
        divider.classList.add('dragging');
        this.dom.root.classList.add('resizing-panes');
      });
      divider.addEventListener('pointermove', event => {
        if (this.paneDrag?.divider !== divider) return;
        const direction = side === 'steps' ? 1 : -1;
        this.resizePane(side, this.paneDrag.startWidth + direction * (event.clientX - this.paneDrag.startX));
      });
      divider.addEventListener('pointerup', () => {
        if (this.paneDrag?.divider !== divider) return;
        this.paneWidths[side] = this.effectivePaneWidths[side];
        this.finishPaneDrag();
        this.persistPaneWidths();
      });
      divider.addEventListener('pointercancel', () => this.cancelPaneDrag());
      divider.addEventListener('lostpointercapture', () => this.cancelPaneDrag());
      divider.addEventListener('keydown', event => {
        if (event.key === 'Escape' && this.paneDrag) {
          event.preventDefault(); event.stopPropagation(); this.cancelPaneDrag(); return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        // Plain keys on a separator must not switch canvas tools or move an annotation.
        event.stopPropagation();
        const other = side === 'steps' ? 'properties' : 'steps';
        const bounds = layout.paneBounds(side, this.dom.root.clientWidth, this.effectivePaneWidths[other], this.paneMinimums());
        let width;
        if (event.key === 'Home') width = bounds.min;
        else if (event.key === 'End') width = bounds.max;
        else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          const direction = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'steps' ? 1 : -1);
          width = this.effectivePaneWidths[side] + direction * (event.shiftKey ? 40 : 10);
        } else return;
        event.preventDefault();
        this.resizePane(side, width);
        this.paneWidths[side] = this.effectivePaneWidths[side];
      });
      divider.addEventListener('keyup', event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) this.persistPaneWidths();
      });
      divider.addEventListener('blur', () => this.persistPaneWidths());
    }
    this.paneLayoutObserver = new ResizeObserver(() => {
      this.cancelPaneDrag();
      this.updatePaneLayout();
    });
    this.paneLayoutObserver.observe(this.dom.root);
    this.updatePaneLayout();
  }

  applyPaneWidths(widths) {
    this.effectivePaneWidths = widths;
    this.dom.root.style.setProperty('--steps-pane-width', `${widths.steps}px`);
    this.dom.root.style.setProperty('--properties-pane-width', `${widths.properties}px`);
    for (const side of ['steps', 'properties']) {
      const other = side === 'steps' ? 'properties' : 'steps';
      const bounds = window.StepForgePaneLayout.paneBounds(side, this.dom.root.clientWidth, widths[other], this.paneMinimums());
      const divider = this.dom[`${side}Divider`];
      divider.setAttribute('aria-valuemin', bounds.min);
      divider.setAttribute('aria-valuemax', bounds.max);
      divider.setAttribute('aria-valuenow', widths[side]);
      divider.setAttribute('aria-valuetext', tn(widths[side], '{count} pixel', '{count} pixels'));
    }
  }

  updatePaneLayout() {
    if (!this.dom?.root?.clientWidth) return;
    this.applyPaneWidths(window.StepForgePaneLayout.layoutPanes(this.dom.root.clientWidth, this.paneWidths, this.paneMinimums()));
  }

  /**
   * The pane minimums, with the steps pane wide enough for its header and
   * its ↑ ↓ Duplicate Delete row on one line in the current language and
   * font. Kept at the widest seen, since the footer hides in Select mode.
   */
  paneMinimums() {
    const mins = window.StepForgePaneLayout.MIN_WIDTHS;
    const rowWidth = (row) => {
      const items = [...row.children].filter((child) => child.offsetWidth);
      if (!items.length) return 0;
      const style = getComputedStyle(row);
      const gap = parseFloat(style.columnGap) || 0;
      // A nested .row (Add, Select) may already be wrapped, so add up its own items.
      return items.reduce((sum, child) => sum + (child.classList.contains('row') ? rowWidth(child) : child.getBoundingClientRect().width), 0)
        + gap * (items.length - 1) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    };
    const pane = this.dom.stepsPane;
    const needed = Math.ceil(Math.max(rowWidth(pane.querySelector('.pane-head')), rowWidth(this.dom.paneFoot)) + pane.offsetWidth - pane.clientWidth);
    this.stepsPaneMinWidth = Math.max(this.stepsPaneMinWidth || 0, mins.steps, needed);
    return { ...mins, steps: this.stepsPaneMinWidth };
  }

  resizePane(side, requested) {
    const layout = window.StepForgePaneLayout;
    const width = this.dom.root.clientWidth;
    const other = side === 'steps' ? 'properties' : 'steps';
    const next = { ...this.effectivePaneWidths };
    next[side] = layout.clampPaneWidth(side, requested, width, next[other], this.paneMinimums());
    next.canvas = width - next.steps - next.properties - 2 * layout.DIVIDER_WIDTH;
    this.applyPaneWidths(next);
  }

  finishPaneDrag() {
    const drag = this.paneDrag;
    this.paneDrag = null;
    if (drag?.divider.hasPointerCapture(drag.pointerId)) drag.divider.releasePointerCapture(drag.pointerId);
    drag?.divider.classList.remove('dragging');
    if (drag && !drag.keepFocus) drag.divider.blur();
    this.dom?.root?.classList.remove('resizing-panes');
  }

  cancelPaneDrag() {
    if (!this.paneDrag) return;
    this.finishPaneDrag();
    this.updatePaneLayout();
  }

  persistPaneWidths() {
    if (!this.paneWidths) return;
    const key = JSON.stringify(this.paneWidths);
    if (key === this.lastSavedPaneWidths) return this.paneSavePromise;
    this.lastSavedPaneWidths = key;
    this.settings.editor ||= {};
    this.settings.editor.paneWidths = { ...this.paneWidths };
    this.paneSavePromise = api.settings.set({ keyPath: 'editor.paneWidths', value: { ...this.paneWidths } }).catch(error => {
      if (this.lastSavedPaneWidths === key) this.lastSavedPaneWidths = null;
      this.onToast(t('Could not save pane widths: {error}', { error: error.message }), { error: true });
    });
    return this.paneSavePromise;
  }

  toolbarBtn(action, label, block = null) {
    const labels = { bold: t('Bold'), italic: t('Italic'), insertUnorderedList: t('Bulleted list'), insertOrderedList: t('Numbered list'), formatBlock: t('Quote'), createLink: t('Link'), removeFormat: t('Clear'), insertStep: t('Link to a step') };
    const btn = el('button', {
      type: 'button',
      'aria-label': labels[action] || label,
      ...(!['createLink', 'removeFormat', 'insertStep'].includes(action) ? { 'aria-pressed': 'false' } : {}),
      ...(action === 'insertStep' ? { title: t('Link to a step. Ctrl+click the link to open that step.') } : {}),
      onClick: () => this.formatDescription(action, block),
    }, action === 'insertStep' ? label : labels[action] || label);
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
      if (!['createLink', 'removeFormat', 'insertStep'].includes(action)) btn.setAttribute('aria-pressed', String(active));
    }
  }

  bindShellEvents() {
    this.dom.addStepBtn.addEventListener('click', () => this.addEmptyStep());
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
    this.dom.zoomSelect.addEventListener('change', () => {
      const value = this.dom.zoomSelect.value;
      this.setZoom(value === 'fit' ? 'fit' : Number(value));
    });
    this.dom.undoBtn.addEventListener('click', () => this.undo());
    this.dom.redoBtn.addEventListener('click', () => this.redo());

    Object.entries(this.dom).forEach(([key, value]) => {
      if (key.startsWith('tool-')) {
        value.addEventListener('click', () => this.setTool(this.currentTool === value.dataset.tool ? 'select' : value.dataset.tool));
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
    this.bindFocusedControls();

    this.dom.addTextBlockBtn.addEventListener('click', () => this.addBlock('text'));
    this.dom.addCodeBlockBtn.addEventListener('click', () => this.addBlock('code'));
    this.dom.addTableBlockBtn.addEventListener('click', () => this.addBlock('table'));
    this.dom.addFlowchartBtn.addEventListener('click', () => this.addFlowchartBlock());
    this.dom.visualSelect.addEventListener('change', () => this.setCanvasMode(this.dom.visualSelect.value));
    this.dom.flowPlacementSelect.addEventListener('change', () => this.setFlowchartPlacement(this.dom.flowPlacementSelect.value));
    for (const [tool] of FLOW_TOOLS()) {
      this.dom[`flow-${tool}`].addEventListener('click', () => this.flowchartEditor()?.setTool(tool));
    }
    this.dom.flowShapesBtn.addEventListener('click', () => this.openShapePalette());
    this.dom.flowArrangeBtn.addEventListener('click', () => this.flowchartEditor()?.arrange());
    this.dom.flowDeleteBtn.addEventListener('click', () => this.flowchartEditor()?.deleteSelected());

    // While editing, a click on a link puts the caret in it; Ctrl+click opens
    // it (a step, or a web or mail address in the browser).
    this.dom.descEditor.addEventListener('click', (e) => {
      const link = e.target.closest?.('a');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      if (!(e.ctrlKey || e.metaKey)) return;
      if (link.dataset.stepId) {
        if (this.stepMap.has(link.dataset.stepId)) this.selectStep(link.dataset.stepId);
      } else if (/^(https?|mailto):/i.test(link.getAttribute('href') || '')) {
        api.shell.openExternal({ url: link.getAttribute('href') });
      }
    });
    this.dom.descEditor.addEventListener('focus', () => {
      // Make Enter start a new paragraph (<p>) rather than a plain <div>,
      // so line breaks survive sanitization and show up in exports.
      document.execCommand('defaultParagraphSeparator', false, 'p');
      if (this.currentStep) this.pushCanvasHistory('description');
      this.updateToolbarState();
    });
    this.dom.descEditor.addEventListener('blur', () => {
      this.linkifyAndSave({ caret: false });
      for (const btn of this.dom.richToolbar.children) btn.classList.remove('active');
    });
    this.dom.descEditor.addEventListener('input', () => {
      if (!this.currentStep) return;
      if (this.linkifyDescription()) this.refreshStepLinks();
      this.currentStep.descriptionHtml = this.dom.descEditor.innerHTML;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.emitMeta();
      this.updateToolbarState();
    });
    this.dom.descEditor.addEventListener('keyup', (e) => {
      // Moving the caret out of a typed [text](address) makes it a link.
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') this.linkifyAndSave();
      this.updateToolbarState();
    });
    this.dom.descModeSelect.addEventListener('change', () => this.setDescriptionMode(this.dom.descModeSelect.value));
    this.dom.descPreviewBtn.addEventListener('click', () => {
      // The preview opens at the size the Markdown box has (and the other way round).
      const from = this.descPreviewing ? this.dom.descPreview : this.dom.descSource;
      const to = this.descPreviewing ? this.dom.descSource : this.dom.descPreview;
      if (from.offsetHeight) to.style.height = `${from.offsetHeight}px`;
      this.descPreviewing = !this.descPreviewing;
      this.syncDescriptionMode();
      this.refreshStepLinks();
    });
    this.dom.descSource.addEventListener('focus', () => { if (this.currentStep) this.pushCanvasHistory('description'); });
    this.dom.descSource.addEventListener('input', () => {
      const step = this.currentStep;
      if (!step) return;
      step.descriptionMarkdown = this.dom.descSource.value;
      step.descriptionHtml = this.markdownToHtml(step.descriptionMarkdown);
      this.pendingSave = true;
      this.saveStepDebounced();
      this.emitMeta();
    });
    // Preview links work: a step link opens the step; web and mail links open
    // in the browser (app.js's document click handler).
    this.dom.descPreview.addEventListener('click', (e) => {
      const link = e.target.closest?.('a[data-step-id]');
      if (!link) return;
      e.preventDefault();
      if (this.stepMap.has(link.dataset.stepId)) this.selectStep(link.dataset.stepId);
    });
    this.dom.descEditor.addEventListener('mouseup', () => { this.linkifyAndSave(); this.updateToolbarState(); });
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
      [...this.dom.annotationList.querySelectorAll('[data-ann-id]')].find(button => button.dataset.annId === item.dataset.annId)?.focus();
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
    if (enabled) this.showFocusedValues();
    this.canvas.setFocusedView(fv);
  }

  /**
   * Each Focused view slider and its number box set one stored field and
   * mirror each other. While typing, the box keeps its text (so "1." can
   * become "1.5"); Enter or leaving the box shows the clamped value.
   */
  bindFocusedControls() {
    const setField = (field, value) => {
      const step = this.currentStep;
      if (!step || !step.focusedView || !Number.isFinite(value)) return false;
      step.focusedView[field] = value;
      this.pendingSave = true;
      this.saveStepDebounced();
      this.canvas.setFocusedView(step.focusedView);
      return true;
    };
    const bind = (range, box, field, read) => {
      for (const node of [range, box]) {
        node.addEventListener('input', () => {
          if (setField(field, read(node.value))) this.showFocusedValues(node);
        });
      }
      box.addEventListener('change', () => this.showFocusedValues());
    };
    bind(this.dom.fvZoom, this.dom.fvZoomNum, 'zoom', (value) => focused.zoomFromInput(value));
    bind(this.dom.fvPanX, this.dom.fvPanXNum, 'panX', (value) => focused.panFromPercent(value, 'x'));
    bind(this.dom.fvPanY, this.dom.fvPanYNum, 'panY', (value) => focused.panFromPercent(value, 'y'));
  }

  /** Show the current step's Focused view in its sliders and boxes, except `keep`, which is being edited. */
  showFocusedValues(keep = null) {
    const fv = this.currentStep?.focusedView || {};
    const rows = [
      [this.dom.fvZoom, this.dom.fvZoomNum, focused.formatZoom(fv.zoom || 1.5)],
      [this.dom.fvPanX, this.dom.fvPanXNum, focused.panToPercent(fv.panX ?? 0.5, 'x')],
      [this.dom.fvPanY, this.dom.fvPanYNum, focused.panToPercent(fv.panY ?? 0.5, 'y')],
    ];
    for (const [range, box, value] of rows) {
      if (range !== keep) range.value = value;
      if (box !== keep) box.value = value;
      range.setAttribute?.('aria-valuetext', `${value}${range === this.dom.fvZoom ? '×' : '%'}`);
    }
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
      step.tableBlocks.push({ id, order: nextBlockOrder(step), rows: [[t('Column A'), t('Column B')], ['', '']] });
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
      type: 'button', title: t('Remove block'), 'aria-label': t('Remove block'),
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
        el('button.icon', { type: 'button', title: t('Move block up'), 'aria-label': t('Move block up'), disabled: !canMoveUp, onClick: moveUp, dataset: { blockMove: 'up' } }, '↑'),
        el('button.icon', { type: 'button', title: t('Move block down'), 'aria-label': t('Move block down'), disabled: !canMoveDown, onClick: moveDown, dataset: { blockMove: 'down' } }, '↓'),
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
        position.setAttribute('aria-label', t('Block position'));
        const level = makeSelect(block.level, [
          { value: 'info', label: t('Note') },
          { value: 'warn', label: t('Warning') },
          { value: 'error', label: t('Important') },
          { value: 'success', label: t('Tip') },
        ]);
        level.dataset.blockField = 'level';
        level.setAttribute('aria-label', t('Message type'));
        const title = el('input', { type: 'text', value: block.title || '', placeholder: t('Block title'), 'aria-label': t('Block title') });
        title.dataset.blockField = 'title';
        const body = el('textarea', { rows: 2, placeholder: t('Block text'), 'aria-label': t('Block text') });
        body.dataset.blockField = 'body';
        body.value = (block.descriptionHtml || '').replace(/<[^>]+>/g, '');
        position.addEventListener('change', () => { block.position = position.value; save(); });
        level.addEventListener('change', () => { block.level = level.value; card.dataset.level = level.value; save(); });
        title.addEventListener('input', () => { block.title = title.value; save(); });
        body.addEventListener('input', () => { block.descriptionHtml = `<p>${escapeHtml(body.value)}</p>`; save(); });
        card.append(
          el('div.row.block-text-options', {}, level, position),
          title,
          body,
        );
      } else if (kind === 'code') {
        const lang = el('input', { type: 'text', value: block.language || '', placeholder: t('Language (e.g. bash)'), 'aria-label': t('Language') });
        lang.dataset.blockField = 'language';
        const code = el('textarea', { rows: 3, placeholder: t('Code'), spellcheck: false, 'aria-label': t('Code') });
        code.dataset.blockField = 'code';
        code.value = blockText(block);
        code.style.fontFamily = 'monospace';
        lang.addEventListener('input', () => { block.language = lang.value; save(); });
        code.addEventListener('input', () => { block.code = code.value; save(); });
        card.append(lang, code);
      } else if (kind === 'table') {
        const grid = el('textarea', { rows: 3, placeholder: t('One row per line, cells separated by |'), spellcheck: false, 'aria-label': t('Table rows') });
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

    // The step's flowchart, when it shows as a block. It always comes last.
    const chartBlock = step.flowchart && step.flowchartPlacement === 'block';
    if (chartBlock && window.StepForgeFlowchart) {
      const preview = el('div.flowchart-preview', {
        innerHTML: step.flowchart.nodes.length
          ? window.StepForgeFlowchart.toSvg(step.flowchart, { steps: this.flowchartStepRefs(), stepLabel: (number) => t('Step {number}', { number }) })
          : '',
      });
      this.dom.blocksList.append(el('div.block-card', { dataset: { blockKind: 'flowchart' } },
        el('div.row', {},
          el('strong', {}, t('Flowchart')),
          el('span.spacer'),
          el('button', { type: 'button', onClick: () => this.setCanvasMode('flowchart') }, t('Edit')),
          el('button.icon', { type: 'button', title: t('Remove flowchart'), 'aria-label': t('Remove flowchart'), onClick: () => this.removeFlowchart() }, '×'),
        ),
        step.flowchart.nodes.length ? preview : el('div.muted', {}, t('Empty flowchart.')),
      ));
    }
    this.dom.addFlowchartBtn.disabled = Boolean(chartBlock);

    if (!blocks.length && !chartBlock) {
      this.dom.blocksList.append(el('div.muted', {}, t('Informational text, code, and table blocks can be reordered with drag handles or arrows.')));
    }
  }

  renderStepList() {
    const focusKey = document.activeElement?.dataset?.stepFocus;
    const current = this.currentStep;
    const numbers = stepNumberMap(this.steps);
    clearNode(this.dom.stepsList);
    this.dom.stepCount.textContent = tn(this.steps.length, '{count} step', '{count} steps');
    this.dom.selectStepsBtn.className = this.stepSelectMode ? 'primary' : '';
    this.dom.selectStepsBtn.setAttribute?.('aria-pressed', String(this.stepSelectMode));
    // Threads (see stepThreads) are hidden while selecting, so every step is listed for range selection.
    const threads = this.stepSelectMode ? null : this.stepThreads();
    for (const step of threads ? threads.visible : this.steps) {
      const number = numbers.get(step.stepId) || '';
      const depth = stepDepth(step, this.stepMap);
      const selected = current && current.stepId === step.stepId;
      const checked = this.selectedSteps.has(step.stepId);
      const itemProps = {
        role: 'listitem',
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
        onContextMenu: async (e) => {
          e.preventDefault();
          if (this.stepSelectMode) return;
          const kind = e.currentTarget?.classList?.contains('step-select') ? 'select' : 'actions';
          const guideId = this.guideId;
          await this.selectStep(step.stepId);
          if (this.guideId !== guideId || !this.stepMap.has(step.stepId)) return;
          const trigger = [...this.dom.stepsList.querySelectorAll('[data-step-focus]')].find(button => button.dataset.stepFocus === `${kind}:${step.stepId}`);
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
            ...(threads?.parents.has(step.stepId) ? ['sep', {
              label: threads.collapsed.has(step.stepId) ? t('Expand step') : t('Collapse step'),
              action: () => void this.toggleStepCollapsed(step.stepId),
            }] : []),
          ], { trigger });
        },
        onKeyDown: e => {
          if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
          e.preventDefault(); e.stopPropagation();
          const trigger = e.target.closest('button') || e.currentTarget;
          const rect = trigger.getBoundingClientRect();
          void itemProps.onContextMenu({ clientX: rect.left, clientY: rect.bottom, currentTarget: trigger, preventDefault() {} });
        },
      };
      if (depth) itemProps.style = { marginLeft: `${depth * 18}px` };
      const item = el('div.step-item', itemProps,
        this.stepSelectMode
          ? el('input.step-control', {
            type: 'checkbox',
            checked,
            dataset: { stepFocus: `check:${step.stepId}` },
            'aria-label': t('Select step {step}', { step: `${number} ${step.title || t('Untitled step')}` }),
            onClick: (e) => {
              e.stopPropagation();
              this.toggleStepSelection(step.stepId, e.shiftKey);
            },
          })
          : null,
        this.stepSelectMode ? el('span.step-summary', {},
          el('span.num', {}, number || '•'), el('span.t', {}, step.title || t('Untitled step')))
          : el('button.step-select.step-control', {
            type: 'button', dataset: { stepFocus: `select:${step.stepId}` },
            'aria-label': t('Select step {step}', { step: `${number} ${step.title || t('Untitled step')}` }),
            'aria-current': selected ? 'step' : 'false',
            onClick: e => { e.stopPropagation(); void this.selectStep(step.stepId); },
            onKeyDown: async e => {
              if (e.ctrlKey || e.metaKey || e.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault(); e.stopPropagation();
              const at = this.steps.findIndex(s => s.stepId === step.stepId);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? this.steps.length - 1 : Math.max(0, Math.min(this.steps.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
              const nextId = this.steps[next].stepId, guideId = this.guideId;
              await this.selectStep(nextId);
              if (this.guideId === guideId && document.activeElement?.dataset?.stepFocus === `select:${step.stepId}`) this.focusStepControl(`select:${nextId}`, { force: true });
            },
          }, el('span.status-dot', { className: `status-dot status-${step.status}`, 'aria-hidden': 'true' }),
          el('span.num', {}, number || '•'), el('span.t', {}, step.title || t('Untitled step'))),
        threads ? this.stepFoldCount(step, number, threads) : null,
        el('span.flags', {}, [
          step.hidden ? t('Hidden') : '',
          step.skipped ? t('Skipped') : '',
        ].filter(Boolean).join(' · ')),
        this.stepSelectMode ? null : el('button.step-actions.step-control', {
          type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { stepFocus: `actions:${step.stepId}` },
          'aria-label': t('Actions for “{title}”', { title: step.title || t('Untitled step') }),
          onClick: e => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); void itemProps.onContextMenu({ clientX: rect.left, clientY: rect.bottom, currentTarget: e.currentTarget, preventDefault() {} }); },
        }, '⋯'),
        ...(threads ? this.stepThreadLines(step, depth, number, threads) : []),
      );
      this.dom.stepsList.append(item);
    }
    if (!this.steps.length) {
      this.dom.stepsList.append(el('div.empty-state', { style: { marginTop: '40px' } }, t('No steps yet.')));
    }
    this.renderStepBulkBar();
    this.focusStepControl(focusKey);
  }

  focusStepControl(key, { force = false } = {}) {
    if (!key || (!force && document.activeElement?.isConnected && document.activeElement !== document.body)) return;
    [...(this.dom.root?.querySelectorAll?.('[data-step-focus]') || [])].find(button => button.dataset.stepFocus === key && !button.disabled)?.focus();
  }

  /** The collapsed step ids of the open guide. */
  collapsedSteps() {
    if (!this.collapsedStepsByGuide.has(this.guideId)) this.collapsedStepsByGuide.set(this.guideId, new Set());
    return this.collapsedStepsByGuide.get(this.guideId);
  }

  /**
   * What the Steps pane draws, Reddit-thread style: `visible` rows (substeps
   * of a collapsed step are left out), `parents` (steps that have substeps),
   * each visible step's `ancestors` from the top level down, and `collapsed`.
   */
  stepThreads() {
    const parentOf = outline.parentMap(this.steps);
    const parents = new Set([...parentOf.values()].filter(Boolean));
    const collapsed = this.collapsedSteps();
    for (const id of [...collapsed]) if (!parents.has(id)) collapsed.delete(id); // its substeps are gone
    const visible = outline.visibleSteps(this.steps, collapsed);
    const ancestors = new Map(visible.map((step) => {
      const chain = [];
      for (let id = parentOf.get(step.stepId); id && !chain.includes(id); id = parentOf.get(id)) chain.unshift(id);
      return [step.stepId, chain];
    }));
    return { visible, parents, ancestors, collapsed, parentOf };
  }

  /**
   * The thread lines on a step row: one segment for each step it is a
   * substep of, under that step's status dot, and on a step with open
   * substeps, the start of its own line (a button: Enter or Space folds
   * it). Clicking any segment of a thread collapses the step it belongs to.
   */
  stepThreadLines(step, depth, number, threads) {
    const lines = [];
    const chain = threads.ancestors.get(step.stepId);
    const index = threads.visible.indexOf(step);
    const nextChain = threads.ancestors.get(threads.visible[index + 1]?.stepId) || [];
    chain.forEach((ancestorId, level) => {
      lines.push(el('span.step-thread-line', {
        className: `step-thread-line${nextChain.includes(ancestorId) ? '' : ' end'}`,
        dataset: { thread: ancestorId },
        style: { left: `${THREAD_X - (depth - level) * STEP_INDENT - THREAD_HIT / 2}px` },
        'aria-hidden': 'true',
        ...this.threadEvents(ancestorId),
      }));
    });
    if (threads.parents.has(step.stepId) && !threads.collapsed.has(step.stepId)) {
      const name = `${number} ${step.title || t('Untitled step')}`.trim();
      lines.push(el('button.step-thread-start', {
        type: 'button',
        draggable: false,
        title: t('Collapse step'),
        'aria-label': t('Collapse step {step}', { step: name }),
        'aria-expanded': 'true',
        dataset: { thread: step.stepId },
        ...this.threadEvents(step.stepId),
      }));
    }
    return lines;
  }

  /** On a collapsed step, the "+3" that shows how many substeps are folded away and opens them. */
  stepFoldCount(step, number, threads) {
    if (!threads.collapsed.has(step.stepId)) return null;
    const count = this.getStepDescendantIds(step.stepId).length;
    return el('button.step-fold-count', {
      type: 'button',
      draggable: false,
      title: tn(count, 'Show {count} substep', 'Show {count} substeps'),
      'aria-label': t('Expand step {step}', { step: `${number} ${step.title || t('Untitled step')}`.trim() }),
      'aria-expanded': 'false',
      dataset: { thread: step.stepId },
      onMouseDown: (e) => e.stopPropagation(),
      onClick: (e) => { e.stopPropagation(); void this.toggleStepCollapsed(step.stepId); },
    }, `+${count}`);
  }

  /** Clicking a thread folds its step; hovering lights up the whole thread. */
  threadEvents(stepId) {
    const light = (on) => {
      for (const node of this.dom.stepsList.querySelectorAll(`[data-thread="${stepId}"]`)) node.classList.toggle('hot', on);
    };
    return {
      onMouseDown: (e) => e.stopPropagation(), // not the start of a row drag
      onMouseEnter: () => light(true),
      onMouseLeave: () => light(false),
      onClick: (e) => { e.stopPropagation(); void this.toggleStepCollapsed(stepId); },
    };
  }

  /**
   * Fold or unfold a step's substeps. A selected substep that folds away
   * hands the selection to the step it is under, so the selection stays in view.
   */
  async toggleStepCollapsed(stepId) {
    // A keyboard user on this step's control keeps focus on it; a mouse click or the menu doesn't move focus.
    const hadFocus = globalThis.document?.activeElement?.dataset?.thread === stepId;
    const collapsed = this.collapsedSteps();
    const folding = !collapsed.has(stepId);
    if (folding) collapsed.add(stepId);
    else collapsed.delete(stepId);
    if (folding && this.getStepDescendantIds(stepId).includes(this.selectedStepId)) {
      await this.selectStep(stepId);
    }
    this.renderStepList();
    if (!hadFocus) return;
    const control = [...this.dom.stepsList.querySelectorAll('.step-thread-start, .step-fold-count')]
      .find((node) => node.dataset.thread === stepId);
    control?.focus();
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
    const focusKey = document.activeElement?.dataset?.stepFocus;
    clearNode(this.dom.stepBulkBar);
    this.dom.paneFoot.classList.toggle('hidden', this.stepSelectMode);
    if (!this.stepSelectMode) return;
    const n = this.selectedSteps.size;
    const allSelected = this.steps.length > 0 && n === this.steps.length;
    this.dom.stepBulkBar.append(
      el('div.bulk-bar', {},
        el('span', {}, tn(n, '{count} step selected', '{count} steps selected')),
        el('span.spacer', {}),
        el('button', {
          type: 'button',
          dataset: { stepFocus: 'bulk:all' },
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
        el('button.danger', { type: 'button', disabled: !n, dataset: { stepFocus: 'bulk:delete' }, onClick: () => this.deleteSelectedSteps() }, t('Delete')),
      ),
    );
    this.focusStepControl(focusKey);
  }

  /**
   * Asks before deleting steps, unless Settings → Editor → Dangerous deletes
   * is on. Resolves true to delete.
   */
  async confirmDelete(message, title) {
    if (this.settings?.editor?.dangerousDeletes === true) return true;
    return confirmDialog(message, { title, danger: true, okLabel: t('Delete') });
  }

  async deleteSelectedSteps() {
    const ids = [...this.selectedSteps];
    if (!ids.length) return;
    const ok = await this.confirmDelete(tn(ids.length, 'Delete {count} step?', 'Delete {count} steps?'), t('Delete selected steps'));
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
    this.onToast(tn(ids.length, '{count} step deleted. Press Ctrl+Z to undo.', '{count} steps deleted. Press Ctrl+Z to undo.'));
  }

  syncStepFields() {
    const step = this.currentStep;
    const guide = this.guide;
    if (!step) {
      this.dom.titleInput.value = '';
      this.dom.descEditor.innerHTML = '';
      this.syncDescriptionMode();
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
    this.syncDescriptionMode();
    this.refreshStepLinks();
    this.dom.statusSelect.value = step.status || 'todo';
    this.dom.hiddenToggle.querySelector('input').checked = Boolean(step.hidden);
    this.dom.skippedToggle.querySelector('input').checked = Boolean(step.skipped);
    this.dom.forceNewPageToggle.querySelector('input').checked = Boolean(step.forceNewPage);
    this.dom.focusedViewToggle.querySelector('input').checked = Boolean(step.focusedView?.enabled);
    this.dom.guideSummary.textContent = guide
      ? `${guide.title} · ${guide.linkedSource ? t('linked') : t('local')} · ${tn(this.steps.length, '{count} step', '{count} steps')}`
      : '';
  }

  // A guide with no steps needs a first capture or import; otherwise the
  // canvas is waiting for a step to be selected or to have an image.
  showCanvasEmpty() {
    this.dom.canvasEmpty.textContent = this.steps.length
      ? t('Select an image step to edit annotations.')
      : t('Start recording or import images to begin.');
    this.dom.canvasEmpty.classList.remove('hidden');
  }

  async renderCanvas() {
    if (this.dom.canvas) this.dom.canvas.tabIndex = -1;
    const step = this.currentStep;
    const token = ++this.imageLoadToken;
    if (this.syncCanvasMode()) {
      this.syncToolbar();
      this.renderFlowchart();
      return;
    }
    this.canvas.setTool(this.currentTool);
    this.canvas.setZoom(this.currentZoom);
    this.syncToolbar();
    if (!step || !step.image) {
      this.canvas.setImage(null, 0, 0);
      this.showCanvasEmpty();
      return;
    }
    this.dom.canvasEmpty.classList.add('hidden');
    const src = await api.step.imagePath({
      guideId: this.guideId,
      stepId: step.stepId,
      which: 'working',
    });
    if (token !== this.imageLoadToken) return;
    if (!src) {
      this.canvas.setImage(null, 0, 0);
      this.showCanvasEmpty();
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (token !== this.imageLoadToken) return;
      if (this.dom.canvas) this.dom.canvas.tabIndex = 0;
      this.canvas.setImage(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
      this.canvas.setAnnotations(step.annotations || []);
      this.canvas.setFocusedView(step.focusedView);
      this.canvas.setTool(this.currentTool);
      this.canvas.setZoom(this.currentZoom);
    };
    img.onerror = () => {
      if (token !== this.imageLoadToken) return;
      this.canvas.setImage(null, 0, 0);
      this.showCanvasEmpty();
    };
    img.src = src;
  }

  // ---- Flowcharts (core/flowchart.js, app/renderer/flowchart-editor.js) ----

  /**
   * Show the image tools or the flowchart tools, as the toolbar's
   * Image/Flowchart menu says. A step opens on its flowchart when the
   * flowchart is its main visual or it has no image. True for flowchart.
   */
  syncCanvasMode() {
    if (!this.dom.visualSelect) return false;
    const step = this.currentStep;
    if (step && this.canvasModeStepId !== step.stepId) {
      this.canvasModeStepId = step.stepId;
      const chart = window.StepForgeFlowchart?.hasFlowchart(step);
      this.canvasMode = chart && (step.flowchartPlacement !== 'block' || !step.image) ? 'flowchart' : 'image';
      this.flowEditor?.select(null);
    }
    const flowchart = Boolean(step) && this.canvasMode === 'flowchart';
    this.dom.visualSelect.value = flowchart ? 'flowchart' : 'image';
    this.dom.visualSelect.disabled = !step;
    this.dom.imageTools.hidden = flowchart;
    this.dom.flowTools.hidden = !flowchart;
    this.dom.flowPlacementSelect.hidden = !flowchart;
    this.dom.flowPlacementSelect.value = this.flowchartPlacement(step);
    this.dom.canvasWrap.hidden = flowchart;
    this.dom.flowSurface.hidden = !flowchart;
    this.dom.annotationsSection.hidden = flowchart;
    this.dom.flowSection.hidden = !flowchart;
    // Focused view crops the screenshot; it has nothing to do with the flowchart.
    this.dom.propertiesPane.classList.toggle('flowchart-mode', flowchart);
    return flowchart;
  }

  /** Where the step's flowchart goes in exports; a new one replaces the image only on a step without one. */
  flowchartPlacement(step = this.currentStep) {
    if (!step) return 'visual';
    if (step.flowchart) return step.flowchartPlacement === 'block' ? 'block' : 'visual';
    return step.image ? 'block' : 'visual';
  }

  setCanvasMode(mode) {
    this.canvasMode = mode === 'flowchart' ? 'flowchart' : 'image';
    this.renderCanvas();
  }

  flowchartEditor() {
    if (!this.flowEditor && typeof FlowchartEditor === 'function') {
      this.flowEditor = new FlowchartEditor(this.dom.flowSurface, {
        getGraph: () => this.currentStep?.flowchart || null,
        getSteps: () => this.flowchartStepRefs(),
        stepLabel: (number) => t('Step {number}', { number }),
        beforeChange: () => this.beginFlowchartChange(),
        changed: () => this.flowchartChanged(),
        onSelect: () => this.renderFlowchartProps(),
        onToolChange: () => this.syncFlowTools(),
      });
    }
    return this.flowEditor || null;
  }

  flowchartStepRefs() {
    const numbers = stepNumberMap(this.steps);
    return this.steps.map((s) => ({ stepId: s.stepId, number: numbers.get(s.stepId), title: s.title || '' }));
  }

  renderFlowchart() {
    const editor = this.flowchartEditor();
    if (!editor) return;
    editor.reset();
    this.syncFlowTools();
    this.renderFlowchartProps();
  }

  syncFlowTools() {
    const tool = this.flowEditor?.tool || 'select';
    for (const [name] of FLOW_TOOLS()) this.setPressed(this.dom[`flow-${name}`], name === tool);
    this.setPressed(this.dom.flowShapesBtn, !FLOW_TOOLS().some(([name]) => name === tool));
  }

  /** Before a flowchart edit: an undo snapshot, and the flowchart itself on its first edit. */
  beginFlowchartChange() {
    const step = this.currentStep;
    this.pushCanvasHistory();
    if (!step.flowchart) {
      step.flowchartPlacement = this.flowchartPlacement(step);
      step.flowchart = { nodes: [], edges: [] };
    }
    return step.flowchart;
  }

  flowchartChanged() {
    this.pendingSave = true;
    this.saveStepDebounced();
    this.renderFlowchartProps();
    if (this.currentStep?.flowchartPlacement === 'block') this.renderBlocksPanel();
  }

  setFlowchartPlacement(placement) {
    const step = this.currentStep;
    if (!step) return;
    this.pushCanvasHistory();
    step.flowchartPlacement = placement === 'block' ? 'block' : 'visual';
    if (!step.flowchart) step.flowchart = { nodes: [], edges: [] };
    this.pendingSave = true;
    this.saveStepDebounced();
    this.renderBlocksPanel();
  }

  /** Blocks → + Flowchart: the step's flowchart, shown as a block after its text. */
  addFlowchartBlock() {
    const step = this.currentStep;
    if (!step) return;
    if (!step.flowchart || step.flowchartPlacement !== 'block') this.setFlowchartPlacement('block');
    this.setCanvasMode('flowchart');
  }

  removeFlowchart() {
    const step = this.currentStep;
    if (!step?.flowchart) return;
    this.pushCanvasHistory();
    step.flowchart = null;
    this.pendingSave = true;
    this.saveStepDebounced();
    this.canvasMode = step.image ? 'image' : 'flowchart';
    this.renderCanvas();
    this.renderBlocksPanel();
    this.onToast(`${t('Flowchart removed.')} ${t('Press Ctrl+Z to undo.')}`);
  }

  /** The details pane while the flowchart is shown: the selected shape or arrow. */
  renderFlowchartProps() {
    const box = this.dom.flowProps;
    clearNode(box);
    const step = this.currentStep;
    const editor = this.flowEditor;
    if (!step || !editor) return;
    const graph = step.flowchart || { nodes: [], edges: [] };
    const sel = editor.selected;
    const item = sel && (sel.kind === 'node' ? graph.nodes : graph.edges).find((i) => i.id === sel.id);
    if (!item) {
      box.append(el('p.muted', {}, t('Pick a shape in the toolbar and click the canvas. Use Connect to draw arrows between shapes. Double-click a shape or arrow to change its text.')));
      return;
    }
    const live = () => (sel.kind === 'node' ? step.flowchart?.nodes : step.flowchart?.edges)?.find((i) => i.id === sel.id);
    const save = ({ props = false } = {}) => {
      this.pendingSave = true;
      this.saveStepDebounced();
      editor.render();
      if (step.flowchartPlacement === 'block') this.renderBlocksPanel();
      if (props) this.renderFlowchartProps();
    };
    const edit = (apply, options) => {
      editor.cb.beforeChange();
      const target = live();
      if (target) apply(target);
      save(options);
    };

    const label = el('input', { type: 'text', value: item.label || '', maxLength: sel.kind === 'node' ? 300 : 80 });
    let armed = false;
    label.addEventListener('focus', () => { armed = false; });
    label.addEventListener('input', () => {
      // One undo step per focus, not per key.
      if (!armed) { this.pushCanvasHistory(); armed = true; }
      const target = live();
      if (target) target.label = label.value;
      save();
    });
    box.append(labeledRow(sel.kind === 'node' ? t('Text') : t('Arrow label'), label));

    if (sel.kind === 'edge') {
      const style = makeSelect(item.style || 'arrow', [
        { value: 'arrow', label: t('Arrow') },
        { value: 'double', label: t('Double arrow') },
        { value: 'line', label: t('Line') },
        { value: 'dashed', label: t('Dashed arrow') },
        { value: 'dashedLine', label: t('Dashed line') },
        { value: 'dotted', label: t('Dotted line') },
      ]);
      style.addEventListener('change', () => edit((e) => {
        if (style.value === 'arrow') delete e.style;
        else e.style = style.value;
      }));
      box.append(labeledRow(t('Style'), style));
      return;
    }

    const shape = el('select', {}, FLOW_SHAPE_GROUPS().map(([group, shapes]) => el('optgroup', { label: group },
      shapes.map(([value, name]) => el('option', { value, selected: value === item.shape }, name)))));
    shape.addEventListener('change', () => edit((n) => { n.shape = shape.value; }));
    box.append(labeledRow(t('Shape'), shape));

    // The same color menus as annotations. Each picker reads `style[field]` of the object it is given.
    const colors = [
      ['fill', t('Fill'), item.fill || window.StepForgeFlowchart.defaultColors(item.shape).fill],
      ['stroke', t('Border'), item.stroke || window.StepForgeFlowchart.defaultColors(item.shape).stroke],
      ['textColor', t('Text color'), item.textColor || '#111827'],
    ];
    for (const [field, name, value] of colors) {
      // Fill and border may be transparent (the picker offers that for a 'fill').
      const pickerField = field === 'textColor' ? 'textColor' : 'fill';
      const proxy = { id: `flow-${field}-${item.id}`, type: 'rect', style: { [pickerField]: value } };
      // Fill also offers Image…; picking a color takes the picture out.
      const fill = field === 'fill';
      box.append(labeledRow(name, this.colorPicker(proxy, (picked, { record = true } = {}) => {
        if (record) this.pushCanvasHistory();
        const target = live();
        if (target) {
          target[field] = picked;
          if (fill && target.image && record) delete target.image;
        }
        save({ props: fill && record && Boolean(item.image) });
      }, { field: pickerField, label: name, ...(fill ? { onImage: () => this.chooseFlowchartImage(sel.id), image: Boolean(item.image) } : {}) })));
    }

    // A picture inside the shape (Fill → Image…), clipped to it and never stretched.
    if (item.image) {
      const fit = makeSelect(item.image.fit || 'contain', [
        { value: 'contain', label: t('Fit inside') },
        { value: 'cover', label: t('Fill shape') },
      ]);
      fit.setAttribute('aria-label', t('Image fit'));
      fit.addEventListener('change', () => edit((n) => { if (n.image) n.image.fit = fit.value; }));
      box.append(labeledRow(t('Image'), el('div.row.flowchart-image-row', {}, fit,
        el('button', { type: 'button', onClick: () => edit((n) => { delete n.image; }, { props: true }) }, t('Remove image')))));
    }

    const refs = this.flowchartStepRefs();
    const target = makeSelect(item.stepId || '', [{ value: '', label: t('None') },
      ...refs.map((r) => ({ value: r.stepId, label: `${r.number}. ${r.title || t('Untitled step')}`.slice(0, 80) }))]);
    target.addEventListener('change', () => edit((n) => { n.stepId = target.value || null; }, { props: true }));
    box.append(labeledRow(t('Links to step'), target));
    if (item.stepId && this.stepMap.has(item.stepId)) {
      box.append(el('button', { type: 'button', onClick: () => this.selectStep(item.stepId) }, t('Go to step')));
    }
  }

  /**
   * Shape → Image → Choose image…: an image file, scaled down to at most
   * 800px and stored in the flowchart as a data URL.
   */
  async chooseFlowchartImage(nodeId) {
    let picked;
    try {
      picked = await api.step.pickImage({ purpose: 'shape' });
    } catch (err) {
      this.onToast(err.message || t('Could not choose an image.'), { error: true });
      return;
    }
    if (!picked) return;
    const img = new Image();
    img.src = `data:image/png;base64,${picked.imageBase64}`;
    try { await img.decode(); } catch { this.onToast(t('Could not choose an image.'), { error: true }); return; }
    const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let src = canvas.toDataURL('image/png');
    if (src.length > 1500000) {
      // A photo: JPEG on white is far smaller.
      const flat = document.createElement('canvas');
      flat.width = canvas.width;
      flat.height = canvas.height;
      const ctx = flat.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(canvas, 0, 0);
      src = flat.toDataURL('image/jpeg', 0.88);
    }
    const step = this.currentStep;
    if (!step?.flowchart?.nodes.some((n) => n.id === nodeId)) return;
    this.flowEditor.cb.beforeChange();
    const node = step.flowchart.nodes.find((n) => n.id === nodeId);
    node.image = { src, fit: node.image?.fit || 'contain' };
    this.pendingSave = true;
    this.saveStepDebounced();
    this.flowEditor.render();
    this.renderFlowchartProps();
    if (step.flowchartPlacement === 'block') this.renderBlocksPanel();
  }

  /** Toolbar → More shapes: every shape as a grid of icons. */
  openShapePalette() {
    const trigger = this.dom.flowShapesBtn;
    if (this.shapePalette) { this.closeShapePalette(); return; }
    const palette = el('div.flowchart-palette', { role: 'menu', 'aria-label': t('More shapes') },
      ...FLOW_SHAPE_GROUPS().map(([group, shapes]) => el('div.flowchart-palette-group', { role: 'group', 'aria-label': group },
        el('div.flowchart-palette-label', {}, group),
        el('div.flowchart-palette-grid', {}, shapes.map(([shape, name]) => el('button.flowchart-palette-item', {
          type: 'button', role: 'menuitem', title: name, 'aria-label': name,
          innerHTML: window.StepForgeFlowchart.shapeIcon(shape),
          onClick: () => { this.closeShapePalette(); this.flowchartEditor()?.setTool(shape); },
        }))))));
    const rect = trigger.getBoundingClientRect();
    Object.assign(palette.style, { left: `${Math.max(6, rect.left)}px`, top: `${rect.bottom + 4}px` });
    document.body.append(palette);
    const outside = (e) => { if (!palette.contains(e.target) && !trigger.contains(e.target)) this.closeShapePalette(); };
    const keys = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeShapePalette(); trigger.focus(); } };
    document.addEventListener('pointerdown', outside, true);
    palette.addEventListener('keydown', keys);
    this.shapePalette = { palette, outside };
    trigger.setAttribute('aria-expanded', 'true');
    palette.querySelector('button')?.focus();
  }

  closeShapePalette() {
    if (!this.shapePalette) return;
    document.removeEventListener('pointerdown', this.shapePalette.outside, true);
    this.shapePalette.palette.remove();
    this.shapePalette = null;
    this.dom.flowShapesBtn.setAttribute('aria-expanded', 'false');
  }

  /** AI ▾ → Create a flowchart: a flowchart of the whole guide, put on this step. */
  async generateFlowchartWithAi() {
    const step = this.currentStep;
    if (!step || this.aiRun) return;
    if (!this.isAiEnabled()) {
      this.onToast(t('Turn on AI in Settings first.'), { error: true });
      return;
    }
    if (step.flowchart?.nodes?.length && !(await confirmDialog(t('Replace this step’s flowchart with a new one from AI?')))) return;
    if (this.pendingSave) await this.flushStep();
    const run = { cancelled: false, progress: '' };
    this.aiRun = run;
    this.emitMeta();
    try {
      const result = await api.ai.flowchart({ guideId: this.guideId });
      if (run.cancelled) return;
      if (!result || !result.ok) {
        this.onToast(result?.reason || t('AI could not create a flowchart.'), { error: true });
        return;
      }
      if (this.currentStep !== step) return;
      this.pushCanvasHistory();
      step.flowchartPlacement = this.flowchartPlacement(step);
      step.flowchart = result.flowchart;
      await this.flushStep();
      this.canvasMode = 'flowchart';
      this.renderCanvas();
      this.renderBlocksPanel();
      this.onToast(`${t('AI created a flowchart.')} ${t('Press Ctrl+Z to undo.')}`);
    } catch (err) {
      if (!run.cancelled) this.onToast(err.message || t('AI could not create a flowchart.'), { error: true });
    } finally {
      if (this.aiRun === run) this.aiRun = null;
      this.emitMeta();
    }
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
        this.dom.annotationList.append(el('button.block-card.annotation-select', {
          type: 'button', 'aria-pressed': String(Boolean(selected)),
          dataset: { annId: ann.id },
          style: { cursor: 'pointer', borderColor: selected ? 'var(--accent)' : '' },
        },
        el('span.row', {}, el('strong', {}, ANNOTATION_TYPE_LABELS[ann.type] || ann.type),
          // Blurs StepForge added for a private detail say what they hide.
          el('span.muted', {}, ann.redact ? t('Private detail: {kind}', { kind: PRIVATE_DETAIL_LABELS[ann.redact.kind] || t('added by StepForge') }) : ann.text || ann.value || ''))));
      }
    }

    const selected = this.canvas.selected();
    clearNode(this.dom.annotationEditor);
    if (!selected) {
      this.dom.annotationEditor.append(el('div.muted', {}, t('Select an annotation to edit its style.')));
      return;
    }

    const style = selected.style || {};
    // A pen is only a pen: other types have no stroke to turn into one.
    const typeSelect = makeSelect(selected.type, [
      'rect', 'oval', 'line', ...(selected.type === 'pen' ? ['pen'] : []), 'arrow', 'curvedArrow',
      'text', 'tooltip', 'number', 'blur', 'highlight', 'magnify', 'cursor', 'spotlight',
    ].map((type) => ({ value: type, label: ANNOTATION_TYPE_LABELS[type] || type })));
    const valueInput = el('input', { type: 'number', value: Number.isFinite(selected.value) ? selected.value : '', placeholder: t('Value') });
    const strokeWidthInput = el('input', { type: 'number', min: 1, step: 1, value: style.strokeWidth || 3 });
    const fontSizeInput = el('input', { type: 'number', min: 0.01, max: 100, step: 0.01, value: window.StepForgeAnnotationProperties.percentage(style.fontSize || 0.022), 'aria-label': t('Font size (% of image height)') });
    const zoomInput = el('input', { type: 'number', min: 1, step: 0.1, value: selected.zoom || 2 });
    const radiusInput = el('input', { type: 'number', min: 1, step: 1, value: selected.radius || 8 });
    const props = window.StepForgeAnnotationProperties;
    const shapeInput = makeSelect(style.shape === 'oval' ? 'oval' : 'rect', [
      { value: 'rect', label: t('Rectangle') },
      { value: 'oval', label: t('Oval') },
    ]);
    const darknessInput = el('input', { type: 'number', min: 0, max: 100, step: 5, value: Math.round(props.spotlightDarkness(style) * 100) });
    const cornerRadiusInput = el('input', { type: 'number', min: 0, step: 1, value: Number.isFinite(style.cornerRadius) ? style.cornerRadius : props.SPOTLIGHT_CORNER_RADIUS });
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

    const rows = [el('button.skip-to-canvas', { type: 'button', disabled: !this.canvas.image, onClick: () => this.dom.canvas.focus() }, t('Focus screenshot')), labeledRow(t('Type'), typeSelect)];
    if (fields.has('text')) rows.push(labeledRow(t('Text'), textInput, { stacked: true }));
    if (fields.has('value')) rows.push(labeledRow(t('Value'), valueInput));
    if (fields.has('stroke')) rows.push(labeledRow(strokeLabel, this.colorPicker(selected, (stroke, { record = true } = {}) => {
      const ann = this.canvas.selected();
      if (!ann) return;
      if (record) this.pushCanvasHistory('annotation-stroke');
      apply({ style: { ...ann.style, stroke } });
    }, { field: 'stroke', label: strokeLabel })));
    if (fields.has('fill')) {
      rows.push(labeledRow(t('Fill'), this.fillPicker(selected, (fill, { record = true } = {}) => {
        const ann = this.canvas.selected();
        if (!ann) return;
        if (record) this.pushCanvasHistory('annotation-fill');
        apply({ style: { ...ann.style, fill } });
      })));
    }
    if (fields.has('strokeWidth')) rows.push(labeledRow(t('Stroke width'), strokeWidthInput));
    if (fields.has('fontSize')) rows.push(labeledRow(t('Font size (% of image height)'), fontSizeInput, { stacked: true }));
    if (fields.has('textColor')) {
      rows.push(labeledRow(t('Text color'), this.colorPicker(selected, (textColor, { record = true } = {}) => {
        const ann = this.canvas.selected();
        if (!ann) return;
        if (record) this.pushCanvasHistory('annotation-text-color');
        apply({ style: { ...ann.style, textColor } });
      }, { field: 'textColor', label: t('Text color') })));
    }
    if (fields.has('zoom')) rows.push(labeledRow(t('Zoom'), zoomInput));
    if (fields.has('radius')) rows.push(labeledRow(t('Radius'), radiusInput));
    if (fields.has('tail')) rows.push(labeledRow(t('Tail'), tailInput));
    if (fields.has('shape')) rows.push(labeledRow(t('Shape'), shapeInput));
    if (fields.has('darkness')) rows.push(labeledRow(t('Darkness (%)'), darknessInput));
    if (fields.has('cornerRadius') && style.shape !== 'oval') rows.push(labeledRow(t('Corner radius'), cornerRadiusInput));
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
          title: t('Overwrite the style of every “{type}” annotation across all steps in this guide with the style shown above. New ones you add will use it too.', { type: typeLabel }),
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
    strokeWidthInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, strokeWidth: Number(strokeWidthInput.value || 1) } });
    });
    fontSizeInput.addEventListener('input', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      const fontSize = window.StepForgeAnnotationProperties.fontSizeFromPercent(fontSizeInput.value);
      if (fontSize !== null) await apply({ style: { ...ann.style, fontSize } });
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
    shapeInput.addEventListener('change', () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      this.pushCanvasHistory('annotation-shape');
      apply({ style: { ...ann.style, shape: shapeInput.value } }, { rerender: true });
    });
    // Typing a number is one undo step: the first change after focusing records it.
    const recordOnFirstInput = (input, label) => {
      let armed = false;
      input.addEventListener('focus', () => { armed = true; });
      return () => {
        if (armed) this.pushCanvasHistory(label);
        armed = false;
      };
    };
    const recordDarkness = recordOnFirstInput(darknessInput, 'annotation-darkness');
    darknessInput.addEventListener('input', () => {
      const ann = this.canvas.selected();
      const value = Number(darknessInput.value);
      if (!ann || darknessInput.value === '' || !Number.isFinite(value)) return;
      recordDarkness();
      apply({ style: { ...ann.style, darkness: Math.min(100, Math.max(0, value)) / 100 } });
    });
    const recordCornerRadius = recordOnFirstInput(cornerRadiusInput, 'annotation-corner-radius');
    cornerRadiusInput.addEventListener('input', () => {
      const ann = this.canvas.selected();
      const value = Number(cornerRadiusInput.value);
      if (!ann || cornerRadiusInput.value === '' || !Number.isFinite(value)) return;
      recordCornerRadius();
      apply({ style: { ...ann.style, cornerRadius: Math.max(0, value) } });
    });
    tailInput.addEventListener('change', async () => {
      const ann = this.canvas.selected();
      if (!ann) return;
      await apply({ style: { ...ann.style, tail: tailInput.value } });
    });
  }

  /**
   * The Fill control: a swatch that opens a short list of fills under it. A
   * native color input can't offer "none", so this lists Transparent (for
   * types that may be empty), preset colors, and Custom color…, which opens
   * the system color picker. onPick(fill, { record }) applies a choice;
   * record is false for the live updates while the custom picker is open.
   */
  fillPicker(ann, onPick) {
    return this.colorPicker(ann, onPick, { field: 'fill', label: t('Fill') });
  }

  rememberAnnotationColor(color) {
    const helpers = window.StepForgeAnnotationProperties;
    const next = helpers.recentColor(this.settings?.editor?.recentColors, color);
    if (!helpers.colors([color]).length) return;
    this.settings ||= {};
    this.settings.editor ||= {};
    this.settings.editor.recentColors = next;
    // Serialize rapid selections so the last choice also wins on disk.
    this.colorSave = (this.colorSave || Promise.resolve()).catch(() => {}).then(() => api.settings.set({ keyPath: 'editor.recentColors', value: next })).catch(() => {
      this.onToast(t('Could not save recent colors.'));
    });
  }

  /**
   * …and, for a flowchart shape's fill, `onImage` adds Image… to the menu
   * (`image` is true while the shape shows a picture).
   */
  colorPicker(ann, onPick, { field = 'fill', label = t('Fill'), onImage = null, image = false } = {}) {
    const allowTransparent = field === 'fill' && CLEARABLE_FILL_TYPES.has(ann.type);
    const isNone = (fill) => !fill || fill === 'transparent';
    // A tooltip without a fill is drawn #1F2937 and text without a color white (canvas.js, core/raster.js).
    const fallback = { stroke: '#E5484D', textColor: '#FFFFFF' }[field] || '#1F2937';
    let current = isNone(ann.style?.[field]) ? (allowTransparent ? 'transparent' : fallback) : ann.style[field];
    const name = (fill) => (isNone(fill) ? t('Transparent') : fill.toUpperCase());
    const chip = (fill) => (isNone(fill) ? el('span.fill-chip.none') : el('span.fill-chip', { style: { background: fill } }));

    const swatch = el('button.fill-swatch', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    const showCurrent = () => {
      if (image) {
        swatch.replaceChildren(el('span.fill-chip.image', { innerHTML: IMAGE_ICON }), el('span.fill-name', {}, t('Image')));
        swatch.setAttribute('aria-label', `${label}: ${t('Image')}`);
        return;
      }
      swatch.replaceChildren(chip(current), el('span.fill-name', {}, name(current)));
      swatch.setAttribute('aria-label', `${label}: ${name(current)}`);
    };
    showCurrent();

    // The system picker behind Custom color…, kept out of sight under the swatch.
    const custom = el('input', { type: 'color', className: 'fill-custom-input', tabIndex: -1, 'aria-hidden': 'true' });
    let customStarted = false;
    const pickCustom = () => {
      current = custom.value;
      showCurrent();
      onPick(current, { record: !customStarted });
      customStarted = true;
    };
    custom.addEventListener('input', pickCustom);
    custom.addEventListener('change', () => { if (!customStarted) pickCustom(); this.rememberAnnotationColor(current); });

    const popover = el('div.fill-popover', { role: 'menu', 'aria-label': label, hidden: true });
    const wrapper = el('div.fill-picker', {}, swatch, popover, custom);
    const items = () => [...popover.querySelectorAll('[role^="menuitem"]')];
    const onOutside = (event) => {
      if (!wrapper.isConnected || !wrapper.contains(event.target)) close();
    };
    const close = ({ focus = false } = {}) => {
      document.removeEventListener('pointerdown', onOutside, true);
      if (popover.hidden) return;
      popover.hidden = true;
      swatch.setAttribute('aria-expanded', 'false');
      if (focus) swatch.focus();
    };
    const choose = (fill) => {
      close({ focus: true });
      this.rememberAnnotationColor(fill);
      if (fill.toLowerCase() === current.toLowerCase()) return;
      if (field === 'fill' && fill === 'transparent' && !isNone(current)) (this.clearedFills ||= new Map()).set(ann.id, current);
      current = fill;
      showCurrent();
      onPick(fill);
    };
    const open = () => {
      const entry = (fill) => ({ role: 'menuitemradio', 'aria-checked': String(fill.toLowerCase() === current.toLowerCase()), tabIndex: -1 });
      clearNode(popover);
      if (allowTransparent) {
        popover.append(el('button.fill-item', { type: 'button', ...entry('transparent'), onClick: () => choose('transparent') },
          chip('transparent'), t('Transparent')), el('hr'));
      }
      const groups = window.StepForgeAnnotationProperties.colorGroups([current, this.clearedFills?.get(ann.id), ...(this.settings?.editor?.recentColors || [])], this.brandColors);
      const section = (title, fills, empty) => el('div.fill-color-section', { role: 'group', 'aria-label': title },
        el('div.fill-section-label', {}, title),
        fills.length ? el('div.fill-presets', {}, fills.map((fill) => el('button.fill-preset', {
          type: 'button', ...entry(fill), title: fill, 'aria-label': fill, style: { background: fill }, onClick: () => choose(fill),
        }))) : el('div.fill-section-empty', {}, empty));
      popover.append(section(t('Default Colors'), groups.defaults), el('hr'),
        section(t('Recently Used Colors'), groups.recent, t('No other recent colors.')));
      if (this.brandColors) popover.append(el('hr'), section(t('Branding'), groups.brand, t('Brand colors already appear above.')));
      popover.append(el('hr'), el('button.fill-item', {
        type: 'button', role: 'menuitem', tabIndex: -1,
        onClick: () => {
          close({ focus: true });
          custom.value = isNone(current) ? this.clearedFills?.get(ann.id) || '#FFFFFF' : current;
          customStarted = false;
          custom.click();
        },
      }, t('Custom color…')));
      if (onImage) {
        popover.append(el('button.fill-item', {
          type: 'button', role: 'menuitem', tabIndex: -1,
          onClick: () => { close({ focus: true }); onImage(); },
        }, el('span.fill-chip.image', { innerHTML: IMAGE_ICON }), image ? t('Change image…') : t('Image…')));
      }
      popover.hidden = false;
      swatch.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onOutside, true);
      const list = items();
      (list.find((item) => item.getAttribute('aria-checked') === 'true') || list[0]).focus();
      popover.scrollIntoView({ block: 'nearest' });
    };

    swatch.addEventListener('click', () => (popover.hidden ? open() : close()));
    swatch.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && popover.hidden) { event.preventDefault(); open(); }
    });
    popover.addEventListener('keydown', (event) => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ focus: true });
      } else if (event.key === 'Tab') {
        close();
      } else if (move || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (at + move + list.length) % list.length;
        list[next].focus();
      }
    });
    return wrapper;
  }

  /** A new annotation's style: the guide's remembered style for its type over the defaults. */
  defaultStyleForTool(tool) {
    return { ...this.baseStyleForTool(tool), ...clone(this.guide?.annotationStyles?.[tool] || {}) };
  }

  baseStyleForTool(tool) {
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
      case 'spotlight': return {
        shape: 'rect',
        darkness: window.StepForgeAnnotationProperties.SPOTLIGHT_DARKNESS,
        cornerRadius: window.StepForgeAnnotationProperties.SPOTLIGHT_CORNER_RADIUS,
      };
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
    this.syncToolbar();
  }

  // Mirror currentTool and currentZoom onto their buttons, so the highlighted
  // button is always the mode the canvas is really in.
  syncToolbar() {
    for (const [key, node] of Object.entries(this.dom)) {
      if (key.startsWith('tool-')) this.setPressed(node, node.dataset.tool === this.currentTool);
    }
    this.syncZoomSelect();
  }

  // Show the current zoom in the select. Ctrl+= and Ctrl+- can reach zooms that
  // aren't listed (for example 175%), so such a zoom gets one extra option.
  syncZoomSelect() {
    const select = this.dom.zoomSelect;
    const value = this.currentZoom === 'fit' ? 'fit' : String(Number(this.currentZoom));
    for (const option of [...select.children]) {
      if (option.dataset.custom) option.remove();
    }
    if (![...select.children].some((option) => option.value === value)) {
      select.append(el('option', { value, dataset: { custom: 'yes' } }, `${Math.round(Number(value) * 100)}%`));
    }
    select.value = value;
  }

  setPressed(btn, pressed) {
    btn.classList.toggle('active', pressed);
    btn.setAttribute('aria-pressed', String(pressed));
  }

  // A drawing tool goes back to Select after one use unless Settings → Editor
  // says to keep it, so what was just drawn can be moved or resized at once.
  onCanvasToolUsed() {
    if (this.settings?.editor?.returnToSelect === false || this.currentTool === 'select') return;
    this.setTool('select');
  }

  setZoom(mode) {
    this.currentZoom = mode;
    this.canvas.setZoom(mode);
    this.canvas.applyZoom();
    this.syncToolbar();
  }

  applyZoomShortcut(kind) {
    if (this.canvasMode === 'flowchart' && this.flowEditor && this.currentStep) {
      const zoom = this.flowEditor.zoom;
      this.flowEditor.setZoom(kind === 'in' ? zoom * 1.25 : kind === 'out' ? zoom / 1.25 : 1);
      return true;
    }
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
   *   { type: 'multi-step', steps, after, annotationStyles? }
   *                                full clones of several steps, restored by id
   *                                with no images; `after` is each step's
   *                                stepFingerprint() right after the edit, to
   *                                spot later changes. See multiStepRecord().
   *                                annotationStyles: the guide's remembered
   *                                styles to put back (applyStyleAcross).
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
    // The guide's remembered annotation styles (Apply style to the entire guide).
    let stylesReplaced;
    if (record.annotationStyles !== undefined && this.guide) {
      stylesReplaced = clone(this.guide.annotationStyles || {});
      this.guide.annotationStyles = clone(record.annotationStyles);
      try {
        await this.saveGuideEdits();
      } catch (err) {
        this.guide.annotationStyles = stylesReplaced;
        stylesReplaced = undefined;
        error = err;
      }
    }
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
    if (!saved.length && stylesReplaced === undefined) return null;
    const inverse = this.multiStepRecord(replaced, saved);
    if (stylesReplaced !== undefined) inverse.annotationStyles = stylesReplaced;
    if (!failed.length && (stylesReplaced !== undefined || record.annotationStyles === undefined)) return inverse;
    // Some of the record was put back and some was not. What was put back can
    // be redone; the rest stays on this stack, so pressing the key again
    // retries just that and no earlier state is lost.
    const rest = { ...record, steps: failed };
    if (stylesReplaced !== undefined) delete rest.annotationStyles;
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
    // Undo is an intentional new edit of the current copy, not an autosave
    // based on the old revision captured in the history record.
    step.revision = this.stepMap.get(step.stepId)?.revision ?? step.revision;
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
      saved = await api.step.save({ guideId: this.guideId, step, baseStep: this.savedStepBaselines?.get(step.stepId) });
    } catch (err) {
      this.pendingSave = true;
      this.saveError = (err && err.message) || t('Save failed');
      this.emitMeta();
      this.onToast(t('Could not save this step — your changes are kept. Retrying…'), { error: true });
      return null;
    }
    this.pendingSave = false;
    this.saveError = null;
    const mergedOutsideChange = saved.revision > (step.revision || 0) + 1;
    const committed = this.commitSavedStep(saved, { replaceBlocks: mergedOutsideChange });
    if (mergedOutsideChange) this.renderAll();
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
    this.savedStepBaselines ||= new Map();
    this.savedStepBaselines.set(saved.stepId, clone(saved));
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

  async saveGuideEdits() {
    const saved = await api.guide.save({ guide: this.guide, baseGuide: this.savedGuideBaseline });
    if (saved?.guideId) {
      this.guide = saved;
      this.savedGuideBaseline = clone(saved);
    }
    return saved;
  }

  async flushGuide() {
    while (this.linkedSaveInFlight) await this.linkedSaveInFlight; // see flushStep
    if (!this.guide) return;
    try {
      await this.saveGuideEdits();
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

  /** Explicit optimization: estimate first, then apply to those exact images. */
  async optimizeImages() {
    if (!this.guideId) return;
    if (this.pendingSave) await this.flushStep();
    if (this.pendingGuideSave) await this.flushGuide();
    if (this.pendingSave || this.pendingGuideSave) {
      this.onToast(t('Save your changes before optimizing guide images.'), { error: true });
      return;
    }
    const guideId = this.guideId;
    let estimate = null;
    let closed = false;
    const status = el('p', { role: 'status', 'aria-live': 'polite' }, t('Estimating image savings…'));
    const errors = el('p.muted', { hidden: true });
    const showErrors = (report) => {
      errors.hidden = !report.errors.length;
      errors.textContent = tn(report.errors.length, '{count} image could not be optimized.', '{count} images could not be optimized.');
    };
    const cancel = el('button', { type: 'button', onClick: () => { closed = true; close(); } }, t('Close'));
    const again = el('button', { type: 'button', disabled: true, onClick: () => calculate() }, t('Estimate again'));
    const apply = el('button.primary', { type: 'button', disabled: true, onClick: async () => {
      if (!estimate) return;
      apply.disabled = true;
      again.disabled = true;
      status.textContent = t('Optimizing guide images…');
      try {
        const report = await api.guide.optimizeImages({ guideId, dryRun: false, expectedHash: estimate.estimateHash });
        const message = t('Saved {saved}.', { saved: formatBytes(report.savedBytes) });
        status.textContent = message;
        showErrors(report);
        if (this.guideId === guideId) await this.reload(this.selectedStepId);
        if (closed) this.onToast(message);
      } catch (error) {
        status.textContent = error.message;
        if (closed) this.onToast(error.message, { error: true });
      } finally {
        estimate = null;
        again.disabled = false;
      }
    } }, t('Optimize'));
    const { close } = openModal({
      title: t('Optimize guide images'),
      body: el('div', {},
        el('p.muted', {}, t('A snapshot is saved before applying. Images change only when you choose Optimize.')),
        status, errors),
      footer: [cancel, again, apply], initialFocus: cancel,
      onClose: () => { closed = true; },
    });
    const calculate = async () => {
      estimate = null;
      again.disabled = true;
      apply.disabled = true;
      status.textContent = t('Estimating image savings…');
      try {
        const report = await api.guide.optimizeImages({ guideId, dryRun: true });
        if (closed) return;
        estimate = report;
        status.textContent = report.savedBytes > 0
          ? tn(report.proposedImages, 'Save {saved} by optimizing {count} image ({before} → {after}).', 'Save {saved} by optimizing {count} images ({before} → {after}).',
            { saved: formatBytes(report.savedBytes), before: formatBytes(report.bytesBefore), after: formatBytes(report.bytesAfter) })
          : t('No smaller images were found.');
        showErrors(report);
        apply.disabled = !(report.savedBytes > 0);
      } catch (error) {
        status.textContent = error.message;
      } finally {
        again.disabled = false;
      }
    };
    await calculate();
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
    // Page Down, search or Move to… can reach a substep that is folded away: unfold the steps above it.
    const collapsed = this.collapsedSteps();
    for (let parent = this.stepMap.get(stepId).parentStepId, seen = 0; parent && seen < this.steps.length; parent = this.stepMap.get(parent)?.parentStepId, seen++) {
      collapsed.delete(parent);
    }
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
    const guideId = this.guideId;
    const draft = await dialogs.showAddStepDialog({ onChooseImage: () => api.step.pickImage() });
    if (!draft) return;
    const step = await api.step.add({
      guideId,
      fields: { kind: 'empty', title: draft.title || t('Untitled step'), status: 'todo' },
      ...(draft.image ? { imageBase64: draft.image.imageBase64, size: draft.image.size } : {}),
    });
    if (this.guideId === guideId) await this.reload(step.stepId);
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
    copy.title = copy.title ? t('{title} copy', { title: copy.title }) : t('Untitled step copy');
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
    const ok = await this.confirmDelete(t('Delete “{title}”?', { title: step.title || t('Untitled step') }), t('Delete step'));
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
          label: parentId ? t('Substep of {step}', { step: nameOf(parentId) }) : t('Top level'),
        });
      }
      positions.push({
        value: String(gap),
        label: gap === 0 ? t('At the top') : t('After {step}', { step: nameOf(order[gap - 1]) }),
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
    // Rows are only the visible steps: a gap below a collapsed step lands after its folded substeps.
    const before = gap < rows.length ? this.steps.findIndex((step) => step.stepId === rows[gap].dataset.stepId) : -1;
    const moved = outline.moveSubtree(this.steps.map((s) => s.stepId), parentOf, drag.stepId, before >= 0 ? before : this.steps.length, hint);
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
    const trigger = event.currentTarget || event.target;
    const rect = trigger.getBoundingClientRect();
    const session = (await api.capture.state())?.active;
    const items = [
      { label: t('Capture full screen'), action: () => this.captureStep('fullscreen') },
      { label: t('Capture window'), action: () => this.captureStep('window') },
      { label: t('Capture region'), action: () => this.captureStep('region') },
      'sep',
      { label: t('Paste image as step'), action: () => this.pasteClipboardStep() },
      { label: t('Import images…'), action: () => this.importImageSteps() },
    ];
    if (!session) {
      items.push('sep', { label: t('Start capture session (hotkey)'), action: () => this.startCaptureSession() });
    }
    contextMenu(rect.left, rect.bottom + 4, items, { trigger });
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

  /**
   * Share → Copy to clipboard: the whole guide with its screenshots, for
   * mail, chat and documents. The main process checks for private details
   * first, as publishing does; blurs it adds are in the copy.
   */
  async copyToClipboard() {
    if (!this.guideId || this.copyingToClipboard) return;
    const guideId = this.guideId;
    this.copyingToClipboard = true;
    try {
      // A window shows each stage (checking, building, copying) and the result.
      const result = await dialogs.showCopyToClipboardDialog({
        guideTitle: this.guide?.title || t('This guide'),
        run: async (onProgress) => {
          const stop = api.guide.onCopyProgress((update) => { if (update?.guideId === guideId) onProgress(update); });
          try {
            await this.saveAll();
            return await api.guide.copyToClipboard({ guideId });
          } finally {
            stop();
          }
        },
      });
      // Blurs the check added are in the guide now; show them.
      if (result?.review?.added && this.guideId === guideId) await this.reload(this.selectedStepId);
    } finally {
      this.copyingToClipboard = false;
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
        await this.saveGuideEdits();
        this.onToast(t('Placeholders saved.'));
      },
    });
  }

  async openGuideInfo() {
    if (!this.guide) return;
    const description = await api.guide.descriptionToMarkdown({ html: this.guide.descriptionHtml || '' });
    const cloud = await api.cloud.status().catch(() => null);
    const cloudConnected = Boolean(cloud?.connected && ['google', 'onedrive', 'dropbox', 'webdav'].includes(cloud.provider)
      && cloud.providers?.[cloud.provider]?.available !== false);
    await dialogs.showGuideInfoDialog({
      cloudConnected,
      values: {
        ...this.guide.metadata,
        description,
        sharingEnabled: this.guide.cloud?.sharingEnabled !== false,
      },
      reviewDefaultDays: this.settings?.library?.reviewAfterDays,
      onSave: async ({ description: markdown, sharingEnabled, ...metadata }) => {
        this.guide.metadata = metadata;
        // Unchanged text keeps the stored HTML, including anything Markdown can't express.
        if (markdown !== description) {
          this.guide.descriptionHtml = await api.guide.descriptionFromMarkdown({ markdown });
        }
        this.guide.cloud = { ...(this.guide.cloud || {}), sharingEnabled };
        await this.saveGuideEdits();
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
        const guideId = this.guideId;
        const ok = await confirmDialog(t('Remove every cloud snapshot for this guide? This also turns off cloud sync for the guide. The local guide is kept.'), { danger: true, okLabel: t('Remove cloud copies') });
        if (!ok) return;
        try {
          await api.cloud.deleteGuideSnapshots({ guideId });
          if (this.guideId === guideId) this.guide.cloud = { ...(this.guide.cloud || {}), sharingEnabled: false };
          this.onToast(t('Cloud copies removed.'));
          return true;
        } catch (err) {
          // Removal opts out before deleting remote files. A partial failure
          // must not let the dialog's next Save silently opt the guide back in.
          const fresh = await api.guide.get({ guideId }).catch(() => null);
          if (fresh?.guide?.cloud?.sharingEnabled === false) {
            if (this.guideId === guideId) this.guide.cloud = { ...(this.guide.cloud || {}), sharingEnabled: false };
            this.onToast(err.message);
            return { sharingEnabled: false };
          }
          this.onToast(err.message);
          return false;
        }
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
      // The guide remembers the style, so annotations of this type added later match.
      if (this.pendingGuideSave) await this.flushGuide();
      const stylesBefore = clone(this.guide.annotationStyles || {});
      this.guide.annotationStyles = { ...stylesBefore, [source.type]: patch };
      try {
        await this.saveGuideEdits();
      } catch (err) {
        this.guide.annotationStyles = stylesBefore;
        this.onToast(t('Could not save the style: {error}', { error: err?.message || err }), { error: true });
        return;
      }
      for (const step of this.steps) {
        const touched = restyle(step);
        if (touched || step.stepId === this.currentStep?.stepId) {
          const saved = await api.step.save({ guideId: this.guideId, step });
          if (touched) after.push(saved);
        }
      }
      const undo = this.pushStyleHistory(before, after, stylesBefore);
      await this.reload(this.selectedStepId);
      this.onToast(`${t('Style applied to all “{type}” annotations in the guide, and new ones will use it.', { type: ANNOTATION_TYPE_LABELS[source.type] || source.type })}${undo}`);
    }
  }

  /**
   * One undo step for a style applied to several steps, and for the guide's
   * remembered styles as they were before (annotationStyles), if given.
   * Returns the toast hint, or '' if nothing changed.
   */
  pushStyleHistory(before, after, annotationStyles) {
    if (!before.length && annotationStyles === undefined) return '';
    const record = this.multiStepRecord(before, after);
    if (annotationStyles !== undefined) record.annotationStyles = annotationStyles;
    this.pushCanvasHistory(record);
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
        if (next.language !== settings.language) {
          let saved = false;
          try {
            if (this.pendingSave || this.pendingGuideSave) await this.saveAll();
            saved = !this.pendingSave && !this.pendingGuideSave;
          } catch { /* Keep the form and its language selection for a retry. */ }
          if (!saved) {
            this.onToast(t('Your guide could not be saved. Your language choice is still selected; try Save again.'), { error: true });
            return false;
          }
        }
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

  // Export opens a dialog after loading its formats, templates and settings.
  // If any of that fails, say why instead of doing nothing.
  async openExportDialog() {
    try {
      return await this.showExport();
    } catch (err) {
      this.onToast(t('Couldn’t open Export: {error}', { error: err?.message || err }), { error: true, ms: 8000 });
      return undefined;
    }
  }

  async showExport() {
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
        this.onToast(t('Template “{name}” saved.', { name }));
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
        if (result && result.file) this.onToast(t('Exported {format}.', { format }));
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
      await dialogs.showInfoDialog(t('Linked Guide'), t('This guide is stored locally and is not linked to a shared archive.'));
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
      { kind: 'cmd', label: t('Copy to clipboard'), description: t('Copy the guide with its screenshots'), action: () => this.copyToClipboard() },
      { kind: 'cmd', label: t('Optimize guide images'), action: () => this.optimizeImages() },
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
    if (!(await this.settlePendingSave())) throw new Error(t('This step’s changes could not be saved, so nothing was replaced.'));
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
    this.onToast(tn(record.steps.length, 'Restored {count} step.', 'Restored {count} steps.'));
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
    this.onToast(tn(record.steps.length, 'Deleted {count} step.', 'Deleted {count} steps.'));
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
    const ok = await confirmDialog(t('Crop the working image to the selected area?'), { title: t('Crop image'), okLabel: t('Crop') });
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
        // Select "Link" so the address can be typed over it; the link turns
        // into a real one when the caret leaves it (linkifyDescription).
        const sel = window.getSelection();
        const node = sel.focusNode;
        if (node && node.nodeType === Node.TEXT_NODE && sel.focusOffset >= 5) {
          const range = document.createRange();
          range.setStart(node, sel.focusOffset - 5);
          range.setEnd(node, sel.focusOffset - 1);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        break;
      }
      case 'removeFormat':
        document.execCommand('removeFormat');
        break;
      case 'insertStep':
        this.openStepLinkMenu();
        return;
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

  /**
   * Description → Step: pick a step and insert a link to it, shown as
   * "Step 3". The link keeps the step's permanent ID (href="step:<id>"), so
   * the number follows the step when steps move; exports renumber it too.
   */
  openStepLinkMenu() {
    const editor = this.dom.descEditor;
    const trigger = this.dom.richToolbar.querySelector('[data-action="insertStep"]');
    // The caret as a text offset: an autosave may re-render the description
    // while the menu is open, which would strand a saved Range.
    const selection = window.getSelection();
    let caret = null;
    if (selection.rangeCount && editor.contains(selection.anchorNode)) {
      const before = document.createRange();
      before.selectNodeContents(editor);
      before.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
      caret = before.toString().length;
    }
    const numbers = stepNumberMap(this.steps);
    const items = this.steps
      .filter((s) => s.stepId !== this.currentStep?.stepId)
      .map((s) => ({
        label: `${numbers.get(s.stepId)}. ${s.title || t('Untitled step')}`.slice(0, 90),
        action: () => this.insertStepLink(s.stepId, numbers.get(s.stepId), caret),
      }));
    if (!items.length) {
      this.onToast(t('Add another step first.'));
      return;
    }
    const rect = trigger.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom + 4, items, { trigger });
  }

  insertStepLink(stepId, number, caret) {
    const editor = this.dom.descEditor;
    if (!this.currentStep) return;
    editor.focus();
    // Put the caret back at its text offset (or at the end).
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    if (caret != null) {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let left = caret;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (left <= node.length) { range.setStart(node, left); range.collapse(true); break; }
        left -= node.length;
      }
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const label = escapeHtml(t('Step {number}', { number }));
    document.execCommand('insertHTML', false, `<a href="step:${stepId}" data-step-id="${stepId}">${label}</a>&nbsp;`);
    this.currentStep.descriptionHtml = editor.innerHTML;
    this.pendingSave = true;
    this.saveStepDebounced();
  }

  /** Show each description step link with its target's current number. */
  refreshStepLinks() {
    const numbers = stepNumberMap(this.steps);
    const links = [this.dom.descEditor, this.dom.descPreview].flatMap((box) => [...(box?.querySelectorAll?.('a[data-step-id]') || [])]);
    for (const link of links) {
      const number = numbers.get(link.dataset.stepId);
      const text = number ? link.textContent.replace(/\d+(?:\.\d+)*(?!.*\d)/, number) : link.textContent;
      if (text !== link.textContent) link.textContent = text;
      link.classList.toggle('missing-step', !number);
      link.title = number ? t('Ctrl+click to open this step.') : t('This step was deleted.');
    }
    for (const link of this.dom.descEditor.querySelectorAll?.('a[href]:not([data-step-id])') || []) {
      link.title = t('Ctrl+click to open this link.');
    }
  }

  /**
   * Rich text: turn typed [text](https://…) and bare web addresses into real
   * links, except the one the caret is still in. A bare address becomes a
   * link once a space follows it. `caret: false` converts everything (the
   * editor lost focus).
   * True when something changed.
   */
  linkifyDescription({ caret = true } = {}) {
    const editor = this.dom.descEditor;
    const sel = window.getSelection();
    const caretNode = caret && sel.rangeCount && sel.isCollapsed ? sel.focusNode : null;
    const caretOffset = caretNode ? sel.focusOffset : -1;
    const pattern = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|((?:https?:\/\/|www\.)[^\s<]*[^\s<.,;:!?)\]'"])/g;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest('a, code, pre')) nodes.push(node);
    }
    let changed = false;
    for (const node of nodes) {
      const text = node.data;
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text))) {
        const start = match.index;
        const end = start + match[0].length;
        const bare = Boolean(match[3]);
        if (node === caretNode && !bare && caretOffset > start && caretOffset < end) continue;
        if (bare) {
          // A bare address is done once a space follows (after any closing
          // punctuation), or at the end of the text once the caret has left.
          const tail = /^[.,;:!?)\]'"]*(\s|$)/.exec(text.slice(end));
          if (!tail || (tail[1] === '' && node === caretNode) || (node === caretNode && caretOffset >= start && caretOffset <= end)) continue;
        }
        const href = bare ? (match[3].startsWith('www.') ? `https://${match[3]}` : match[3]) : match[2];
        const after = node.splitText(end);
        const linkText = node.splitText(start);
        const link = document.createElement('a');
        link.href = href;
        link.textContent = bare ? match[3] : match[1];
        linkText.replaceWith(link);
        if (node === caretNode && caretOffset >= end) {
          const range = document.createRange();
          range.setStart(after, caretOffset - end);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        changed = true;
        break; // `node` now ends before the link; the rest is in `after`.
      }
    }
    // Text after a new link may hold another one.
    if (changed) this.linkifyDescription({ caret });
    return changed;
  }

  linkifyAndSave(options) {
    if (!this.currentStep || this.descriptionMode() !== 'rich' || !this.linkifyDescription(options)) return;
    this.currentStep.descriptionHtml = this.dom.descEditor.innerHTML;
    this.pendingSave = true;
    this.saveStepDebounced();
  }

  // ---- Description format: Rich text or Markdown ----

  /** 'markdown' for a description written in Markdown (it keeps its source), else 'rich'. */
  descriptionMode(step = this.currentStep) {
    return typeof step?.descriptionMarkdown === 'string' ? 'markdown' : 'rich';
  }

  /** Markdown as the sanitized HTML that is stored and exported. */
  markdownToHtml(source) {
    const markdown = window.StepForgeMarkdown;
    const sanitize = window.StepForgeSanitize;
    return markdown && sanitize ? sanitize.sanitizeHtml(markdown.render(source)) : '';
  }

  /** Show the rich-text editor, or the Markdown source (or its preview). */
  syncDescriptionMode() {
    if (!this.dom.descModeSelect) return;
    const step = this.currentStep;
    const markdown = this.descriptionMode(step) === 'markdown';
    const previewing = markdown && Boolean(this.descPreviewing);
    this.dom.descModeSelect.value = markdown ? 'markdown' : 'rich';
    this.dom.descModeSelect.disabled = !step;
    this.dom.richToolbar.hidden = markdown;
    this.dom.descEditor.hidden = markdown;
    this.dom.descSource.hidden = !markdown || previewing;
    this.dom.descPreview.hidden = !previewing;
    this.dom.descPreviewBtn.hidden = !markdown;
    this.dom.descPreviewBtn.classList.toggle('active', previewing);
    this.dom.descPreviewBtn.setAttribute('aria-pressed', String(previewing));
    if (markdown && document.activeElement !== this.dom.descSource) this.dom.descSource.value = step.descriptionMarkdown;
    if (previewing) this.dom.descPreview.innerHTML = step.descriptionHtml || '';
  }

  /**
   * Description → Rich text / Markdown. Switching keeps the content: rich text
   * becomes its Markdown, and Markdown is already shown as rich text.
   */
  async setDescriptionMode(mode) {
    const step = this.currentStep;
    if (!step || mode === this.descriptionMode(step)) return;
    this.pushCanvasHistory('description');
    if (mode === 'markdown') {
      try {
        step.descriptionMarkdown = await api.step.descriptionToMarkdown({ html: step.descriptionHtml || '' });
      } catch (err) {
        this.onToast(err.message, { error: true });
        this.syncDescriptionMode();
        return;
      }
    } else {
      delete step.descriptionMarkdown;
      this.dom.descEditor.innerHTML = step.descriptionHtml || '';
    }
    this.descPreviewing = false;
    this.pendingSave = true;
    this.saveStepDebounced();
    this.syncDescriptionMode();
    this.refreshStepLinks();
  }

  onDocumentKeyDown(e) {
    if (e.target?.closest?.('.ctx-menu')) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.target?.closest?.('.step-control') || e.target?.closest?.('.annotation-select'))) return;
    if (!this.active || !this.guide) return;
    // Keys typed in a dialog are the dialog's: Delete, letters, Ctrl+Z and
    // the rest must not edit the guide behind it.
    if (typeof modalIsOpen === 'function' && modalIsOpen()) return;
    // Pickers and pane dividers own their plain keys. Ctrl/Cmd shortcuts still work.
    if (!e.ctrlKey && !e.metaKey && (e.target?.closest?.('.fill-picker') || e.target?.closest?.('.pane-divider'))) return;
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
    // While the flowchart is shown, plain keys are the flowchart's (and the
    // image tools' letter shortcuts are off).
    if (this.canvasMode === 'flowchart' && this.currentStep && !isEditableTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const onChart = document.activeElement === this.dom.flowSurface;
      if (onChart && this.flowEditor?.handleKey(e)) {
        e.preventDefault();
        return;
      }
      if (TOOL_KEYS[e.key.toLowerCase()]) return;
    }
    if (e.key === 'Escape' && !isEditableTarget(e.target)) {
      // Escape deselects, or puts down a drawing tool; Delete is the destructive key.
      if (this.selectedAnnotationId) {
        e.preventDefault();
        this.canvas.select(null);
        return;
      }
      if (this.currentTool !== 'select') {
        e.preventDefault();
        this.setTool('select');
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
      // Tool palette hotkeys (single keys, see TOOL_KEYS).
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
        if (this.canvas.selected?.()) this.pushCanvasHistory('delete-annotation');
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
          if (this.canvas.selected?.()) this.pushCanvasHistory('move-annotation');
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

function labeledRow(labelText, control, { stacked = false } = {}) {
  const label = el('label', {}, labelText);
  labelControl(label, control);
  return el('div.form-row', { className: `form-row${stacked ? ' stacked' : ''}` }, label, control);
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
