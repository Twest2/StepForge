'use strict';

const { newId, nowIso } = require('./util');
const { sanitizeHtml } = require('./sanitize');
const { blockText } = require('./blocks');

const SCHEMA_VERSION = 1;

const STEP_KINDS = ['image', 'empty', 'content'];
const STEP_STATUSES = ['todo', 'in-progress', 'done'];
const ANNOTATION_TYPES = [
  'rect', 'oval', 'line', 'arrow', 'text', 'tooltip', 'number',
  'blur', 'highlight', 'magnify', 'cursor',
];
const TEXTBLOCK_LEVELS = ['info', 'warn', 'error', 'success'];
const TEXTBLOCK_POSITIONS = [
  'before-title', 'after-title', 'before-image', 'after-image',
  'before-description', 'after-description',
];

const DEFAULT_ANNOTATION_STYLE = {
  stroke: '#E5484D',
  fill: 'transparent',
  textColor: '#FFFFFF',
  strokeWidth: 3,
  fontSize: 0.022, // fraction of image height
};

function createGuide(fields = {}) {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    guideId: fields.guideId || newId('guide'),
    title: fields.title || 'Untitled guide',
    descriptionHtml: sanitizeHtml(fields.descriptionHtml || ''),
    placeholders: { ...(fields.placeholders || {}) },
    metadata: {
      author: '',
      coAuthors: '',
      organization: '',
      ...(fields.metadata || {}),
    },
    flags: {
      focusedViewDefault: false,
      hideSkippedStepsInExports: true,
      ...(fields.flags || {}),
    },
    themeOverride: fields.themeOverride || 'system',
    createdAt: now,
    updatedAt: now,
    stepsOrder: [],
    favorite: Boolean(fields.favorite),
    linkedSource: fields.linkedSource || null,
    exportProfiles: { ...(fields.exportProfiles || {}) },
  };
}

function createStep(fields = {}) {
  let nextOrder = 1;
  const takeOrder = (block) => {
    const order = Number.isFinite(block && block.order) ? block.order : nextOrder;
    nextOrder = Math.max(nextOrder, order + 1);
    return order;
  };
  return {
    stepId: fields.stepId || newId('step'),
    parentStepId: fields.parentStepId || null,
    kind: STEP_KINDS.includes(fields.kind) ? fields.kind : 'image',
    status: STEP_STATUSES.includes(fields.status) ? fields.status : 'todo',
    title: fields.title || '',
    descriptionHtml: sanitizeHtml(fields.descriptionHtml || ''),
    hidden: Boolean(fields.hidden),
    skipped: Boolean(fields.skipped),
    forceNewPage: Boolean(fields.forceNewPage),
    focusedView: {
      enabled: false,
      zoom: 1,
      panX: 0.5,
      panY: 0.5,
      ...(fields.focusedView || {}),
    },
    image: fields.image || null, // { originalPath, workingPath, size:{width,height} }
    extraImages: fields.extraImages || [], // multi-image steps
    annotations: (fields.annotations || []).map(normalizeAnnotation),
    textBlocks: (fields.textBlocks || []).map((tb) => normalizeTextBlock(tb, takeOrder(tb))),
    codeBlocks: (fields.codeBlocks || []).map((cb) => normalizeCodeBlock(cb, takeOrder(cb))),
    tableBlocks: (fields.tableBlocks || []).map((tb) => normalizeTableBlock(tb, takeOrder(tb))),
    links: fields.links || [], // { id, label, targetStepId }
    captureMetadata: (fields.captureMetadata && typeof fields.captureMetadata === 'object' && !Array.isArray(fields.captureMetadata))
      ? { ...fields.captureMetadata }
      : null,
  };
}

function normalizeAnnotation(a) {
  const ann = {
    id: a.id || newId('ann'),
    type: ANNOTATION_TYPES.includes(a.type) ? a.type : 'rect',
    x: num(a.x, 0.25),
    y: num(a.y, 0.25),
    w: num(a.w, 0.2),
    h: num(a.h, 0.1),
    text: typeof a.text === 'string' ? a.text : '',
    style: { ...DEFAULT_ANNOTATION_STYLE, ...(a.style || {}) },
  };
  if (ann.type === 'number') ann.value = Number.isFinite(a.value) ? a.value : null;
  if (ann.type === 'magnify') ann.zoom = num(a.zoom, 2);
  if (ann.type === 'blur') ann.radius = num(a.radius, 8);
  if (ann.type === 'tooltip') ann.style.tail = a.style && a.style.tail ? a.style.tail : 'bottom';
  return ann;
}

