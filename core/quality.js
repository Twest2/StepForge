'use strict';

const { TOKEN_RE } = require('./placeholders');
const { DEFAULT_CAPTURE_TITLES } = require('./text-intel');

/**
 * Guide quality checks, shown before exporting or publishing: placeholders
 * with no value, steps without a screenshot, and steps without a real title.
 * Works on the render AST, so it sees exactly what an export would print:
 * hidden steps and skipped ones the export leaves out aren't checked, and a
 * placeholder is only flagged if it would still appear as [[Name]].
 */

// Titles StepForge gives a step when it has nothing better.
const AUTOMATIC_TITLES = new Set([
  ...Object.values(DEFAULT_CAPTURE_TITLES), 'Capture', 'Untitled step', 'Untitled substep',
].map((title) => title.toLowerCase()));

/** Distinct placeholder names still in `texts`, in first-seen order. */
function unresolved(texts) {
  const names = new Set();
  for (const text of texts) {
    for (const m of String(text || '').matchAll(TOKEN_RE)) names.add(m[1].trim());
  }
  return [...names];
}

/** A step with no screenshot but its own text is a text-only step, not a missing screenshot. */
function hasBody(step) {
  return Boolean((step.descriptionText || '').trim() || step.textBlocks?.length
    || step.codeBlocks?.length || step.tableBlocks?.length);
}

/**
 * Findings for a render AST, in guide order:
 * { kind: 'placeholder' | 'screenshot' | 'title', stepId (null for the
 *   guide itself), stepNumber, names? (placeholders), detail? }
 * `numbers` (stepId -> number, from stepNumberMap) labels steps as the
 * editor's step list does, since that's where a finding takes you; the
 * export's own numbering skips hidden and skipped steps.
 */
function qualityFindings(ast, numbers = null) {
  const findings = [];
  const { guide } = ast;
  const guideNames = unresolved([guide.title, guide.descriptionText,
    guide.metadata?.author, guide.metadata?.coAuthors, guide.metadata?.organization, guide.metadata?.softwareVersion]);
  if (guideNames.length) findings.push({ kind: 'placeholder', stepId: null, stepNumber: null, names: guideNames });

  for (const step of ast.steps) {
    const at = { stepId: step.stepId, stepNumber: numbers?.get(step.stepId) ?? step.number };
    const title = (step.title || '').trim();
    if (!title) findings.push({ kind: 'title', ...at, detail: 'empty' });
    else if (AUTOMATIC_TITLES.has(title.toLowerCase())) findings.push({ kind: 'title', ...at, detail: 'automatic', title });

    if (step.kind === 'image' && !step.image) findings.push({ kind: 'screenshot', ...at, detail: 'file-missing' });
    else if (step.kind === 'empty' && !hasBody(step)) findings.push({ kind: 'screenshot', ...at, detail: 'none' });

    const names = unresolved([step.title, step.descriptionText,
      ...(step.textBlocks || []).flatMap((tb) => [tb.title, tb.descriptionText]),
      ...(step.annotations || []).map((a) => a.text)]);
    if (names.length) findings.push({ kind: 'placeholder', ...at, names });
  }
  return findings;
}

module.exports = { qualityFindings, AUTOMATIC_TITLES };
