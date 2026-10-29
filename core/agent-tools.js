'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { htmlToMarkdown } = require('../exporters/htmlmd');
const { markdownHtml } = require('./placeholder-markdown');
const { sanitizeHtml } = require('./sanitize');
const { renderScreenshotForAi, aiScreenshotSize } = require('./ai-image');
const { orderedBlocks, blockText } = require('./blocks');
const { placeholderText } = require('./placeholder-markdown');
const { ANNOTATION_TYPES, normalizeAnnotation } = require('./schema');
const { BUILT_IN_NAMES, cleanPlaceholderName, isValidPlaceholderName } = require('./ai-placeholders');
const { withParent, parentMap, isValidOutline, moveSubtree } = require('./step-outline');
const { Settings } = require('./settings');
const { decodePng } = require('./png');
const { createAgentSnapshot } = require('./snapshots');
const { forgetScreenshotChecks } = require('./redaction');
const { createBrandTools, BRAND_INSTRUCTIONS } = require('./agent-brand-tools');
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
 * draw annotations. They can also create and delete guides and steps, move
 * steps, replace or remove screenshots, and delete blocks and annotations;
 * the deletion, step creation/move and screenshot tools snapshot the guide first.
 * They can't change or delete placeholders, or delete blurs.
 */

// An agent may add this many blocks to a step per call; it can always call again.
const MAX_NEW_AGENT_BLOCKS = 5;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 20000;
const MAX_BLOCKS_PER_CALL = 20;
const MAX_ANNOTATIONS_PER_CALL = 20;
const MAX_PLACEHOLDER_VALUE_CHARS = 1000;
const MAX_IDS_PER_CALL = 50;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const INSTRUCTIONS = [
  'StepForge holds step-by-step guides a person recorded: each step is a screenshot of one click, with a marker where they clicked.',
  'You can read guides and rewrite their text: the guide title and description, and each step\'s title, description and blocks (notes, warnings, tips, code, tables).',
  'You can also make a step a substep of an earlier step (update_step parent_step_id), add placeholders (create_placeholder), and draw annotations such as rectangles, arrows and callouts on a screenshot (add_annotations).',
  'You can also create and delete guides and steps (create_guide, delete_guide, create_step, delete_step), move steps (move_step), replace or remove a step\'s screenshot with a PNG file on this computer (set_screenshot, remove_screenshot), and delete blocks and annotations (delete_blocks, delete_annotations). StepForge snapshots existing guides before deletions, create_step, move_step and screenshot changes. Creating a guide, rewriting text, changing nesting with update_step, adding placeholders and drawing annotations do not create agent snapshots.',
  'Steps normally come from a real capture, so prefer rewriting what is there over deleting it. You cannot change or delete placeholders, or delete blurs.',
  'To write a guide: call get_guide, then get_step for each step to see its screenshot, then update_step. Finish with update_guide for the guide\'s title and description.',
  'Step titles are short imperative actions ("Click Save", "Open Settings"). Descriptions are Markdown, 1–2 sentences per step.',
  'Placeholders: get_guide lists them. In descriptions and blocks, write [[Name]] where a placeholder\'s value would appear; keep titles in plain words. Create a placeholder only for a specific value that repeats, such as a product name, version, URL or course code.',
  'Annotations use pixel coordinates on the screenshot get_step returns. A red circle there is usually the person\'s click marker; don\'t duplicate it.',
  'Keep every [[placeholder]] token exactly as written. Polish text the person wrote rather than replacing its meaning.',
  ...BRAND_INSTRUCTIONS,
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

/** The kind of a step with no screenshot: content when it has text, else empty. */
function kindWithoutScreenshot(step) {
  const hasBody = Boolean(step.title || htmlToMarkdown(step.descriptionHtml || '').trim()
    || orderedBlocks(step).length);
  return hasBody ? 'content' : 'empty';
}

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
function createAgentTools({ store, agentSettings, onChange = () => {}, onBrandingChange = () => {} }) {
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

  /** The guide's step order and each step's parent. */
  const outlineOf = (guide) => {
    const steps = store.listSteps(guide.guideId);
    const order = [...(guide.stepsOrder || [])];
    return { order, parentOf: new Map(order.map((id) => [id, steps.get(id)?.parentStepId || null])) };
  };

  /** Take a snapshot before a change the user may want to undo, and say so to the agent. */
  const snapshotBefore = (guideId, action) => {
    createAgentSnapshot(store, guideId, action);
    return 'StepForge saved a snapshot of the guide first, so the user can undo this in More → Backups & snapshots.';
  };

  /** A PNG file on this computer, named by its full path, as screenshot bytes and size. */
  const readScreenshot = (filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new AgentError('image_path must be the full path to a PNG file on this computer.');
    }
    let stat, resolved;
    try { resolved = fs.realpathSync(filePath); stat = fs.statSync(resolved); } catch { throw new AgentError(`There's no file at ${filePath}.`); }
    // Raw library images include originals hidden by blurs, old snapshots and
    // Trash. Importing one as a new step would expose those pixels to get_step.
    const relative = path.relative(fs.realpathSync(store.root), resolved);
    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new AgentError('Use a PNG file outside the StepForge library. Library screenshots can only be read through get_step, with blurs filled in.');
    }
    if (!stat.isFile()) throw new AgentError(`${filePath} isn't a file.`);
    if (stat.size > MAX_SCREENSHOT_BYTES) throw new AgentError(`${filePath} is larger than ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB.`);
    const png = fs.readFileSync(resolved);
    let image;
    try {
      image = decodePng(png);
    } catch {
      throw new AgentError(`StepForge can't read ${filePath} as a PNG. Convert it to PNG and try again.`);
    }
    return { png, size: { width: image.width, height: image.height } };
  };

  /** Ids that aren't in `known`, as an error the agent can act on. */
  const checkIds = (ids, known, what, where) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS_PER_CALL || !ids.every((id) => typeof id === 'string')) {
      throw new AgentError(`Give 1 to ${MAX_IDS_PER_CALL} ${what} ids.`);
    }
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new AgentError(`${where} has no ${what} ${unknown.map((id) => `"${id}"`).join(', ')}. Call get_step for its ${what} ids.`);
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
      name: 'create_guide',
      description: 'Create a new, empty guide. Add its steps with create_step.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the reader will get done, e.g. "Submit a lab in Canvas".' },
          description: { type: 'string', description: 'Markdown. 1–3 sentences introducing the guide.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      handler({ title, description } = {}) {
        requireEnabled();
        checkLength(title, MAX_TITLE_CHARS, 'title');
        checkLength(description, MAX_DESCRIPTION_CHARS, 'description');
        if (!normalizeWhitespace(title || '')) throw new AgentError('Give the guide a title.');
        const guide = store.createGuide({
          title: normalizeWhitespace(title),
          descriptionHtml: description ? sanitizeHtml(markdownHtml(description)) : '',
        });
        onChange(guide.guideId);
        return { content: [text({ guide_id: guide.guideId, title: guide.title, description: descriptionMarkdown(guide.descriptionHtml) })] };
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
      name: 'delete_guide',
      description: 'Move a guide, with all its steps, to StepForge\'s Trash. The user can restore it from there for 30 days.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: { guide_id: { type: 'string' } },
        required: ['guide_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        // The snapshot goes to the Trash with the guide, and comes back with it.
        createAgentSnapshot(store, guideId, 'deletes the guide');
        store.deleteGuide(guideId);
        onChange(guideId);
        return { content: [text(`Moved "${guide.title}" to the Trash. The user can restore it from there.`)] };
      },
    },
    {
      name: 'create_step',
      description: 'Add a step to a guide, optionally with a screenshot from a PNG file on this computer. Add blocks with update_step and annotations with add_annotations.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          title: { type: 'string', description: 'A short imperative action, e.g. "Click Save".' },
          description: { type: 'string', description: 'Markdown. 1–2 sentences on what the person does.' },
          after_step_id: {
            type: ['string', 'null'],
            description: 'Put the new step right after this step, or null for the very top. Leave out to add it at the end.',
          },
          parent_step_id: {
            type: ['string', 'null'],
            description: 'Make the new step a substep of this step, or null for the top level. The parent must be the step right above it or one of that step\'s parents. '
              + 'Leave out to nest it like the step above, or under that step when its substeps follow.',
          },
          image_path: { type: 'string', description: 'Full path to a PNG file to use as the screenshot.' },
        },
        required: ['guide_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, title, description, after_step_id: afterStepId, parent_step_id: parentStepId, image_path: imagePath } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        checkLength(title, MAX_TITLE_CHARS, 'title');
        checkLength(description, MAX_DESCRIPTION_CHARS, 'description');
        if (afterStepId !== undefined && afterStepId !== null) loadStep(guide, afterStepId);
        if (parentStepId !== undefined && parentStepId !== null) loadStep(guide, parentStepId);
        const { order, parentOf } = outlineOf(guide);
        const at = afterStepId === undefined ? order.length : afterStepId === null ? 0 : order.indexOf(afterStepId) + 1;
        const NEW = '\0new';
        const nextOrder = [...order.slice(0, at), NEW, ...order.slice(at)];
        const fits = (parentId) => isValidOutline(nextOrder, new Map(parentOf).set(NEW, parentId));
        let parent;
        if (parentStepId !== undefined) {
          parent = parentStepId || null;
          if (!fits(parent)) {
            throw new AgentError('That parent would break the step numbering. A substep\'s parent must be the step right above it, or one of that step\'s parents.');
          }
        } else {
          // Beside the step above, or under it when its substeps follow, or under one of its parents.
          const above = at > 0 ? order[at - 1] : null;
          const candidates = [parentOf.get(above) || null, above];
          for (let p = parentOf.get(above); p; p = parentOf.get(p)) candidates.push(parentOf.get(p) || null);
          parent = candidates.find(fits) ?? null;
        }
        const screenshot = imagePath !== undefined ? readScreenshot(imagePath) : null;
        const fields = {
          title: normalizeWhitespace(title || ''),
          descriptionHtml: description ? sanitizeHtml(markdownHtml(description)) : '',
          parentStepId: parent,
        };
        if (!screenshot) fields.kind = kindWithoutScreenshot(fields);
        const note = snapshotBefore(guideId, 'adds a step');
        const step = store.addStep(guideId, fields, screenshot?.png || null, screenshot?.size || null, { position: at });
        onChange(guideId);
        return { content: [text(stepForAgent(step, numberOf(store.getGuide(guideId), step.stepId))), text(note)] };
      },
    },
    {
      name: 'update_step',
      description: 'Rewrite a step\'s title, description (Markdown) and blocks, or make it a substep. Leave a field out to keep it. '
        + 'Blocks with an "id" from get_step are rewritten in place; blocks without one are added (at most 5 per call). Use delete_blocks to delete one.',
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
      name: 'move_step',
      description: 'Move a step, with its substeps, to right after another step (or to the top). StepForge nests it so the numbering still reads top to bottom; '
        + 'give parent_step_id to choose its parent at the new place.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          after_step_id: {
            type: ['string', 'null'],
            description: 'Put the step right after this one, or null for the very top. To go after a step and all its substeps, give its last substep.',
          },
          parent_step_id: { type: ['string', 'null'], description: 'Its parent at the new place, or null for the top level.' },
        },
        required: ['guide_id', 'step_id', 'after_step_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, after_step_id: afterStepId, parent_step_id: parentStepId } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        loadStep(guide, stepId);
        if (afterStepId === undefined) throw new AgentError('Give after_step_id: a step id, or null for the very top.');
        if (afterStepId !== null) loadStep(guide, afterStepId);
        if (parentStepId !== undefined && parentStepId !== null) loadStep(guide, parentStepId);
        const { order, parentOf } = outlineOf(guide);
        const moved = afterStepId === stepId ? null : moveSubtree(order, parentOf, stepId, afterStepId === null ? 0 : order.indexOf(afterStepId) + 1);
        if (!moved) throw new AgentError('A step can\'t move into its own substeps.');
        if (parentStepId !== undefined) {
          moved.parentOf = withParent(moved.order, moved.parentOf, stepId, parentStepId);
          if (!moved.parentOf) {
            throw new AgentError('That parent would break the step numbering there. A substep\'s parent must be the step right above it, or one of that step\'s parents.');
          }
        }
        const note = snapshotBefore(guideId, `moves step ${numberOf(guide, stepId)}`);
        store.reorderSteps(guideId, moved.order, Object.fromEntries(moved.parentOf));
        onChange(guideId);
        const now = store.getGuide(guideId);
        return {
          content: [text({
            steps: numberedSteps(store, now).map(({ step, number }) => ({ step_id: step.stepId, number, title: step.title || '' })),
          }), text(note)],
        };
      },
    },
    {
      name: 'delete_step',
      description: 'Delete a step and its screenshot. Its substeps move up a level.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: { guide_id: { type: 'string' }, step_id: { type: 'string' } },
        required: ['guide_id', 'step_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        const step = loadStep(guide, stepId);
        const note = snapshotBefore(guideId, `deletes step ${numberOf(guide, stepId)}`);
        store.deleteStep(guideId, stepId);
        onChange(guideId);
        return { content: [text(`Deleted "${step.title || 'Untitled step'}". ${note}`)] };
      },
    },
    {
      name: 'delete_blocks',
      description: 'Delete blocks (notes, warnings, tips, code, tables) from a step, by the ids get_step gives.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          block_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_IDS_PER_CALL },
        },
        required: ['guide_id', 'step_id', 'block_ids'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, block_ids: blockIds } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        const step = loadStep(guide, stepId);
        checkIds(blockIds, new Set(orderedBlocks(step).map((block) => block.id)), 'block', `Step "${stepId}"`);
        const doomed = new Set(blockIds);
        const note = snapshotBefore(guideId, `deletes blocks in step ${numberOf(guide, stepId)}`);
        const saved = saveWithRetry(
          () => store.getStep(guideId, stepId),
          (current) => ({
            ...current,
            textBlocks: (current.textBlocks || []).filter((b) => !doomed.has(b.id)),
            codeBlocks: (current.codeBlocks || []).filter((b) => !doomed.has(b.id)),
            tableBlocks: (current.tableBlocks || []).filter((b) => !doomed.has(b.id)),
          }),
          (current, revision) => store.saveStep(guideId, current, { expectedRevision: revision }),
        );
        onChange(guideId);
        return { content: [text(stepForAgent(saved, numberOf(store.getGuide(guideId), stepId))), text(note)] };
      },
    },
    {
      name: 'set_screenshot',
      description: 'Replace a step\'s screenshot (or give a step without one a screenshot) with a PNG file on this computer. '
        + 'The step\'s text and annotations stay; check the annotations still line up, and delete any that don\'t with delete_annotations.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          image_path: { type: 'string', description: 'Full path to a PNG file.' },
        },
        required: ['guide_id', 'step_id', 'image_path'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, image_path: imagePath } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        loadStep(guide, stepId);
        const { png, size } = readScreenshot(imagePath);
        const note = snapshotBefore(guideId, `replaces the screenshot of step ${numberOf(guide, stepId)}`);
        const step = store.getStep(guideId, stepId);
        // Agents cannot remove any blur, including one added by a private-detail
        // check. Even a replacement can contain the same private pixels.
        if (step.redaction) step.redaction = { ...step.redaction, checked: '' };
        const saved = store.replaceImages(guideId, stepId, { original: png }, size, step);
        onChange(guideId);
        return { content: [text(stepForAgent(saved, numberOf(guide, stepId))), text(note)] };
      },
    },
    {
      name: 'remove_screenshot',
      description: 'Remove a step\'s screenshot, with the annotations drawn on it. The step keeps its text and blocks.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: { guide_id: { type: 'string' }, step_id: { type: 'string' } },
        required: ['guide_id', 'step_id'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        const step = loadStep(guide, stepId);
        if (!step.image) throw new AgentError('This step has no screenshot.');
        const note = snapshotBefore(guideId, `removes the screenshot of step ${numberOf(guide, stepId)}`);
        const { originalPath, workingPath } = step.image;
        const saved = saveWithRetry(
          () => store.getStep(guideId, stepId),
          (current) => {
            const next = { ...current, image: null, annotations: [] };
            forgetScreenshotChecks(next);
            return { ...next, kind: kindWithoutScreenshot(next) };
          },
          (current, revision) => store.saveStep(guideId, current, { expectedRevision: revision }),
        );
        for (const file of new Set([originalPath, workingPath])) fs.rmSync(path.join(store.stepDir(guideId, stepId), file), { force: true });
        onChange(guideId);
        return { content: [text(stepForAgent(saved, numberOf(guide, stepId))), text(note)] };
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
        + 'Coordinates are pixels on the screenshot from get_step (see screenshot_size). Annotations are added beside what is there; delete_annotations removes them.',
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
    {
      name: 'delete_annotations',
      description: 'Delete annotations from a step\'s screenshot, by the ids get_step gives. Blurs can\'t be deleted: they hide what the person wants kept private.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          annotation_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_IDS_PER_CALL },
        },
        required: ['guide_id', 'step_id', 'annotation_ids'],
        additionalProperties: false,
      },
      handler({ guide_id: guideId, step_id: stepId, annotation_ids: annotationIds } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        const step = loadStep(guide, stepId);
        const annotations = step.annotations || [];
        checkIds(annotationIds, new Set(annotations.map((ann) => ann.id)), 'annotation', `Step "${stepId}"`);
        // Removing a blur would show the agent what it hides on the next get_step.
        const isBlur = (ann) => ann.type === 'blur' || ann.redact;
        const blurs = annotations.filter((ann) => annotationIds.includes(ann.id) && isBlur(ann));
        if (blurs.length) {
          throw new AgentError(`${blurs.map((ann) => `"${ann.id}"`).join(', ')} ${blurs.length === 1 ? 'is a blur' : 'are blurs'}, which hide what the person wants kept private. Agents can't delete blurs.`);
        }
        const doomed = new Set(annotationIds);
        const note = snapshotBefore(guideId, `deletes annotations in step ${numberOf(guide, stepId)}`);
        const saved = saveWithRetry(
          () => store.getStep(guideId, stepId),
          // A blur the person drew meanwhile, with an id the agent named, still stays.
          (current) => ({ ...current, annotations: (current.annotations || []).filter((ann) => !doomed.has(ann.id) || isBlur(ann)) }),
          (current, revision) => store.saveStep(guideId, current, { expectedRevision: revision }),
        );
        onChange(guideId);
        return { content: [text({ deleted: annotationIds.length, annotations_on_step: (saved.annotations || []).length }), text(note)] };
      },
    },
    ...createBrandTools({ settingsDir: store.settingsDir, requireEnabled, agentSettings, onChange: onBrandingChange, AgentError, text }),
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