function normalizeTextBlock(tb, order = null) {
  return {
    id: tb.id || newId('tb'),
    position: TEXTBLOCK_POSITIONS.includes(tb.position) ? tb.position : 'after-description',
    level: TEXTBLOCK_LEVELS.includes(tb.level) ? tb.level : 'info',
    order: Number.isFinite(tb.order) ? tb.order : order,
    title: tb.title || '',
    descriptionHtml: sanitizeHtml(tb.descriptionHtml || ''),
  };
}

function normalizeCodeBlock(cb, order = null) {
  return {
    id: cb.id || newId('cb'),
    order: Number.isFinite(cb.order) ? cb.order : order,
    language: typeof cb.language === 'string' ? cb.language : '',
    code: blockText(cb),
  };
}

function normalizeTableBlock(tb, order = null) {
  return {
    id: tb.id || newId('tbl'),
    order: Number.isFinite(tb.order) ? tb.order : order,
    rows: Array.isArray(tb.rows)
      ? tb.rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
      : [],
  };
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Throws with a descriptive message when the guide object is invalid. */
function validateGuide(guide) {
  const errors = [];
  if (!guide || typeof guide !== 'object') throw new Error('guide must be an object');
  if (guide.schemaVersion !== SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${guide.schemaVersion}`);
  if (!isNonEmptyString(guide.guideId)) errors.push('guideId missing');
  if (typeof guide.title !== 'string') errors.push('title must be a string');
  if (!Array.isArray(guide.stepsOrder)) errors.push('stepsOrder must be an array');
  else if (new Set(guide.stepsOrder).size !== guide.stepsOrder.length) errors.push('stepsOrder has duplicates');
  if (guide.placeholders && typeof guide.placeholders !== 'object') errors.push('placeholders must be an object');
  if (guide.metadata && typeof guide.metadata !== 'object') errors.push('metadata must be an object');
  if (errors.length) throw new Error(`invalid guide: ${errors.join('; ')}`);
  return guide;
}

function validateStep(step) {
  const errors = [];
  if (!step || typeof step !== 'object') throw new Error('step must be an object');
  if (!isNonEmptyString(step.stepId)) errors.push('stepId missing');
  if (!STEP_KINDS.includes(step.kind)) errors.push(`bad kind ${step.kind}`);
  if (!STEP_STATUSES.includes(step.status)) errors.push(`bad status ${step.status}`);
  if (step.kind === 'image' && step.image) {
    if (!isNonEmptyString(step.image.originalPath)) errors.push('image.originalPath missing');
    if (!step.image.size || !Number.isFinite(step.image.size.width) || !Number.isFinite(step.image.size.height)) {
      errors.push('image.size invalid');
    }
  }
  for (const a of step.annotations || []) {
    if (!ANNOTATION_TYPES.includes(a.type)) errors.push(`bad annotation type ${a.type}`);
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(a[k])) errors.push(`annotation ${a.id} ${k} not a number`);
    }
  }
  if (errors.length) throw new Error(`invalid step: ${errors.join('; ')}`);
  return step;
}

/** Fill defaults on objects loaded from disk (forward-compatible load). */
function normalizeGuide(raw) {
  const guide = { ...createGuide(raw), guideId: raw.guideId };
  guide.createdAt = raw.createdAt || guide.createdAt;
  guide.updatedAt = raw.updatedAt || guide.updatedAt;
  guide.stepsOrder = Array.isArray(raw.stepsOrder) ? [...raw.stepsOrder] : [];
  return guide;
}

function normalizeStep(raw) {
  return { ...createStep(raw), stepId: raw.stepId };
}

module.exports = {
  SCHEMA_VERSION,
  STEP_KINDS,
  STEP_STATUSES,
  ANNOTATION_TYPES,
  TEXTBLOCK_LEVELS,
  TEXTBLOCK_POSITIONS,
  DEFAULT_ANNOTATION_STYLE,
  createGuide,
  createStep,
  normalizeAnnotation,
  normalizeTextBlock,
  normalizeCodeBlock,
  normalizeTableBlock,
  validateGuide,
  validateStep,
  normalizeGuide,
  normalizeStep,
};
