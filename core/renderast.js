'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeHtml } = require('./sanitize');
const { htmlToText, linkifyMarkdownLinks, deepClone } = require('./util');
const { systemPlaceholders, resolveScopes, expandPlaceholders, expandRichPlaceholders } = require('./placeholders');
const { decodePng } = require('./png');
const { sniffImageFormat, readImageSize, flowchartImageKey } = require('./image-format');
const { hasFlowchart, linkAreas } = require('./flowchart');
const { renderAnnotations, applyFocusedView } = require('./raster');
const { orderedBlocks, blockText } = require('./blocks');
const { DEFAULT_CODE_STYLE } = require('./code-highlight');
const { DEFAULT_REVIEW_DAYS, reviewStatus } = require('./review');
const { loadBranding } = require('./branding');

/**
 * The Render AST is the single normalized document model every exporter
 * consumes. It resolves placeholders, hierarchical numbering, hidden/skipped
 * filtering, and absolute image paths — exporters never read the store.
 */

/**
 * Alt text for a step's screenshot: "Screenshot for step 3: Click Save", or
 * "Screenshot for step 3" when the step has no title. Control characters
 * (illegal in XML and PDF text) are dropped and whitespace collapsed, so every
 * exporter can escape it for its own format without further cleanup.
 */
function screenshotAltText(number, title) {
  const clean = String(title || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? `Screenshot for step ${number}: ${clean}` : `Screenshot for step ${number}`;
}

/**
 * `images` (optional): Map of absolute screenshot path -> PNG bytes, for the
 * screenshots the store keeps as WebP (see prepareExportImages in
 * core/image-format.js). The exporters only ever see PNG pixels.
 */
function buildRenderAst(store, guideId, { globals = {}, now = new Date(), maxSteps = 0, codeStyle = DEFAULT_CODE_STYLE, reviewDays = DEFAULT_REVIEW_DAYS, branding = null, images = null } = {}) {
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
  const expandDesc = (html) => linkifyMarkdownLinks(expandRichPlaceholders(html || '', values));
  // Table cells are plain text. Code blocks are left as written: [[ ]] is
  // real syntax in shells and other languages.
  const expandRows = (rows) => (Array.isArray(rows) ? rows.map((row) => row.map((cell) => expand(cell))) : []);

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

    const title = expand(step.title || '');
    const ast = {
      stepId: step.stepId,
      parentStepId: step.parentStepId,
      number,
      depth,
      kind: step.kind,
      status: step.status,
      skipped: step.skipped,
      forceNewPage: Boolean(step.forceNewPage),
      title,
      altText: screenshotAltText(number, title),
      descriptionHtml: sanitizeHtml(expandDesc(step.descriptionHtml)),
      descriptionText: htmlToText(expandDesc(step.descriptionHtml)),
      // The Markdown source, for a description written in Markdown (Markdown exports use it as is).
      ...(typeof step.descriptionMarkdown === 'string' ? { descriptionMarkdown: expand(step.descriptionMarkdown) } : {}),
      focusedView: step.focusedView,
      annotations: (step.annotations || []).map((a) => ({ ...a, text: expand(a.text || '') })),
      textBlocks: (step.textBlocks || []).map((tb) => ({
        ...tb,
        title: expand(tb.title || ''),
        descriptionHtml: sanitizeHtml(expandDesc(tb.descriptionHtml)),
        descriptionText: htmlToText(expandDesc(tb.descriptionHtml)),
      })),
      codeBlocks: (step.codeBlocks || []).map((cb) => ({ ...cb, code: blockText(cb) })),
      tableBlocks: (step.tableBlocks || []).map((tb) => ({ ...tb, rows: expandRows(tb.rows) })),
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
        if (block.kind === 'table') return { ...block, rows: expandRows(block.rows) };
        return { ...block };
      }),
      links: step.links || [],
      flowchart: hasFlowchart(step) ? step.flowchart : null,
      flowchartPlacement: step.flowchartPlacement || 'visual',
      image: null,
    };
    if (step.image) {
      const absPath = path.join(store.stepDir(guideId, step.stepId), step.image.workingPath);
      if (fs.existsSync(absPath)) {
        ast.image = { absPath, width: step.image.size.width, height: step.image.size.height };
        if (images && images.has(absPath)) ast.image.png = images.get(absPath);
      }
    }
    // A flowchart (drawn by prepareExportImages) either replaces the
    // screenshot or is a block at the position chosen for it (after the
    // screenshot unless moved), like a text block.
    const chartPng = hasFlowchart(step) && images ? images.get(flowchartImageKey(step.stepId)) : null;
    if (chartPng) {
      const { width, height } = readImageSize(chartPng);
      const chart = { png: chartPng, width, height, flowchart: true };
      if (step.flowchartPlacement === 'block') {
        ast.flowchartImage = chart;
        ast.blocks.push({ kind: 'flowchart', id: 'flowchart', position: step.flowchartPosition || 'after-image', order: Number.MAX_SAFE_INTEGER });
      } else {
        ast.image = chart;
        ast.annotations = [];
        ast.focusedView = { enabled: false };
        ast.altText = flowchartAltText(number, title);
      }
    }
    steps.push(ast);
  }

  // A flowchart's shapes linked to a step: where they are in its picture,
  // so exporters can make them jump to that step.
  const chartRefs = steps.map((s) => ({ stepId: s.stepId, number: s.number }));
  for (const s of steps) {
    const chart = s.image?.flowchart ? s.image : s.flowchartImage;
    if (chart && s.flowchart) chart.links = linkAreas(s.flowchart, { steps: chartRefs });
  }

  // Step links (editor → Description → Step) keep the target's permanent ID
  // and show its number; put in the number the target has in this export.
  const renumber = (html) => String(html || '').replace(
    /(<a\b[^>]*\bdata-step-id="([A-Za-z0-9_-]+)"[^>]*>)([^<]*)(<\/a>)/g,
    (whole, open, id, label, close) => (numberOf.has(id)
      ? `${open}${label.replace(/\d+(?:\.\d+)*(?!.*\d)/, numberOf.get(id))}${close}`
      : whole),
  );
  const renumberText = (item) => {
    if (!item.descriptionHtml || !item.descriptionHtml.includes('data-step-id')) return;
    item.descriptionHtml = renumber(item.descriptionHtml);
    item.descriptionText = htmlToText(item.descriptionHtml);
  };
  for (const ast of steps) {
    renumberText(ast);
    if (ast.descriptionMarkdown) {
      ast.descriptionMarkdown = ast.descriptionMarkdown.replace(/\[([^\]\n]*)\]\(step:([A-Za-z0-9_-]+)\)/g,
        (whole, label, id) => (numberOf.has(id) ? `[${label.replace(/\d+(?:\.\d+)*(?!.*\d)/, numberOf.get(id))}](step:${id})` : whole));
    }
    ast.textBlocks.forEach(renumberText);
    ast.blocks.forEach((block) => { if (block.kind === 'text') renumberText(block); });
  }

  const limited = maxSteps > 0 ? steps.slice(0, maxSteps) : steps;

  // Header and footer text can use placeholders too, such as "© [[Year]]".
  const brand = loadBranding(branding);
  if (brand) {
    brand.header = { ...brand.header, text: expand(brand.header.text) };
    brand.footer = { ...brand.footer, text: expand(brand.footer.text) };
  }

  return {
    format: 'stepforge-render-ast',
    version: 1,
    generatedAt: now.toISOString(),
    placeholders: values,
    codeStyle,
    // The brand profile to apply (BrandingStore.resolve), or null for none.
    branding: brand,
    guide: {
      id: guide.guideId,
      title: expand(guide.title),
      descriptionHtml: sanitizeHtml(expandDesc(guide.descriptionHtml)),
      descriptionText: htmlToText(expandDesc(guide.descriptionHtml)),
      createdAt: guide.createdAt,
      updatedAt: guide.updatedAt,
      flags: guide.flags,
      metadata: {
        author: expand(guide.metadata?.author || ''),
        coAuthors: expand(guide.metadata?.coAuthors || ''),
        organization: expand(guide.metadata?.organization || ''),
        lastVerified: guide.metadata?.lastVerified || '',
        guideVersion: expand(guide.metadata?.guideVersion || ''),
        softwareVersion: expand(guide.metadata?.softwareVersion || ''),
        // Only for guides someone has verified, so other exports don't pick
        // up a review date nobody chose.
        reviewAgainOn: guide.metadata?.lastVerified ? reviewStatus(guide, reviewDays, now.getTime())?.dueDate || '' : '',
      },
    },
    steps: limited,
  };
}

/**
 * Decode a step's working image and burn in annotations + focused view.
 * Returns an RGBA raster image, or null for steps without images.
 */
function flowchartAltText(number, title) {
  return screenshotAltText(number, title).replace(/^Screenshot/, 'Flowchart');
}

/** A step's flowchart block as an RGBA raster image, or null when it has none. */
function renderFlowchartImage(astStep) {
  return astStep.flowchartImage ? decodePng(astStep.flowchartImage.png) : null;
}

function renderStepImage(astStep) {
  if (!astStep.image) return null;
  const bytes = astStep.image.png || fs.readFileSync(astStep.image.absPath);
  if (sniffImageFormat(bytes) === 'webp') {
    throw new Error('A WebP screenshot was not prepared for export (prepareExportImages).');
  }
  const base = decodePng(bytes);
  const annotated = renderAnnotations(base, astStep.annotations);
  return applyFocusedView(annotated, astStep.focusedView);
}

module.exports = { buildRenderAst, renderStepImage, renderFlowchartImage, screenshotAltText, flowchartAltText };
