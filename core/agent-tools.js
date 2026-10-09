'use strict';

const { htmlToMarkdown } = require('../exporters/htmlmd');
const { markdownHtml } = require('./placeholder-markdown');
const { sanitizeHtml } = require('./sanitize');
const { renderScreenshotForAi } = require('./ai-image');
const { orderedBlocks, blockText } = require('./blocks');
const {
  normalizeAiBlock,
  mergeAiBlocks,
  splitPinnedParagraphs,
  withPinnedParagraphs,
  normalizeWhitespace,
} = require('./text-intel');

/**
 * The tools AI agents (Claude, Codex, any MCP app) get through `StepForge --mcp`.
 * Agents read guides and rewrite their text. They can't create or delete
 * guides, steps, blocks or screenshots: every step comes from a real capture.
 */

// An agent may add this many blocks to a step per call; it can always call again.
const MAX_NEW_AGENT_BLOCKS = 5;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 20000;
const MAX_BLOCKS_PER_CALL = 20;

const INSTRUCTIONS = [
  'StepForge holds step-by-step guides a person recorded: each step is a screenshot of one click, with a marker where they clicked.',
  'You can read guides and rewrite their text: the guide title and description, and each step\'s title, description and blocks (notes, warnings, tips, code, tables).',
  'You cannot create or delete guides, steps, blocks or screenshots.',
  'To write a guide: call get_guide, then get_step for each step to see its screenshot, then update_step. Finish with update_guide for the guide\'s title and description.',
  'Step titles are short imperative actions ("Click Save", "Open Settings"). Descriptions are Markdown, 1–2 sentences per step.',
  'Keep every [[placeholder]] token, such as [[Product]], exactly as written. Polish text the person wrote rather than replacing its meaning.',
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

function stepForAgent(step, number) {
  return {
    step_id: step.stepId,
    number,
    title: step.title || '',
    description: descriptionMarkdown(step.descriptionHtml),
    blocks: orderedBlocks(step).map(blockForAgent),
    has_screenshot: Boolean(step.image),
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
      description: 'Read a guide: its title, description, and every step\'s text and blocks, in order. Use get_step to see a step\'s screenshot.',
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
      description: 'Rewrite a step\'s title, description (Markdown) and blocks. Leave a field out to keep it. '
        + 'Blocks with an "id" from get_step are rewritten in place; blocks without one are added (at most 5 per call). Blocks are never deleted.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
          step_id: { type: 'string' },
          title: { type: 'string', description: 'A short imperative action, e.g. "Click Save".' },
          description: { type: 'string', description: 'Markdown. 1–2 sentences on what the person does.' },
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
      handler({ guide_id: guideId, step_id: stepId, title, description, blocks } = {}) {
        requireEnabled();
        const guide = loadGuide(guideId);
        loadStep(guide, stepId);
        checkLength(title, MAX_TITLE_CHARS, 'title');
        checkLength(description, MAX_DESCRIPTION_CHARS, 'description');
        if (blocks !== undefined && (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS_PER_CALL)) {
          throw new AgentError(`blocks must be a list of at most ${MAX_BLOCKS_PER_CALL} blocks.`);
        }
        if (title === undefined && description === undefined && !blocks?.length) {
          throw new AgentError('Give a title, a description, blocks, or any of them together.');
        }
        const normalized = (blocks || []).map((block) => normalizeAiBlock(block, { bodyToHtml: markdownHtml })).filter(Boolean);
        const saved = saveWithRetry(
          () => store.getStep(guideId, stepId),
          (step) => {
            const next = { ...step };
            if (title !== undefined && normalizeWhitespace(title)) next.title = normalizeWhitespace(title);
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
