'use strict';

const { htmlToText } = require('./util');
const { normalizeWhitespace, descriptionForAi, isPlaceholderTitle } = require('./text-intel');
const {
  cleanPlaceholderName,
  isValidPlaceholderName,
  isInlineValue,
  placeholderPromptLines,
} = require('./ai-placeholders');
const { planSubsteps } = require('./step-outline');

/**
 * Write the whole guide's organizing pass: after the steps are written, the
 * model suggests which steps are substeps of earlier ones and which values
 * repeat often enough to become placeholders. Every suggestion is checked
 * here before anything is saved; the order of steps never changes.
 */

const MAX_NEW_PLACEHOLDERS = 3;
const ORGANIZE_MAX_STEPS = 80;
const ORGANIZE_MAX_STEP_CHARS = 160;

/** Steps as the model sees them: S1, S2 … in guide order, indented by depth. */
function outlineLines(steps, parentOf) {
  const depth = new Map();
  return steps.slice(0, ORGANIZE_MAX_STEPS).map((step, i) => {
    const parent = parentOf.get(step.stepId);
    const d = parent && depth.has(parent) ? depth.get(parent) + 1 : 0;
    depth.set(step.stepId, d);
    const title = isPlaceholderTitle(step.title) ? '(untitled)' : step.title;
    let text = descriptionForAi(step.descriptionHtml);
    if (text.length > ORGANIZE_MAX_STEP_CHARS) text = `${text.slice(0, ORGANIZE_MAX_STEP_CHARS - 1)}…`;
    return `${'  '.repeat(d)}S${i + 1}. ${title}${text ? ` — ${text}` : ''}`;
  });
}

function buildOrganizePrompt({ steps = [], parentOf = new Map(), placeholders = [] } = {}) {
  const prompt = [
    'You organize a step-by-step guide that is already written.',
    'Return JSON only. No markdown fences, no commentary, no extra keys outside the schema below.',
    'Schema:',
    '{',
    '  "substeps": [{ "step": "S4", "parent": "S3" }],',
    '  "placeholders": [{ "name": string, "value": string, "scope": "guide" | "global" }]',
    '}',
    '',
    'Steps, in order (indented steps are already substeps):',
    ...outlineLines(steps, parentOf),
    ...(placeholders.length ? ['', ...placeholderPromptLines(placeholders).slice(1).map((l) => `Existing placeholder ${l.slice(2)}`)] : []),
    '',
    'Rules:',
    '- Substeps: group a few steps under the step that starts their task, such as the clicks inside a dialog or page that step opened. The parent is always a top-level step; substeps never have substeps of their own.',
    '- Do not put each step under the one before it. Most steps stay top-level. Never reorder steps. When unsure, leave a step as it is. No substeps is fine.',
    `- Placeholders: suggest one only for a specific value that appears word for word in two or more steps and that a reader may need to change or reuse: an app or product name, a version, a URL, a server or file name, a course or project code. Never for ordinary words. At most ${MAX_NEW_PLACEHOLDERS}; none is fine.`,
    '- Use "scope": "global" only for a value about the user or their organization that other guides will share, such as a company name or a support email. Otherwise use "guide".',
    '- Placeholder names are short and descriptive, using letters, digits and underscores, like "Product" or "Course_Code".',
    '- Do not suggest a placeholder that already exists.',
  ].join('\n');
  return {
    systemPrompt: 'You are a technical documentation editor. Emit only valid JSON matching the schema. Never add commentary or markdown.',
    prompt,
  };
}

const wordRe = (value) => new RegExp(`(^|[^A-Za-z0-9_])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);

/**
 * Check the model's suggestions against the guide and turn them into a plan:
 * { parents: Map stepId -> parentId, placeholders: [{ name, value, scope }] }.
 * `existing` holds every placeholder name and value already defined.
 */
function planOrganize(raw, { steps = [], parentOf = new Map(), existing = { names: [], values: [] } } = {}) {
  const data = typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AI response must be a JSON object');
  const idFor = (label) => {
    const m = /^S(\d+)$/i.exec(normalizeWhitespace(label));
    const step = m ? steps[Number(m[1]) - 1] : null;
    return step ? step.stepId : null;
  };
  const order = steps.map((step) => step.stepId);
  const suggestions = (Array.isArray(data.substeps) ? data.substeps : [])
    .map((s) => ({ stepId: idFor(s && s.step), parentId: idFor(s && s.parent) }))
    .filter((s) => s.stepId && s.parentId);
  // Small models tend to chain every step under the one before it, so the
  // automatic pass only nests under top-level steps: one level, like 3.1.
  const parents = planSubsteps(order, parentOf, suggestions, { maxDepth: 1 });

  // A placeholder is kept only for a real value that repeats: it must appear,
  // as a whole word, in at least two steps' titles or descriptions.
  const stepTexts = steps.map((step) => `${step.title || ''}\n${htmlToText(step.descriptionHtml || '')}`);
  const takenNames = new Set(existing.names.map((n) => n.toLowerCase()));
  const takenValues = new Set(existing.values);
  const placeholders = [];
  for (const item of Array.isArray(data.placeholders) ? data.placeholders : []) {
    if (placeholders.length >= MAX_NEW_PLACEHOLDERS || !item || typeof item !== 'object') continue;
    const name = cleanPlaceholderName(item.name).replace(/\s+/g, '_');
    const value = normalizeWhitespace(item.value);
    if (!isValidPlaceholderName(name) || takenNames.has(name.toLowerCase())) continue;
    if (!isInlineValue(value) || value.length < 3 || !/[A-Za-z0-9]/.test(value) || takenValues.has(value)) continue;
    if (stepTexts.filter((text) => wordRe(value).test(text)).length < 2) continue;
    takenNames.add(name.toLowerCase());
    takenValues.add(value);
    placeholders.push({ name, value, scope: item.scope === 'global' ? 'global' : 'guide' });
  }
  return { parents, placeholders };
}

module.exports = { buildOrganizePrompt, planOrganize, MAX_NEW_PLACEHOLDERS };
