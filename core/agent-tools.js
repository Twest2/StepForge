'use strict';

const { htmlToMarkdown } = require('../exporters/htmlmd');
const { markdownHtml } = require('./placeholder-markdown');
const { sanitizeHtml } = require('./sanitize');
const { renderScreenshotForAi, aiScreenshotSize } = require('./ai-image');
const { orderedBlocks, blockText } = require('./blocks');
const { placeholderText } = require('./placeholder-markdown');
const { ANNOTATION_TYPES, normalizeAnnotation } = require('./schema');
const { BUILT_IN_NAMES, cleanPlaceholderName, isValidPlaceholderName } = require('./ai-placeholders');
const { withParent, parentMap } = require('./step-outline');
const { Settings } = require('./settings');
const {
  normalizeAiBlock,
  mergeAiBlocks,
  splitPinnedParagraphs,
  withPinnedParagraphs,
  normalizeWhitespace,
} = require('./text-intel');

/**
 * The tools AI agents (Claude, Codex, any MCP app) get through `StepForge --mcp`.
 * Agents read guides, rewrite their text, make substeps, add placeholders and
 * draw annotations. They can't create or delete guides, steps, blocks,
 * placeholders, annotations or screenshots: every step comes from a real capture.
 */

// An agent may add this many blocks to a step per call; it can always call again.
const MAX_NEW_AGENT_BLOCKS = 5;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 20000;
const MAX_BLOCKS_PER_CALL = 20;
const MAX_ANNOTATIONS_PER_CALL = 20;
const MAX_PLACEHOLDER_VALUE_CHARS = 1000;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const INSTRUCTIONS = [
  'StepForge holds step-by-step guides a person recorded: each step is a screenshot of one click, with a marker where they clicked.',
  'You can read guides and rewrite their text: the guide title and description, and each step\'s title, description and blocks (notes, warnings, tips, code, tables).',
  'You can also make a step a substep of an earlier step (update_step parent_step_id), add placeholders (create_placeholder), and draw annotations such as rectangles, arrows and callouts on a screenshot (add_annotations).',
  'You cannot reorder steps, or create or delete guides, steps, blocks, placeholders, annotations or screenshots.',
  'To write a guide: call get_guide, then get_step for each step to see its screenshot, then update_step. Finish with update_guide for the guide\'s title and description.',
  'Step titles are short imperative actions ("Click Save", "Open Settings"). Descriptions are Markdown, 1–2 sentences per step.',
  'Placeholders: get_guide lists them. In descriptions and blocks, write [[Name]] where a placeholder\'s value would appear; keep titles in plain words. Create a placeholder only for a specific value that repeats, such as a product name, version, URL or course code.',
  'Annotations use pixel coordinates on the screenshot get_step returns. A red circle there is usually the person\'s click marker; don\'t duplicate it.',
  'Keep every [[placeholder]] token exactly as written. Polish text the person wrote rather than replacing its meaning.',
].join('\n');

class AgentError extends Error {}

const descriptionMarkdown = (html) => htmlToMarkdown(splitPinnedParagraphs(html).body).trim();

function blockForAgent(block) {
  if (block.kind === 'text') {
    return {
      id: block.id, kind: 'text', level: block.level || 'info', title: block.title || '',
      body: htmlToMarkdown(block.descriptionHtml || '').trim(),
    };
  }
  if (block.kind === 'code') return { id: block.id, kind: 'code', language: block.language || '', code: blockText(block) };
  return { id: block.id, kind: 'table', rows: Array.isArray(block.rows) ? block.rows : [] };
}

/** Capture details that are safe to share: never typed text, field values or OCR. */
function captureForAgent(meta) {
  if (!meta) return null;
  const out = {
    app: meta.appName || '',
    window: meta.windowTitle || '',
    element: meta.elementLabel ? `${meta.elementLabel}${meta.elementRole ? ` (${meta.elementRole})` : ''}` : '',
  };
  return out.app || out.window || out.element ? out : null;
}

