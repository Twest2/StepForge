'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeHtml } = require('./sanitize');
const { htmlToText, linkifyMarkdownLinks, deepClone } = require('./util');
const { systemPlaceholders, resolveScopes, expandPlaceholders } = require('./placeholders');
const { decodePng } = require('./png');
const { renderAnnotations, applyFocusedView } = require('./raster');
const { orderedBlocks, blockText } = require('./blocks');

/**
 * The Render AST is the single normalized document model every exporter
 * consumes. It resolves placeholders, hierarchical numbering, hidden/skipped
 * filtering, and absolute image paths — exporters never read the store.
 */

function buildRenderAst(store, guideId, { globals = {}, now = new Date(), maxSteps = 0 } = {}) {
  const guide = store.getGuide(guideId);
  const stepsMap = store.listSteps(guideId);

  const includedIds = guide.stepsOrder.filter((id) => {
    const s = stepsMap.get(id);
    if (!s || s.hidden) return false;
    if (s.skipped && guide.flags.hideSkippedStepsInExports) return false;
    return true;
  });

  const values = resolveScopes({
    guide,
    globals,
    system: systemPlaceholders(guide, { now, stepCount: includedIds.length }),
  });
  const expand = (text) => expandPlaceholders(text, values);
  // Description fields additionally turn literal "[text](url)" markdown
  // link syntax (as inserted by the editor's Link button) into real <a>
  // tags before sanitizing, so exporters render an actual link.
  const expandDesc = (html) => linkifyMarkdownLinks(expand(html || ''));

  const steps = [];
  const topCounter = { n: 0 };
  const childCounters = new Map();
  const numberOf = new Map();

  for (const id of includedIds) {
    const raw = stepsMap.get(id);
    const step = deepClone(raw);
    let number;
    let depth = 0;
    if (step.parentStepId && numberOf.has(step.parentStepId)) {
      const parentNo = numberOf.get(step.parentStepId);
      const c = (childCounters.get(step.parentStepId) || 0) + 1;
      childCounters.set(step.parentStepId, c);
      number = `${parentNo}.${c}`;
      depth = number.split('.').length - 1;
    } else {
      step.parentStepId = null; // orphan substeps render top-level
      topCounter.n += 1;
      number = String(topCounter.n);
    }
    numberOf.set(step.stepId, number);

    const ast = {
      stepId: step.stepId,
      parentStepId: step.parentStepId,
      number,
      depth,
      kind: step.kind,
      status: step.status,
      skipped: step.skipped,
      forceNewPage: Boolean(step.forceNewPage),
      title: expand(step.title || ''),
      descriptionHtml: sanitizeHtml(expandDesc(step.descriptionHtml)),
      descriptionText: htmlToText(expandDesc(step.descriptionHtml)),
      focusedView: step.focusedView,
      annotations: (step.annotations || []).map((a) => ({ ...a, text: expand(a.text || '') })),
      textBlocks: (step.textBlocks || []).map((tb) => ({
        ...tb,
        title: expand(tb.title || ''),
        descriptionHtml: sanitizeHtml(expandDesc(tb.descriptionHtml)),
        descriptionText: htmlToText(expandDesc(tb.descriptionHtml)),
      })),
      codeBlocks: (step.codeBlocks || []).map((cb) => ({ ...cb, code: blockText(cb) })),
      tableBlocks: (step.tableBlocks || []).map((tb) => ({
        ...tb,
        rows: Array.isArray(tb.rows) ? tb.rows.map((row) => [...row]) : [],
      })),
      blocks: orderedBlocks(step).map((block) => {
        if (block.kind === 'text') {
          return {
            ...block,
            title: expand(block.title || ''),
            descriptionHtml: sanitizeHtml(expandDesc(block.descriptionHtml)),
            descriptionText: htmlToText(expandDesc(block.descriptionHtml)),
          };
        }
        if (block.kind === 'code') return { ...block };
        if (block.kind === 'table') return { ...block };
        return { ...block };
      }),
      links: step.links || [],
      image: null,
    };
    if (step.image) {
      const absPath = path.join(store.stepDir(guideId, step.stepId), step.image.workingPath);
      if (fs.existsSync(absPath)) {
        ast.image = { absPath, width: step.image.size.width, height: step.image.size.height };
      }
    }
    steps.push(ast);
  }

  const limited = maxSteps > 0 ? steps.slice(0, maxSteps) : steps;

  return {
    format: 'stepforge-render-ast',
    version: 1,
    generatedAt: now.toISOString(),
    placeholders: values,
    guide: {
      id: guide.guideId,
      title: expand(guide.title),
      descriptionHtml: sanitizeHtml(expandDesc(guide.descriptionHtml)),
      descriptionText: htmlToText(expandDesc(guide.descriptionHtml)),
      createdAt: guide.createdAt,
      updatedAt: guide.updatedAt,
      flags: guide.flags,
    },
    steps: limited,
  };
}

/**
 * Decode a step's working image and burn in annotations + focused view.
 * Returns an RGBA raster image, or null for steps without images.
 */
function renderStepImage(astStep) {
  if (!astStep.image) return null;
  const base = decodePng(fs.readFileSync(astStep.image.absPath));
  const annotated = renderAnnotations(base, astStep.annotations);
  return applyFocusedView(annotated, astStep.focusedView);
}

module.exports = { buildRenderAst, renderStepImage };
