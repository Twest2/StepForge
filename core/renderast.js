'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeHtml } = require('./sanitize');
const { htmlToText, linkifyMarkdownLinks, deepClone } = require('./util');
const { systemPlaceholders, resolveScopes, expandPlaceholders, expandRichPlaceholders } = require('./placeholders');
const { decodePng } = require('./png');
const { sniffImageFormat } = require('./image-format');
const { renderAnnotations, applyFocusedView } = require('./raster');
const { orderedBlocks, blockText } = require('./blocks');
const { DEFAULT_CODE_STYLE } = require('./code-highlight');
const { DEFAULT_REVIEW_DAYS, reviewStatus } = require('./review');
const { loadBranding } = require('./branding');
const flow = require('./flowchart');
const { renderFlowchart } = require('./flowchart-raster');

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
      image: null,
    };
    if (step.image && step.mainVisual !== 'none' && step.mainVisual !== 'flowchart') {
      const absPath = path.join(store.stepDir(guideId, step.stepId), step.image.workingPath);
      if (fs.existsSync(absPath)) {
        ast.image = { absPath, width: step.image.size.width, height: step.image.size.height };
        if (images && images.has(absPath)) ast.image.png = images.get(absPath);
      }
    }
    steps.push(ast);
  }

  const limited = maxSteps > 0 ? steps.slice(0, maxSteps) : steps;
  // Resolve references only after export filtering, hierarchical numbering and
  // preview limits are known. Never bake a display number into stored graphs.
  const resolveLinks = html => String(html || '').replace(/<a\b([^>]*?)href="step:([a-zA-Z0-9_-]+)"([^>]*)>([\s\S]*?)<\/a>/g, (whole, before, id, after, label) => {
    const target = limited.find(s => s.stepId === id);
    if (!target) return `${label} (step unavailable)`;
    if (/^Go to [Ss]tep(?:\s.*)?$/.test(htmlToText(label))) label = `Go to Step ${target.number}`;
    return `<a${before}href="step:${id}"${after}>${label}</a>`;
  });
  for (const s of limited) {
    const raw = stepsMap.get(s.stepId);
    s.descriptionHtml = resolveLinks(s.descriptionHtml);
    s.descriptionText = htmlToText(s.descriptionHtml);
    const diagram = (graph, key) => ({ graph: flow.normalizeGraph(graph), svg: flow.toSvg(graph, limited), mermaid: flow.toMermaid(graph, limited),
      steps: limited.map(t => ({ stepId: t.stepId, number: t.number, title: t.title })), png: images?.get(key) || null });
    if (raw.mainVisual === 'flowchart' && raw.flowchart) {
      s.flowchart = diagram(raw.flowchart, `flow:${s.stepId}:main`);
      s.altText = `Flowchart for step ${s.number}: ${s.title}`;
    }
    s.flowchartBlocks = (raw.flowchartBlocks || []).map(b => ({ ...b, ...diagram(b.graph, `flow:${s.stepId}:${b.id}`) }));
    s.blocks = s.blocks.map(b => b.kind === 'flowchart' ? { ...b, ...s.flowchartBlocks.find(f => f.id === b.id) } : b);
  }

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
function renderStepImage(astStep) {
  if (astStep.flowchart) return renderDiagramImage(astStep.flowchart);
  if (!astStep.image) return null;
  const bytes = astStep.image.png || fs.readFileSync(astStep.image.absPath);
  if (sniffImageFormat(bytes) === 'webp') {
    throw new Error('A WebP screenshot was not prepared for export (prepareExportImages).');
  }
  const base = decodePng(bytes);
  const annotated = renderAnnotations(base, astStep.annotations);
  return applyFocusedView(annotated, astStep.focusedView);
}

function renderDiagramImage(diagram) {
  return diagram.png ? decodePng(diagram.png) : renderFlowchart(diagram.graph, diagram.steps);
}

module.exports = { buildRenderAst, renderStepImage, renderDiagramImage, screenshotAltText };