/** Steps in guide order with their display numbers (1, 1.1, 2 …). */
function numberedSteps(store, guide) {
  const map = store.listSteps(guide.guideId);
  const numbers = new Map();
  const childCounts = new Map();
  let top = 0;
  const out = [];
  for (const id of guide.stepsOrder || []) {
    const step = map.get(id);
    if (!step) continue;
    let number;
    if (step.parentStepId && numbers.has(step.parentStepId)) {
      const n = (childCounts.get(step.parentStepId) || 0) + 1;
      childCounts.set(step.parentStepId, n);
      number = `${numbers.get(step.parentStepId)}.${n}`;
    } else {
      top += 1;
      number = String(top);
    }
    numbers.set(step.stepId, number);
    out.push({ step, number });
  }
  return out;
}

/** An annotation in the pixel space of the screenshot the agent is shown. */
function annotationForAgent(ann, shown) {
  const px = (frac, total) => Math.round(frac * total);
  const out = { id: ann.id, type: ann.type };
  if (ann.type === 'line' || ann.type === 'arrow') {
    out.from = [px(ann.x, shown.width), px(ann.y, shown.height)];
    out.to = [px(ann.x + ann.w, shown.width), px(ann.y + ann.h, shown.height)];
  } else {
    Object.assign(out, { x: px(ann.x, shown.width), y: px(ann.y, shown.height), width: px(ann.w, shown.width), height: px(ann.h, shown.height) });
  }
  if (ann.type === 'text' || ann.type === 'tooltip') out.text = ann.text || '';
  if (ann.type === 'number') out.value = ann.value;
  return out;
}

function stepForAgent(step, number) {
  const shown = step.image && step.image.size ? aiScreenshotSize(step.image.size) : null;
  return {
    step_id: step.stepId,
    number,
    parent_step_id: step.parentStepId || null,
    title: step.title || '',
    description: descriptionMarkdown(step.descriptionHtml),
    blocks: orderedBlocks(step).map(blockForAgent),
    has_screenshot: Boolean(step.image),
    ...(shown ? {
      screenshot_size: shown,
      annotations: (step.annotations || []).map((ann) => annotationForAgent(ann, shown)),
    } : {}),
    hidden: Boolean(step.hidden),
    skipped: Boolean(step.skipped),
    capture: captureForAgent(step.captureMetadata),
  };
}

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

function checkLength(value, max, what) {
  if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
    throw new AgentError(`${what} must be text of at most ${max} characters.`);
  }
}

/** An agent's annotation (pixels on the screenshot it was shown) as a stored one (fractions). */
function annotationFromAgent(item, shown, index) {
  const where = `annotations[${index}]`;
  if (!item || !ANNOTATION_TYPES.includes(item.type)) {
    throw new AgentError(`${where}: type must be one of ${ANNOTATION_TYPES.join(', ')}.`);
  }
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clampX = (v) => Math.min(Math.max(v, 0), shown.width) / shown.width;
  const clampY = (v) => Math.min(Math.max(v, 0), shown.height) / shown.height;
  const box = {};
  if (item.type === 'line' || item.type === 'arrow') {
    const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(finite);
    if (!ok(item.from) || !ok(item.to)) throw new AgentError(`${where}: a ${item.type} needs from: [x, y] and to: [x, y].`);
    box.x = clampX(item.from[0]);
    box.y = clampY(item.from[1]);
    box.w = clampX(item.to[0]) - box.x;
    box.h = clampY(item.to[1]) - box.y;
    if (Math.hypot(box.w * shown.width, box.h * shown.height) < 4) throw new AgentError(`${where}: the ${item.type} is too short.`);
  } else {
    if (![item.x, item.y, item.width, item.height].every(finite)) {
      throw new AgentError(`${where}: a ${item.type} needs x, y, width and height in pixels.`);
    }
    box.x = clampX(item.x);
    box.y = clampY(item.y);
    box.w = clampX(item.x + item.width) - box.x;
    box.h = clampY(item.y + item.height) - box.y;
    if (box.w * shown.width < 2 || box.h * shown.height < 2) throw new AgentError(`${where}: the ${item.type} is too small or outside the screenshot.`);
  }
  if ((item.type === 'text' || item.type === 'tooltip') && !String(item.text || '').trim()) {
    throw new AgentError(`${where}: a ${item.type} needs text.`);
  }
  if (item.type === 'number' && !Number.isInteger(item.value)) throw new AgentError(`${where}: a number needs an integer value.`);
  if (item.color !== undefined && !COLOR_RE.test(item.color)) throw new AgentError(`${where}: color must look like "#E5484D".`);
  const style = {};
  if (item.color) style.stroke = item.color;
  if (item.type === 'tooltip' && item.tail) style.tail = item.tail;
  for (const key of ['x', 'y', 'w', 'h']) box[key] = Math.round(box[key] * 1e6) / 1e6;
  return normalizeAnnotation({
    type: item.type,
    ...box,
    text: typeof item.text === 'string' ? item.text.slice(0, 300) : '',
    ...(item.type === 'number' ? { value: item.value } : {}),
    style,
  });
}

/**
 * Build the agent tools over a library.
 * - `store`: the GuideStore.
 * - `agentSettings()`: the current `ai.agents` settings, read fresh on every call.
 * - `onChange(guideId)`: called after each write, so the app can reload.
 */
function createAgentTools({ store, agentSettings, onChange = () => {} }) {
  const requireEnabled = () => {
    if (!agentSettings()?.enabled) {
      throw new AgentError('StepForge has AI agent access turned off. Ask the user to turn on Settings → AI → Let AI agents edit your guides, then try again.');
    }
  };
  const loadGuide = (guideId) => {
    if (typeof guideId !== 'string' || !store.guideExists(guideId)) throw new AgentError(`No guide with id "${guideId}". Call list_guides to find it.`);
    const guide = store.getGuide(guideId);
    if (store.isCaptureDraft(guide)) throw new AgentError(`No guide with id "${guideId}". Call list_guides to find it.`);
    return guide;
  };
  const loadStep = (guide, stepId) => {
    if (typeof stepId !== 'string' || !(guide.stepsOrder || []).includes(stepId)) {
      throw new AgentError(`Guide "${guide.guideId}" has no step "${stepId}". Call get_guide for its step ids.`);
    }
    return store.getStep(guide.guideId, stepId);
  };
  const numberOf = (guide, stepId) => (numberedSteps(store, guide).find((s) => s.step.stepId === stepId) || {}).number || '';
  const globalSettings = () => new Settings(store.settingsDir);
  const placeholderList = (values) => Object.entries(values || {}).map(([name, raw]) => {
    const value = placeholderText(raw);
    return { name, value: value.length > 300 ? `${value.slice(0, 299)}…` : value };
  });

  /** Re-read, change, and save with the revision just read; retry once if the app saved in between. */
  const saveWithRetry = (read, change, save) => {
    for (let attempt = 0; ; attempt += 1) {
      const current = read();
      try {
        return save(change(current), current.revision);
      } catch (err) {
        if (err && err.code === 'STEPFORGE_REVISION_CONFLICT' && attempt === 0) continue;
        throw err;
      }
    }
  };

  const tools = [
    {
      name: 'list_guides',
      description: 'List the guides in the StepForge library, newest first. Optionally filter by text in the title or description.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Only guides whose title or description contains this text.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many guides (default 50).' },
        },
        additionalProperties: false,
      },
      handler({ query = '', limit = 50 } = {}) {
        requireEnabled();
        const needle = normalizeWhitespace(query).toLowerCase();
        const guides = store.listGuides()
          .filter((g) => !needle || `${g.title} ${descriptionMarkdown(g.descriptionHtml)}`.toLowerCase().includes(needle))
          .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
          .map((g) => ({ guide_id: g.guideId, title: g.title, steps: (g.stepsOrder || []).length, updated_at: g.updatedAt }));
        return { content: [text(guides.length ? guides : 'No guides match.')] };
      },
    },
    {
      name: 'get_guide',
      description: 'Read a guide: its title, description, placeholders, and every step\'s text, blocks, parent and annotations, in order. Use get_step to see a step\'s screenshot.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { guide_id: { type: 'string' } },
        required: ['guide_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        return {
          content: [text({
            guide_id: guide.guideId,
            title: guide.title,
            description: descriptionMarkdown(guide.descriptionHtml),
            placeholders: {
              guide: placeholderList(guide.placeholders),
              global: placeholderList(globalSettings().getGlobalPlaceholders()),
              built_in: BUILT_IN_NAMES,
            },
            steps: numberedSteps(store, guide).map(({ step, number }) => stepForAgent(step, number)),
          })],
        };
      },
    },
    {
      name: 'get_step',
      description: 'Read one step and see its screenshot (blurred areas are already filled, and a marker shows where the person clicked).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          include_screenshot: { type: 'boolean', description: 'Attach the screenshot (default true).' },
        },
        required: ['guide_id', 'step_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, include_screenshot: includeScreenshot = true } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        const step = loadStep(guide, stepId);
        const content = [text(stepForAgent(step, numberOf(guide, stepId)))];
        if (includeScreenshot && step.image) {
          if (agentSettings()?.screenshots === false) {
            content.push(text('Screenshots are turned off in StepForge settings, so only the step text is available.'));
          } else {
            const png = renderScreenshotForAi(
              store.stepImagePath(guideId, stepId, 'working') || store.stepImagePath(guideId, stepId, 'original'),
              step.annotations,
            );
            if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
          }
        }
        return { content };
      },
    },
    {
      name: 'update_guide',
      description: 'Rewrite the guide\'s title and/or description (Markdown). Leave a field out to keep it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          title: { type: 'string', description: 'What the reader will get done, e.g. "Submit a lab in Canvas".' },
          description: { type: 'string', description: 'Markdown. 1–3 sentences introducing the guide.' },
        },
        required: ['guide_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, title, description } = {}) {
        requireEnabled();
        loadGuide(guideId);
        checkLength(title, MAX_TITLE_CHARS, 'title');
        checkLength(description, MAX_DESCRIPTION_CHARS, 'description');
        if (title === undefined && description === undefined) throw new AgentError('Give a title, a description, or both.');
        const saved = saveWithRetry(
          () => store.getGuide(guideId),
          (guide) => ({
            ...guide,
            ...(title !== undefined && normalizeWhitespace(title) ? { title: normalizeWhitespace(title) } : {}),
            ...(description !== undefined
              ? { descriptionHtml: sanitizeHtml(withPinnedParagraphs(guide.descriptionHtml, markdownHtml(description))) }
              : {}),
          }),
          (guide, revision) => store.saveGuide(guide, { expectedRevision: revision }),
        );
        onChange(guideId);
        return { content: [text({ guide_id: saved.guideId, title: saved.title, description: descriptionMarkdown(saved.descriptionHtml) })] };
      },
    },
    {
      name: 'update_step',
      description: 'Rewrite a step\'s title, description (Markdown) and blocks, or make it a substep. Leave a field out to keep it. '
        + 'Blocks with an "id" from get_step are rewritten in place; blocks without one are added (at most 5 per call). Blocks are never deleted.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          title: { type: 'string', description: 'A short imperative action, e.g. "Click Save".' },
          description: { type: 'string', description: 'Markdown. 1–2 sentences on what the person does.' },
          parent_step_id: {
            type: ['string', 'null'],
            description: 'Make this step a substep of an earlier step, or null to make it top-level. The parent must be the step right above it or one of that step\'s parents; steps are never reordered.',
          },
          blocks: {
            type: 'array',
            maxItems: MAX_BLOCKS_PER_CALL,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'An existing block\'s id, to rewrite it. Leave out to add a block.' },
                kind: { type: 'string', enum: ['text', 'code', 'table'] },
                level: { type: 'string', enum: ['info', 'warn', 'error', 'success'], description: 'Text blocks: info = note, warn = warning, error = important, success = tip.' },
                title: { type: 'string' },
                body: { type: 'string', description: 'Text blocks: Markdown.' },
                language: { type: 'string', description: 'Code blocks.' },
                code: { type: 'string', description: 'Code blocks.' },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Table blocks.' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
        },
        required: ['guide_id', 'step_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, title, description, blocks, parent_step_id: parentStepId } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        loadStep(guide, stepId);
        if (parentStepId !== undefined) {
          if (parentStepId !== null && typeof parentStepId !== 'string') throw new AgentError('parent_step_id must be a step id or null.');
          const steps = numberedSteps(store, guide).map(({ step }) => step);
          if (!withParent(steps.map((step) => step.stepId), parentMap(steps), stepId, parentStepId)) {
            throw new AgentError('That would break the step numbering. A substep\'s parent must be the step right above it, or one of that step\'s parents, and a step with later siblings can\'t leave its parent. Steps are never reordered.');
          }
        }
        checkLength(title, MAX_TITLE_CHARS, 'title');
        checkLength(description, MAX_DESCRIPTION_CHARS, 'description');
        if (blocks !== undefined && (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS_PER_CALL)) {
          throw new AgentError(`blocks must be a list of at most ${MAX_BLOCKS_PER_CALL} blocks.`);
        }
        if (title === undefined && description === undefined && !blocks?.length && parentStepId === undefined) {
          throw new AgentError('Give a title, a description, blocks, a parent_step_id, or any of them together.');
        }
        const normalized = (blocks || []).map((block) => normalizeAiBlock(block, { bodyToHtml: markdownHtml })).filter(Boolean);
        const saved = saveWithRetry(
          () => store.getStep(guideId, stepId),
          (step) => {
            const next = { ...step };
            if (title !== undefined && normalizeWhitespace(title)) next.title = normalizeWhitespace(title);
            if (parentStepId !== undefined) next.parentStepId = parentStepId || null;
            if (description !== undefined) {
              next.descriptionHtml = sanitizeHtml(withPinnedParagraphs(step.descriptionHtml, markdownHtml(description)));
            }
            if (normalized.length) {
              next.textBlocks = [...(step.textBlocks || [])].map((b) => ({ ...b }));
              next.codeBlocks = [...(step.codeBlocks || [])].map((b) => ({ ...b }));
              next.tableBlocks = [...(step.tableBlocks || [])].map((b) => ({ ...b }));
              mergeAiBlocks(next, normalized, { maxNew: MAX_NEW_AGENT_BLOCKS });
            }
            return next;
          },
          (step, revision) => store.saveStep(guideId, step, { expectedRevision: revision }),
        );
        onChange(guideId);
        return { content: [text(stepForAgent(saved, numberOf(store.getGuide(guideId), stepId)))] };
      },
    },
    {
      name: 'create_placeholder',
      description: 'Add a placeholder that guides can use as [[Name]]. "guide" placeholders belong to one guide; "global" ones are shared by every guide. Existing placeholders are never changed.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Letters, digits, spaces, _ . -; up to 40 characters, e.g. "Course_Code".' },
          value: { type: 'string', description: 'What [[Name]] becomes in exports. Global values may use Markdown.' },
          scope: { type: 'string', enum: ['guide', 'global'] },
          guide_id: { type: 'string', description: 'Required for a guide placeholder.' },
        },
        required: ['name', 'value', 'scope'],
        additionalProperties: false,
      },
      handler({ name, value, scope, guide_id: guideId } = {}) {
        requireEnabled();
        const clean = cleanPlaceholderName(name);
        if (!isValidPlaceholderName(clean)) {
          throw new AgentError(`"${name}" can't be a placeholder name. Use up to 40 letters, digits, spaces, _ . or -, and not a built-in name (${BUILT_IN_NAMES.join(', ')}).`);
        }
        checkLength(value, MAX_PLACEHOLDER_VALUE_CHARS, 'value');
        if (!String(value || '').trim()) throw new AgentError('value can\'t be empty.');
        if (scope !== 'guide' && scope !== 'global') throw new AgentError('scope must be "guide" or "global".');
        const settings = globalSettings();
        const globals = settings.getGlobalPlaceholders();
        const taken = (values) => Object.keys(values || {}).some((n) => n.toLowerCase() === clean.toLowerCase());
        if (taken(globals)) throw new AgentError(`A global placeholder [[${clean}]] already exists. Use it, or pick another name.`);
        if (scope === 'global') {
          settings.setGlobalPlaceholders({ ...globals, [clean]: { format: 'markdown', text: value } });
          return { content: [text(`Added the global placeholder [[${clean}]]. Write [[${clean}]] in any guide to use it.`)] };
        }
        const guide = loadGuide(guideId);
        if (taken(guide.placeholders)) throw new AgentError(`This guide already has [[${clean}]]. Use it, or pick another name.`);
        saveWithRetry(
          () => store.getGuide(guideId),
          (current) => {
            if (taken(current.placeholders)) throw new AgentError(`This guide already has [[${clean}]]. Use it, or pick another name.`);
            return { ...current, placeholders: { ...(current.placeholders || {}), [clean]: String(value) } };
          },
          (current, revision) => store.saveGuide(current, { expectedRevision: revision }),
        );
        onChange(guideId);
        return { content: [text(`Added [[${clean}]] to this guide. Write [[${clean}]] in its descriptions and blocks to use it.`)] };
      },
    },
    {
      name: 'add_annotations',
      description: 'Draw annotations on a step\'s screenshot: rect, oval, line, arrow, text, tooltip (a callout box), number (a numbered badge), blur, highlight, magnify, cursor. '
        + 'Coordinates are pixels on the screenshot from get_step (see screenshot_size). Annotations are added, never removed.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          annotations: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_ANNOTATIONS_PER_CALL,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ANNOTATION_TYPES },
                x: { type: 'number', description: 'Left edge in pixels (all types except line and arrow).' },
                y: { type: 'number', description: 'Top edge in pixels.' },
                width: { type: 'number' },
                height: { type: 'number' },
                from: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'line and arrow: start [x, y].' },
                to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'line and arrow: end [x, y]; an arrow points here.' },
                text: { type: 'string', description: 'text and tooltip.' },
                value: { type: 'integer', description: 'number: the badge number.' },
                color: { type: 'string', description: 'Hex color such as "#E5484D" (outline, or the text color for text).' },
                tail: { type: 'string', enum: ['top', 'bottom', 'left', 'right'], description: 'tooltip: which side points at the target.' },
              },
              required: ['type'],
              additionalProperties: false,
            },
          },
        },
        required: ['guide_id', 'step_id', 'annotations'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, annotations } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        const step = loadStep(guide, stepId);
        if (!step.image || !step.image.size) throw new AgentError('This step has no screenshot to draw on.');
        if (!Array.isArray(annotations) || !annotations.length || annotations.length > MAX_ANNOTATIONS_PER_CALL) {
          throw new AgentError(`annotations must be a list of 1 to ${MAX_ANNOTATIONS_PER_CALL} items.`);
        }
        const shown = aiScreenshotSize(step.image.size);
        const added = annotations.map((item, i) => annotationFromAgent(item, shown, i));
        const saved = saveWithRetry(
          () => store.getStep(guideId, stepId),
          (current) => ({ ...current, annotations: [...(current.annotations || []), ...added] }),
          (current, revision) => store.saveStep(guideId, current, { expectedRevision: revision }),
        );
        onChange(guideId);
        return {
          content: [text({
            added: added.map((ann) => annotationForAgent(ann, shown)),
            annotations_on_step: (saved.annotations || []).length,
          })],
        };
      },
    },
  ];

  return tools.map((tool) => ({
    ...tool,
    // Expected problems (unknown ids, access off, bad input) come back as a
    // tool error the agent can read and act on, not a protocol failure.
    handler: async (args) => {
      try {
        return await tool.handler(args);
      } catch (err) {
        if (err instanceof AgentError) return { content: [text(err.message)], isError: true };
        throw err;
      }
    },
  }));
}

module.exports = { createAgentTools, INSTRUCTIONS, MAX_NEW_AGENT_BLOCKS };
