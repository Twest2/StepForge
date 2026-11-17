'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('../core/zip');
const { escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { highlightCode } = require('../core/code-highlight');
const { exportText, languageTag } = require('../core/export-text');
const { guideSlug, renderAllImages, calloutLabel, stepContentGroups, flowchartImageKey, flowchartAlt, codeBlockText } = require('./common');
const { tocEntries, guideMetaLines, guideSummary } = require('./document-layout');
const { SLIDE_SCREENSHOT_POSITIONS } = require('../core/branding');
const { withBrand, fitSize, textOn, brandRaster, hexToRgb, luminance, contrast, logoNeedsCard } = require('./branding');
const metrics = require('./text-metrics');
const { richParagraphs, sliceRuns, markedText } = require('./pptx-text');
const X = require('./pptx-xml');

/**
 * PPTX exporter: a title slide, contents, and a slide per step, written as
 * PresentationML directly.
 *
 * Every step slide is laid out from measured text (exporters/text-metrics.js),
 * so nothing overlaps: the step's number and title, then its description,
 * callouts, code and tables beside or above the screenshot. Text that doesn't
 * fit is set smaller, then carries on to a "(continued)" slide; nothing is
 * cut. Each step's full text is also in the slide's speaker notes.
 *
 * Titles, accent shapes and body text use the theme's fonts and colors, so a
 * brand profile (or a theme picked later in PowerPoint) restyles the deck; the
 * brand's logo (in the corner it picks), footer, slide numbers and slide
 * background sit on the slide master. A title slide background gets text in
 * whichever of dark or white reads on it, on a panel when neither does.
 */

const SCREENSHOT_POSITIONS = SLIDE_SCREENSHOT_POSITIONS;

const DEFAULT_TEMPLATE = {
  includeImages: true,
  titleSlide: true,
  includeToc: true,
  speakerNotes: true,
  screenshotPosition: 'auto',
};

// The Export dialog's labels, groups and units for these options (exporters/index.js FORMAT_INFO).
const OPTION_INFO = {
  titleSlide: { label: 'Add a title slide', group: 'Contents' },
  includeToc: { label: 'Add a table of contents', group: 'Contents' },
  includeImages: { label: 'Include screenshots', group: 'Contents' },
  speakerNotes: { label: 'Add speaker notes', group: 'Contents', hint: 'Each step’s full text in its slide’s notes, for presenting.' },
  screenshotPosition: {
    label: 'Screenshot position',
    group: 'Slide layout',
    hint: 'Automatic puts the screenshot beside long text and under short text.',
    choices: [
      { value: 'auto', label: 'Automatic' },
      { value: 'right', label: 'Right of the text' },
      { value: 'left', label: 'Left of the text' },
      { value: 'below', label: 'Below the text' },
      { value: 'full', label: 'Whole slide, text in speaker notes' },
    ],
  },
};

// ---- geometry (EMU) ----------------------------------------------------------

const IN = 914400;
const SLIDE_W = 12192000; // 16:9
const SLIDE_H = 6858000;
const EMU_PER_PX = 9525;
const MARGIN_X = Math.round(0.6 * IN);
const TOP = Math.round(0.45 * IN);
const BOTTOM = Math.round(0.42 * IN);
const ACCENT_BAR_H = Math.round(0.07 * IN);
const HEADER_GAP = Math.round(0.24 * IN); // header → body
const GAP = Math.round(0.16 * IN); // between blocks
const PARA_GAP = Math.round(0.09 * IN); // between description paragraphs
const LIST_GAP = Math.round(0.04 * IN); // between list items
const LIST_INDENT = Math.round(0.3 * IN); // per list level; the bullet hangs in it
const QUOTE_INDENT = Math.round(0.25 * IN);
const COLUMN_GAP = Math.round(0.4 * IN);
const BADGE = Math.round(0.5 * IN);
const BADGE_GAP = Math.round(0.18 * IN);
// The footer row on the master: text and slide number.
const FOOTER_Y = SLIDE_H - 360000;
const FOOTER_H = 260000;
const FOOTER_CLEAR = Math.round(0.12 * IN);
// Brand logo on the master: in a top corner, or in the footer row.
const LOGO_MAX_W = 1800000;
const LOGO_MAX_H = 400000;
const FOOTER_LOGO_MAX_H = Math.round(0.32 * IN);
const LOGO_TOP = 150000;
const LOGO_BOTTOM = Math.round(0.14 * IN);

const CALLOUT_BAR = Math.round(0.06 * IN);
const CALLOUT_PAD_X = Math.round(0.16 * IN);
const CALLOUT_PAD_Y = Math.round(0.1 * IN);
const CODE_PAD = Math.round(0.12 * IN);
const TABLE_MARGIN = 64008;

// Point sizes at full scale; a crowded slide sets body text at SCALES.
const SIZE = { title: 28, body: 16, callout: 14, code: 12, table: 12, badge: 16 };
const TITLE_SIZES = [28, 24, 20];
const SCALES = [1, 0.9, 0.8];
// A screenshot is never drawn more than this much larger than 96 dpi.
const MAX_UPSCALE = 1.5;
// "Below the text" needs at least this much height left for the picture.
const MIN_PICTURE_SHARE = 0.4;

const CALLOUT_STYLE = {
  info: { fill: 'EFF6FF', accent: '2563EB', color: '1D4ED8' },
  success: { fill: 'ECFDF5', accent: '10B981', color: '047857' },
  warn: { fill: 'FFFBEB', accent: 'F59E0B', color: 'B45309' },
  error: { fill: 'FEF2F2', accent: 'EF4444', color: 'B91C1C' },
};

const MUTED = '64748B';
// A picture whose luminance varies more than this under the title is busy: the text goes on a panel.
const BUSY_SPREAD = 0.18;
const CODE_FONT = 'Consolas';

// ---- text measuring ------------------------------------------------------------

function fontFor(ctx, role) {
  if (role === 'heading') return ctx.headingFont;
  if (role === 'mono') return CODE_FONT;
  return ctx.bodyFont;
}

function measure(ctx, role, size, bold = false) {
  return metrics.fontMetrics({ size, font: fontFor(ctx, role), bold });
}

const pt = (v) => v * metrics.EMU_PER_PT;

// ---- content blocks ------------------------------------------------------------

/**
 * A step's text as layout items, in order: { kind: 'para' | 'callout' |
 * 'code' | 'table', after } where `after` items follow the screenshot.
 */
function stepItems(step) {
  const groups = Object.fromEntries(Object.entries(stepContentGroups(step))
    // A flowchart block sits beside the screenshot on its slide, wherever it goes elsewhere.
    .map(([group, list]) => [group, list.filter((block) => block.kind !== 'flowchart')]));
  const callouts = (list, after = false) => list.map((tb) => {
    // A callout's text keeps its formatting; its lists and tables become lines.
    const paras = tb.descriptionHtml ? richParagraphs(tb.descriptionHtml).flatMap((p) => (p.rows
      ? p.rows.map((row) => ({ runs: [{ text: row.join(' | ') }], text: row.join(' | '), list: null }))
      : [p])) : null;
    const body = paras ? paras.map(markedText).join('\n') : (tb.descriptionText || '');
    return { kind: 'callout', tb, label: null, body, paras, after };
  });
  // The description keeps its formatting: bold, italic, code, links, lists, quotes, tables.
  const description = step.descriptionHtml
    ? richParagraphs(step.descriptionHtml).map((p) => (p.rows
      ? { kind: 'table', rows: p.rows, after: false }
      : { kind: 'para', ...p, after: false }))
    : String(step.descriptionText || '').split('\n').map((s) => s.trim()).filter(Boolean)
      .map((text) => ({ kind: 'para', text, runs: [{ text }], list: null, after: false }));
  const rest = groups.rest.map((block) => {
    if (block.kind === 'code') return { kind: 'code', code: codeBlockText(block), language: block.language, after: true };
    if (block.kind === 'table' && block.rows?.length) return { kind: 'table', rows: block.rows.map((r) => r.map((c) => String(c ?? ''))), header: true, after: true };
    if (block.kind === 'text') return callouts([block], true)[0];
    return null;
  }).filter(Boolean);
  return [
    ...callouts(groups.beforeTitle),
    ...callouts(groups.afterTitle),
    ...callouts(groups.beforeDescription),
    ...description,
    ...callouts(groups.afterDescription),
    ...callouts(groups.beforeImage),
    ...callouts(groups.afterImage, true),
    ...rest,
  ];
}

function calloutParts(ctx, item) {
  return { label: item.label ?? calloutLabel({ ...item.tb, level: CALLOUT_STYLE[item.tb.level] ? item.tb.level : 'info' }, ctx.ast), body: item.body };
}

/** Column widths for a table `width` wide: by content, every column at least a share. */
function tableColumns(ctx, rows, width, scale) {
  const m = measure(ctx, 'body', SIZE.table * scale, true);
  const cols = Math.max(...rows.map((r) => r.length));
  const natural = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => pt(m.width(r[c] || ''))), 1) + TABLE_MARGIN * 2);
  const floor = width / (cols * 2.5);
  const weights = natural.map((w) => Math.max(w, floor));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.floor((w / total) * width));
}

function tableRowHeights(ctx, rows, colWidths, scale) {
  const lineH = pt(measure(ctx, 'body', SIZE.table * scale).lineHeight);
  return rows.map((row, r) => {
    const m = measure(ctx, 'body', SIZE.table * scale, r === 0);
    const lines = Math.max(1, ...colWidths.map((w, c) => metrics.wrapText(row[c] || '', w - TABLE_MARGIN * 2, m).reduce((n, p) => n + p.length, 0)));
    return Math.ceil(lines * lineH + TABLE_MARGIN * 1.2 + 20000);
  });
}

/** The height of an item set `width` wide at `scale`. */
function itemHeight(ctx, item, width, scale) {
  switch (item.kind) {
    case 'para':
      return metrics.textHeight(item.text, width - paraIndent(item), measure(ctx, 'body', SIZE.body * scale, paraBold(item)));
    case 'callout': {
      const { label, body } = calloutParts(ctx, item);
      const inner = width - CALLOUT_BAR - CALLOUT_PAD_X * 2;
      const labelH = label ? metrics.textHeight(label, inner, measure(ctx, 'body', SIZE.callout * scale, true)) : 0;
      const bodyH = body ? metrics.textHeight(body, inner, measure(ctx, 'body', SIZE.callout * scale)) : 0;
      return labelH + bodyH + (label && body ? pt(3) : 0) + CALLOUT_PAD_Y * 2;
    }
    case 'code':
      return metrics.textHeight(item.code, width - CODE_PAD * 2, measure(ctx, 'mono', SIZE.code * scale)) + CODE_PAD * 2;
    case 'table': {
      const cols = tableColumns(ctx, item.rows, width, scale);
      return tableRowHeights(ctx, item.rows, cols, scale).reduce((a, b) => a + b, 0);
    }
    default:
      return 0;
  }
}

function gapBetween(prev, next) {
  if (prev.kind === 'para' && next.kind === 'para') return prev.list && next.list ? LIST_GAP : PARA_GAP;
  return GAP;
}

/** How far a paragraph is indented: list items by level, quotes a little. */
function paraIndent(item) {
  if (item.list) return LIST_INDENT * (item.list.level + 1);
  return item.quote ? QUOTE_INDENT : 0;
}

/** Whether to measure a paragraph as bold: a heading, or mostly bold text. */
function paraBold(item) {
  if (item.heading) return true;
  const bold = (item.runs || []).reduce((n, r) => n + (r.bold ? r.text.length : 0), 0);
  return bold > item.text.length * 0.3;
}

function stackHeight(ctx, items, width, scale) {
  return items.reduce((sum, item, i) => sum + (i ? gapBetween(items[i - 1], item) : 0) + itemHeight(ctx, item, width, scale), 0);
}

/**
 * Split wrapped text after its first `fit` lines, at the end of a sentence
 * when one ends in the second half of them. Null when fewer than two lines
 * fit or everything does.
 */
function splitText(text, lines, fit) {
  if (fit < 2 || fit >= lines.length) return null;
  const head = lines.slice(0, fit).join(' ');
  const sentence = [...head.matchAll(/[.!?。！？](?=\s|$)/g)].map((m) => m.index + 1).filter((i) => i > head.length / 2).pop();
  const cut = sentence || head.length;
  const flat = lines.join(' ');
  return [flat.slice(0, cut).trim(), flat.slice(cut).trim()];
}

/**
 * Split an item so its first part fits `maxH`: a paragraph, callout or code
 * block between lines, a table between rows (repeating the header). Returns
 * [head, tail], or null when not even a little fits.
 */
function splitItem(ctx, item, width, scale, maxH) {
  if (item.kind === 'para') {
    const m = measure(ctx, 'body', SIZE.body * scale, paraBold(item));
    const parts = splitText(item.text, metrics.wrapText(item.text, width - paraIndent(item), m).flat(), Math.floor(maxH / pt(m.lineHeight)));
    if (!parts) return null;
    // Both halves keep their formatting; the second continues a list item without a new bullet.
    const head = sliceRuns(item.runs, 0, parts[0].length);
    const tail = sliceRuns(item.runs, item.text.length - parts[1].length);
    return [
      { ...item, runs: head, text: parts[0] },
      { ...item, runs: tail, text: parts[1], list: item.list && { ...item.list, continued: true } },
    ];
  }
  if (item.kind === 'code') {
    const lines = item.code.split('\n');
    let n = 0;
    while (n < lines.length && itemHeight(ctx, { kind: 'code', code: lines.slice(0, n + 1).join('\n') }, width, scale) <= maxH) n += 1;
    if (n < 2 || n >= lines.length) return null;
    return [{ ...item, code: lines.slice(0, n).join('\n') }, { ...item, code: lines.slice(n).join('\n') }];
  }
  if (item.kind === 'callout') {
    const { label, body } = calloutParts(ctx, item);
    const inner = width - CALLOUT_BAR - CALLOUT_PAD_X * 2;
    const labelH = label ? metrics.textHeight(label, inner, measure(ctx, 'body', SIZE.callout * scale, true)) : 0;
    const m = measure(ctx, 'body', SIZE.callout * scale);
    const fit = Math.floor((maxH - labelH - pt(3) - CALLOUT_PAD_Y * 2) / pt(m.lineHeight));
    const parts = splitText(body, metrics.wrapText(body, inner, m).flat(), fit);
    return parts && [{ ...item, label, body: parts[0], paras: null }, { ...item, label, body: parts[1], paras: null }];
  }
  if (item.kind === 'table') {
    const cols = tableColumns(ctx, item.rows, width, scale);
    const heights = tableRowHeights(ctx, item.rows, cols, scale);
    let used = 0;
    let n = 0;
    while (n < heights.length && used + heights[n] <= maxH) { used += heights[n]; n += 1; }
    if (n < 2 || n >= item.rows.length) return null;
    return [{ ...item, rows: item.rows.slice(0, n) }, { ...item, rows: [item.rows[0], ...item.rows.slice(n)] }];
  }
  return null;
}

/**
 * Take items from the front of `queue` that fit `maxH` in a column `width`
 * wide, splitting the first one that doesn't when it can be. With `force`,
 * at least one item (or part of one) is always taken so pages make progress.
 */
function takeFitting(ctx, queue, width, scale, maxH, { force = false } = {}) {
  const taken = [];
  let used = 0;
  while (queue.length) {
    const next = queue[0];
    const gap = taken.length ? gapBetween(taken[taken.length - 1], next) : 0;
    const h = itemHeight(ctx, next, width, scale);
    if (used + gap + h <= maxH) {
      taken.push(queue.shift());
      used += gap + h;
      continue;
    }
    const parts = splitItem(ctx, next, width, scale, maxH - used - gap);
    if (parts) {
      queue.shift();
      queue.unshift(parts[1]);
      taken.push(parts[0]);
    } else if (force && !taken.length) {
      taken.push(queue.shift());
    }
    break;
  }
  return taken;
}

// ---- pictures ----------------------------------------------------------------------

/**
 * Fit pictures into `box`: side by side or stacked, whichever shows them
 * larger. Returns { w, h, placed: [{ x, y, w, h }] } relative to the box's
 * top left, the group centered horizontally.
 */
function fitPictures(pics, box) {
  if (!pics.length || box.w <= 0 || box.h <= 0) return { w: 0, h: 0, area: 0, placed: [] };
  const arrange = (horizontal) => {
    const n = pics.length;
    const cellW = horizontal ? (box.w - GAP * (n - 1)) / n : box.w;
    const cellH = horizontal ? box.h : (box.h - GAP * (n - 1)) / n;
    const sized = pics.map((p) => {
      const w = p.img.width * EMU_PER_PX;
      const h = p.img.height * EMU_PER_PX;
      const scale = Math.max(0, Math.min(cellW / w, cellH / h, MAX_UPSCALE));
      return { w: Math.floor(w * scale), h: Math.floor(h * scale) };
    });
    const w = horizontal ? sized.reduce((s, p) => s + p.w, 0) + GAP * (n - 1) : Math.max(...sized.map((p) => p.w));
    const h = horizontal ? Math.max(...sized.map((p) => p.h)) : sized.reduce((s, p) => s + p.h, 0) + GAP * (n - 1);
    let cursor = 0;
    const placed = sized.map((p) => {
      const at = horizontal
        ? { x: Math.round((box.w - w) / 2) + cursor, y: 0, w: p.w, h: p.h }
        : { x: Math.round((box.w - p.w) / 2), y: cursor, w: p.w, h: p.h };
      cursor += (horizontal ? p.w : p.h) + GAP;
      return at;
    });
    return { w, h, area: sized.reduce((s, p) => s + p.w * p.h, 0), placed };
  };
  if (pics.length === 1) return arrange(true);
  const across = arrange(true);
  const down = arrange(false);
  return down.area > across.area ? down : across;
}

// ---- step slide planning ------------------------------------------------------------

/** The step's number badge and title, measured: sizes and boxes. */
function planHeader(ctx, label, title, { titleRight }) {
  const badgeText = String(label || '');
  const badgeM = measure(ctx, 'heading', SIZE.badge, true);
  const badgeW = badgeText ? Math.max(BADGE, Math.round(pt(badgeM.width(badgeText))) + Math.round(0.24 * IN)) : 0;
  const titleX = MARGIN_X + (badgeW ? badgeW + BADGE_GAP : 0);
  const titleW = Math.max(IN, titleRight - titleX);
  let size = TITLE_SIZES[0];
  let lines = [];
  for (const s of TITLE_SIZES) {
    size = s;
    lines = metrics.wrapText(title, titleW, measure(ctx, 'heading', s, true)).flat();
    if (lines.length <= 2) break;
  }
  const lineH = pt(measure(ctx, 'heading', size, true).lineHeight);
  const titleH = Math.ceil(lines.length * lineH);
  const first = Math.max(lineH, badgeW ? BADGE : 0);
  const badge = badgeW ? { x: MARGIN_X, y: ctx.top + Math.round((first - BADGE) / 2), w: badgeW, h: BADGE, text: badgeText } : null;
  const titleBox = { x: titleX, y: ctx.top + Math.round((first - lineH) / 2), w: titleW, h: titleH };
  const bottom = Math.max(titleBox.y + titleBox.h, badge ? badge.y + badge.h : 0);
  return { badge, title: { box: titleBox, size, text: title }, bottom };
}

/**
 * Try one arrangement of a step's items and pictures in `area` at `scale`.
 * Returns { fits, area (picture area), ... } with the boxes to draw.
 */
function arrange(ctx, mode, items, pics, area, scale) {
  if (mode === 'full') {
    const fit = fitPictures(pics, area);
    return { mode, fits: true, scale, pictureArea: fit.area, picBox: { x: area.x, y: area.y, w: area.w, h: area.h }, fit, column: null, items: [], below: [] };
  }
  if (mode === 'text' || !pics.length) {
    const h = stackHeight(ctx, items, area.w, scale);
    return { mode: 'text', fits: h <= area.h, scale, pictureArea: 0, column: { x: area.x, y: area.y, w: area.w }, items, below: [] };
  }
  if (mode === 'below') {
    const top = items.filter((i) => !i.after);
    const after = items.filter((i) => i.after);
    const topH = top.length ? stackHeight(ctx, top, area.w, scale) + GAP : 0;
    const afterH = after.length ? stackHeight(ctx, after, area.w, scale) + GAP : 0;
    const picH = area.h - topH - afterH;
    const fit = fitPictures(pics, { w: area.w, h: Math.max(0, picH) });
    const fits = picH >= Math.max(area.h * MIN_PICTURE_SHARE, IN) && fit.h > 0;
    return {
      mode, fits, scale, pictureArea: fits ? fit.area : 0,
      column: { x: area.x, y: area.y, w: area.w }, items: top,
      picBox: { x: area.x, y: area.y + topH, w: area.w, h: picH }, fit,
      below: after,
    };
  }
  // Beside the text: the picture column takes what the pictures need, up to 62%.
  const maxPicW = Math.round((area.w - COLUMN_GAP) * 0.62);
  const fit0 = fitPictures(pics, { w: maxPicW, h: area.h });
  const picW = Math.max(fit0.w, Math.round(area.w * 0.3));
  const textW = area.w - picW - COLUMN_GAP;
  const fit = fitPictures(pics, { w: picW, h: area.h });
  const h = stackHeight(ctx, items, textW, scale);
  const left = mode === 'left';
  return {
    mode, fits: h <= area.h, scale, pictureArea: fit.area,
    column: { x: left ? area.x + picW + COLUMN_GAP : area.x, y: area.y, w: textW }, items,
    picBox: { x: left ? area.x : area.x + textW + COLUMN_GAP, y: area.y, w: picW, h: area.h }, fit,
    below: [],
  };
}

/**
 * Lay out one step: the arrangement for its first slide and the items that
 * carry on to "(continued)" slides.
 */
function planStep(ctx, items, pics, area, position) {
  if (position === 'full' && pics.length) return { first: arrange(ctx, 'full', items, pics, area, 1), rest: [] };
  const modes = !pics.length ? ['text'] : position === 'auto' ? ['right', 'below'] : [position];
  for (const scale of SCALES) {
    const options = modes.map((mode) => arrange(ctx, mode, items, pics, area, scale)).filter((a) => a.fits);
    if (options.length) {
      options.sort((a, b) => b.pictureArea - a.pictureArea);
      return { first: options[0], rest: [] };
    }
  }
  // Too much for one slide: as much as fits beside (or above) the picture, the rest after.
  const scale = SCALES[1];
  const mode = !pics.length ? 'text' : position === 'auto' ? 'right' : position;
  const queue = items.slice();
  let first;
  if (mode === 'text') {
    first = arrange(ctx, 'text', takeFitting(ctx, queue, area.w, scale, area.h, { force: true }), [], area, scale);
  } else if (mode === 'below') {
    // Only text from above the picture goes on this slide; what follows the picture waits.
    const room = area.h - Math.max(area.h * MIN_PICTURE_SHARE, IN) - GAP;
    const before = queue.filter((i) => !i.after);
    const taken = takeFitting(ctx, before, area.w, scale, room);
    queue.splice(0, queue.length, ...before, ...items.filter((i) => i.after));
    first = arrange(ctx, 'below', taken, pics, area, scale);
  } else {
    const probe = arrange(ctx, mode, [], pics, area, scale);
    const taken = takeFitting(ctx, queue, probe.column.w, scale, area.h);
    first = arrange(ctx, mode, taken, pics, area, scale);
  }
  return { first, rest: queue };
}

// ---- drawing ------------------------------------------------------------------------

function itemXml(ctx, nextId, item, box, scale) {
  const ink = 'scheme:tx1';
  const lang = ctx.lang;
  switch (item.kind) {
    case 'para': {
      const size = SIZE.body * scale;
      const list = item.list;
      const marL = paraIndent(item);
      const bullet = list && !list.continued ? (list.ordered ? { number: list.n } : { char: '\u2022' }) : null;
      const style = { size, color: item.quote ? '475569' : ink, lang, bold: item.heading, italic: item.quote };
      return X.shape(nextId, {
        name: 'Text',
        box,
        paras: [X.paragraph(richRuns(ctx, item.runs, style), { marL, bullet })],
        text: { inset: 0 },
      });
    }
    case 'callout': {
      const style = CALLOUT_STYLE[item.tb.level] || CALLOUT_STYLE.info;
      const { label, body } = calloutParts(ctx, item);
      const paras = [
        ...(label ? X.paragraphs(label, { size: SIZE.callout * scale, bold: true, color: style.color, lang }) : []),
        ...(item.paras
          // Formatted text; list items start with their marker.
          ? item.paras.map((p, i) => X.paragraph(richRuns(ctx, p.list ? [{ text: markedText({ ...p, text: '' }) }, ...p.runs] : p.runs,
            { size: SIZE.callout * scale, color: '1F2937', lang }), { spaceBefore: i === 0 && label ? 3 : 0 }))
          : (body ? X.paragraphs(body, { size: SIZE.callout * scale, color: '1F2937', lang }, { spaceBefore: label ? 3 : 0 }) : [])),
      ];
      return X.shape(nextId, { name: 'Callout', box, fill: style.fill })
        + X.shape(nextId, { name: 'Callout bar', box: { x: box.x, y: box.y, w: CALLOUT_BAR, h: box.h }, fill: style.accent })
        + X.shape(nextId, {
          name: 'Callout text',
          box: { x: box.x + CALLOUT_BAR + CALLOUT_PAD_X, y: box.y + CALLOUT_PAD_Y, w: box.w - CALLOUT_BAR - CALLOUT_PAD_X * 2, h: box.h - CALLOUT_PAD_Y * 2 },
          paras,
          text: { inset: 0 },
        });
    }
    case 'code': {
      const hl = highlightCode(item.code, item.language, ctx.ast.codeStyle);
      const size = SIZE.code * scale;
      const lines = hl ? hl.lines : item.code.split('\n').map((text) => [{ text, color: '#1F2937' }]);
      const paras = lines.map((line) => X.paragraph(line.length
        ? line.map((r) => X.run(r.text, { size, bold: r.bold, italic: r.italic, color: (r.color || '#1F2937').slice(1), font: CODE_FONT, lang }))
        : '', { endSize: line.length ? 0 : size }));
      return X.shape(nextId, {
        name: 'Code',
        box,
        geom: 'roundRect',
        radius: Math.round(0.06 * IN),
        fill: hl ? hl.background.slice(1) : 'F3F4F6',
        line: hl?.dark ? null : { color: 'E5E7EB', w: 9525 },
        paras,
        text: { inset: CODE_PAD },
      });
    }
    case 'table': {
      const colWidths = tableColumns(ctx, item.rows, box.w, scale);
      const heights = tableRowHeights(ctx, item.rows, colWidths, scale);
      const cols = colWidths.length;
      const rows = item.rows.map((row, r) => ({
        h: heights[r],
        cells: Array.from({ length: cols }, (_, c) => ({
          paras: X.paragraphs(row[c] || '', { size: SIZE.table * scale, bold: r === 0, color: 'scheme:tx1', lang }),
          fill: r === 0 ? 'F1F5F9' : null,
        })),
      }));
      return X.table(nextId, { box: { ...box, w: colWidths.reduce((a, b) => a + b, 0), h: heights.reduce((a, b) => a + b, 0) }, colWidths, rows, margin: TABLE_MARGIN });
    }
    default:
      return '';
  }
}

/**
 * Formatted runs as slide runs: bold, italic, strikethrough, inline code in
 * the code font, and links. A web link goes to its page; a link to another
 * step jumps to that step's slide (resolved when the deck is put together).
 */
function richRuns(ctx, runs, base) {
  return runs.map((r) => {
    let link = null;
    if (r.href && /^(https?:|mailto:)/i.test(r.href)) link = ctx.addLink({ href: r.href });
    else if (r.href && r.href.startsWith('step:') && ctx.ast.steps.some((s) => s.stepId === r.href.slice(5))) link = ctx.addLink({ stepId: r.href.slice(5) });
    return X.run(r.text, {
      ...base,
      bold: base.bold || r.bold,
      italic: base.italic || r.italic,
      strike: r.strike,
      font: r.code ? CODE_FONT : (base.font || '+mn-lt'),
      color: link ? 'scheme:hlink' : base.color,
      link,
    });
  }).join('');
}

/** Draw items stacked down a column from `y`; returns the xml and the bottom. */
function columnXml(ctx, nextId, items, { x, y, w }, scale) {
  let xml = '';
  let cursor = y;
  items.forEach((item, i) => {
    if (i) cursor += gapBetween(items[i - 1], item);
    const h = itemHeight(ctx, item, w, scale);
    xml += itemXml(ctx, nextId, item, { x, y: cursor, w, h }, scale);
    cursor += h;
  });
  return { xml, bottom: cursor };
}

function headerXml(ctx, nextId, header) {
  let xml = '';
  if (header.badge) {
    const b = header.badge;
    xml += X.shape(nextId, {
      name: 'Step number',
      box: b,
      geom: b.w > b.h ? 'roundRect' : 'ellipse',
      radius: b.h / 2,
      fill: 'scheme:accent1',
      paras: [X.paragraph(X.run(b.text, { size: SIZE.badge, bold: true, color: ctx.onPrimary, font: '+mj-lt', lang: ctx.lang }), { align: 'ctr' })],
      text: { inset: 0, anchor: 'ctr', autofit: false },
    });
  }
  const t = header.title;
  xml += X.shape(nextId, {
    name: 'Title',
    ph: 'title',
    box: t.box,
    paras: X.paragraphs(t.text, { size: t.size, bold: true, font: '+mj-lt', color: 'scheme:tx1', lang: ctx.lang }),
    text: { inset: 0, anchor: 't' },
  });
  return xml;
}

/** The slide's top accent bar (left off when a background picture styles the slides). */
function accentBar(ctx, nextId) {
  return ctx.slideBackground ? '' : X.shape(nextId, { name: 'Accent', box: { x: 0, y: 0, w: SLIDE_W, h: ACCENT_BAR_H }, fill: 'scheme:accent1' });
}

/** The step's full text for its speaker notes. */
function notesText(ctx, step, items) {
  const lines = [`${step.number}. ${step.title || ctx.t('Untitled step')}`];
  for (const item of items) {
    if (item.kind === 'para') lines.push(markedText(item));
    else if (item.kind === 'callout') {
      const { label, body } = calloutParts(ctx, item);
      lines.push([label, body].filter(Boolean).join(' — '));
    } else if (item.kind === 'code') lines.push(item.code);
    else if (item.kind === 'table') lines.push(...item.rows.map((r) => r.join(' | ')));
  }
  return lines.join('\n');
}

// ---- the deck ------------------------------------------------------------------------

/** The theme: the brand's text, primary and accent colors and its heading and body fonts, else StepForge's. */
function themeXml(brand) {
  const c = brand?.colors;
  const hex = (v, fallback) => (v ? v.slice(1) : fallback);
  const name = escapeXml(brand ? brand.name : 'StepForge');
  const major = escapeXml(brand?.fonts.heading.name || brand?.fonts.body.name || 'Calibri');
  const minor = escapeXml(brand?.fonts.body.name || 'Calibri');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}">
<a:themeElements>
<a:clrScheme name="${name}"><a:dk1><a:srgbClr val="${hex(c?.text, '111827')}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="${hex(c?.primary, '2563EB')}"/></a:accent1><a:accent2><a:srgbClr val="${hex(c?.accent, '10B981')}"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4><a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="EC4899"/></a:accent6><a:hlink><a:srgbClr val="${hex(c?.accent, '2563EB')}"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
<a:fontScheme name="${name}"><a:majorFont><a:latin typeface="${major}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${minor}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="StepForge"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;
}

// Title placeholders on the master and layout, so slide titles inherit from them.
const TITLE_PH_BOX = { x: MARGIN_X, y: TOP, w: SLIDE_W - MARGIN_X * 2, h: Math.round(0.8 * IN) };

function titlePlaceholder(id) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${TITLE_PH_BOX.x}" y="${TITLE_PH_BOX.y}"/><a:ext cx="${TITLE_PH_BOX.w}" cy="${TITLE_PH_BOX.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>`;
}

/**
 * The slide master. With a brand profile it carries the logo (in the corner
 * the profile picks, or none), the footer text, the slide number and the
 * slide background, so they're on every slide.
 */
function masterXml(ctx) {
  const { brand, logoAt, t } = ctx;
  let shapes = titlePlaceholder(2);
  if (logoAt) shapes += X.picture(X.ids(3), { relId: 3, box: logoAt, alt: t('Logo'), name: 'Logo' });
  const footerText = (id, x, w, align, runs) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${FOOTER_Y}"/><a:ext cx="${Math.round(w)}" cy="${FOOTER_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="${align}"/>${runs}</a:p></p:txBody></p:sp>`;
  const rpr = `<a:rPr lang="${ctx.lang}" sz="1000" dirty="0"><a:solidFill><a:srgbClr val="${MUTED}"/></a:solidFill><a:latin typeface="+mn-lt"/></a:rPr>`;
  // The footer row makes room for a logo in a bottom corner.
  const gap = Math.round(0.2 * IN);
  const left = ctx.logoPosition === 'bottom-left' && logoAt ? logoAt.x + logoAt.w + gap : MARGIN_X;
  const right = ctx.logoPosition === 'bottom-right' && logoAt ? logoAt.x - gap : SLIDE_W - MARGIN_X;
  const numberW = 900000;
  if (brand?.footer.text) {
    const w = (brand.footer.pageNumbers ? right - numberW - gap : right) - left;
    shapes += footerText(4, left, w, 'l', `<a:r>${rpr}<a:t>${escapeXml(brand.footer.text)}</a:t></a:r>`);
  }
  if (brand?.footer.pageNumbers) {
    shapes += footerText(5, right - numberW, numberW, 'r',
      `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum">${rpr}<a:t>‹#›</a:t></a:fld>`);
  }
  const background = ctx.slideBackground ? X.backgroundXml(4) : '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${X.NS}>
<p:cSld>${background}<p:spTree>${X.GROUP_PROPS}
${shapes}</p:spTree></p:cSld>
<p:clrMap ${X.CLR_MAP}/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${X.NS} type="titleOnly" preserve="1">
<p:cSld name="Title Only"><p:spTree>${X.GROUP_PROPS}${titlePlaceholder(2)}
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

/**
 * The average luminance of an image's visible pixels, in the part of it
 * between fractions x0..x1 and y0..y1 (null for an empty or unreadable one).
 */
function imageLuminance(img, rect) {
  return imageTone(img, rect)?.mean ?? null;
}

/**
 * The luminance of part of an image (fractions x0..x1, y0..y1): its average
 * and its spread (standard deviation). A large spread is a busy picture.
 */
function imageTone(img, [x0, y0, x1, y1] = [0, 0, 1, 1]) {
  if (!img) return null;
  const left = Math.floor(img.width * x0);
  const right = Math.max(left + 1, Math.ceil(img.width * x1));
  const top = Math.floor(img.height * y0);
  const bottom = Math.max(top + 1, Math.ceil(img.height * y1));
  const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 20000)));
  let sum = 0;
  let squares = 0;
  let weight = 0;
  for (let y = top; y < Math.min(bottom, img.height); y += step) {
    for (let x = left; x < Math.min(right, img.width); x += step) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3] / 255;
      if (a < 0.2) continue;
      const l = luminance([img.data[i], img.data[i + 1], img.data[i + 2]]);
      sum += l * a;
      squares += l * l * a;
      weight += a;
    }
  }
  if (!weight) return null;
  const mean = sum / weight;
  return { mean, spread: Math.sqrt(Math.max(0, squares / weight - mean * mean)) };
}

/**
 * A background picture as slide media: a JPEG as it is (PowerPoint shows
 * JPEG, and photos stay small), anything else as its PNG drawing.
 */
function backgroundMedia(asset, name) {
  if (!asset) return null;
  if (asset.mime === 'image/jpeg' && asset.data) return { name: `${name}.jpg`, data: asset.data };
  return asset.png ? { name: `${name}.png`, data: asset.png } : null;
}

/**
 * The title slide: Standard, Centered or Band, with the brand's banner, a
 * larger logo and the title slide background. Text is dark or white,
 * whichever reads on what's behind it; on a busy picture where neither does,
 * it sits on a translucent panel. A logo that would vanish sits on a white card.
 */
function titleSlide(ctx) {
  const { ast, brand, t } = ctx;
  const nextId = X.ids();
  const style = brand?.cover || 'standard';
  const centered = style === 'centered';
  const align = centered ? 'ctr' : 'l';
  const own = ctx.titleBackground;
  // A picture behind the title: its own, or the slide background it inherits (a band covers that).
  const picture = own || (style !== 'band' ? ctx.slideBackground : null);
  const bandColor = style === 'band' && !own ? brand.colors.primary : null;
  const rels = [];
  const media = [];
  let xml = '';
  let behind = null; // luminance behind the text
  let busy = false;
  if (picture) {
    // A picture with both light and dark areas under the text (or one not drawn yet) needs a panel.
    const tone = imageTone(brandRaster(picture.asset), centered ? [0.15, 0.25, 0.85, 0.9] : [0, 0.25, 0.7, 0.9]);
    behind = tone?.mean ?? null;
    busy = !tone || tone.spread > BUSY_SPREAD;
    if (own) rels.push({ id: 4, name: own.media.name });
  } else if (bandColor) {
    behind = luminance(hexToRgb(bandColor));
    xml += X.shape(nextId, { name: 'Band', box: { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H }, fill: 'scheme:accent1' });
  } else {
    xml += X.shape(nextId, { name: 'Accent', box: { x: 0, y: 0, w: SLIDE_W, h: ACCENT_BAR_H }, fill: 'scheme:accent1' });
  }
  const darkInk = (brand?.colors.text || '#111827').slice(1);
  const onDark = behind != null && behind < 0.4;
  const ink = behind == null ? (picture ? 'FFFFFF' : 'scheme:tx1') : (onDark ? 'FFFFFF' : darkInk);
  const muted = behind == null && !picture ? MUTED : ink;
  const inkLum = ink === 'FFFFFF' ? 1 : luminance(hexToRgb(`#${darkInk}`));
  const panel = picture && (busy || contrast(inkLum, behind ?? 0) < 4.5);

  let top = picture ? 0 : ACCENT_BAR_H;
  if (brand?.banner?.png) {
    const box = ctx.emuBox(brand.banner, SLIDE_W, 1500000);
    rels.push({ id: 2, name: 'brand-banner.png' });
    xml += X.picture(nextId, { relId: 2, box: { x: Math.round((SLIDE_W - box.w) / 2), y: 0, w: box.w, h: box.h }, alt: t('Banner'), name: 'Banner' });
    top = box.h;
  }
  if (brand?.logo?.png) {
    const box = ctx.emuBox(brand.logo, 2400000, 760000);
    const y = top + Math.round(0.5 * IN);
    const x = centered ? Math.round((SLIDE_W - box.w) / 2) : MARGIN_X;
    rels.push({ id: 3, name: 'brand-logo.png' });
    const under = picture ? imageTone(brandRaster(picture.asset), [0, 0, centered ? 1 : 0.4, 0.3]) : { mean: behind, spread: 0 };
    if (under && (under.spread > BUSY_SPREAD || logoNeedsCard(brandRaster(brand.logo), under.mean))) {
      const pad = Math.round(0.14 * IN);
      xml += X.shape(nextId, { name: 'Logo card', box: { x: x - pad, y: y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }, geom: 'roundRect', radius: Math.round(0.1 * IN), fill: 'FFFFFF' });
    }
    xml += X.picture(nextId, { relId: 3, box: { x, y, w: box.w, h: box.h }, alt: t('Logo'), name: 'Logo' });
    top = y + box.h + Math.round(0.2 * IN);
  }

  // The title block: accent rule, title, summary and details, centered in the space left.
  const textW = SLIDE_W - MARGIN_X * 2 - (centered ? 0 : Math.round(1.2 * IN));
  let size = 40;
  let lines = [];
  for (const s of [40, 34, 28]) {
    size = s;
    lines = metrics.wrapText(ast.guide.title, textW, measure(ctx, 'heading', s, true)).flat();
    if (lines.length <= 2) break;
  }
  const titleH = Math.ceil(lines.length * pt(measure(ctx, 'heading', size, true).lineHeight));
  const sub = [guideSummary(ast), ...guideMetaLines(ast)].filter(Boolean);
  const subH = sub.reduce((sum, line, i) => sum + metrics.textHeight(line, textW, measure(ctx, 'body', i ? 16 : 20)), 0) + (sub.length - 1) * pt(4);
  const RULE_H = Math.round(0.06 * IN);
  const ruleGap = Math.round(0.28 * IN);
  const titleGap = Math.round(0.25 * IN);
  const blockH = RULE_H + ruleGap + titleH + (sub.length ? titleGap + subH : 0);
  const bottomLimit = SLIDE_H - Math.round(0.6 * IN);
  const blockTop = Math.max(top + Math.round(0.2 * IN), Math.round(top + (bottomLimit - top - blockH) * 0.45));
  const blockW = centered ? SLIDE_W - MARGIN_X * 2 : textW;
  if (panel) {
    const widest = Math.max(...[ast.guide.title, ...sub].map((line, i) => pt(measure(ctx, i ? 'body' : 'heading', i ? 20 : size, !i).width(line))));
    const w = Math.min(blockW, Math.round(widest)) + Math.round(0.6 * IN);
    const pad = Math.round(0.3 * IN);
    xml += X.shape(nextId, {
      name: 'Text panel',
      box: { x: centered ? Math.round((SLIDE_W - w) / 2) : MARGIN_X - pad, y: blockTop - pad, w, h: blockH + pad * 2 },
      geom: 'roundRect', radius: Math.round(0.12 * IN),
      fill: ink === 'FFFFFF' ? '0F172A' : 'FFFFFF', fillAlpha: ink === 'FFFFFF' ? 0.55 : 0.82,
    });
  }
  let y = blockTop;
  const ruleW = Math.round(1.2 * IN);
  xml += X.shape(nextId, { name: 'Rule', box: { x: centered ? Math.round((SLIDE_W - ruleW) / 2) : MARGIN_X, y, w: ruleW, h: RULE_H }, fill: bandColor || picture ? ink : 'scheme:accent1' });
  y += RULE_H + ruleGap;
  xml += X.shape(nextId, {
    name: 'Title', ph: 'title', box: { x: MARGIN_X, y, w: blockW, h: titleH },
    paras: X.paragraphs(ast.guide.title, { size, bold: true, font: '+mj-lt', color: ink, lang: ctx.lang }, { align }),
    text: { inset: 0 },
  });
  y += titleH + titleGap;
  if (sub.length) {
    xml += X.shape(nextId, {
      name: 'Details', box: { x: MARGIN_X, y, w: blockW, h: subH },
      paras: sub.map((line, i) => X.paragraph(X.run(line, { size: i ? 16 : 20, color: muted, lang: ctx.lang }), { align, spaceAfter: i < sub.length - 1 ? 4 : 0 })),
      text: { inset: 0 },
    });
  }
  return { xml: X.slideXml(xml, { hideMaster: Boolean(brand), background: own ? X.backgroundXml(4) : '' }), rels, media };
}

/** Contents slides: one line per step in up to two columns, paginated. */
function tocSlides(ctx, entries) {
  const { ast, t, tc } = ctx;
  const slides = [];
  const rowH = Math.round(0.42 * IN);
  const headH = Math.round(0.62 * IN);
  const summaryH = Math.round(0.36 * IN);
  const areaTop = ctx.top + headH + summaryH + Math.round(0.2 * IN);
  const areaH = ctx.bottomLimit - areaTop;
  const perColumn = Math.max(1, Math.floor(areaH / rowH));
  const columns = entries.length > perColumn ? 2 : 1;
  const colGap = Math.round(0.5 * IN);
  const colW = (SLIDE_W - MARGIN_X * 2 - (columns - 1) * colGap) / columns;
  const perSlide = perColumn * columns;
  for (let start = 0, page = 0; start < entries.length; start += perSlide, page += 1) {
    const nextId = X.ids();
    let xml = accentBar(ctx, nextId);
    xml += X.shape(nextId, {
      name: 'Title', ph: 'title', box: { x: MARGIN_X, y: ctx.top, w: ctx.titleRight - MARGIN_X, h: headH },
      paras: X.paragraphs(page ? t('Contents (continued)') : tc('Table of contents', 'Contents'), { size: 32, bold: true, font: '+mj-lt', color: 'scheme:tx1', lang: ctx.lang }),
      text: { inset: 0 },
    });
    xml += X.shape(nextId, {
      name: 'Summary', box: { x: MARGIN_X, y: ctx.top + headH, w: SLIDE_W - MARGIN_X * 2, h: summaryH },
      paras: X.paragraphs(guideSummary(ast), { size: 14, color: MUTED, lang: ctx.lang }),
      text: { inset: 0 },
    });
    entries.slice(start, start + perSlide).forEach((entry, i) => {
      const col = Math.floor(i / perColumn);
      const row = i % perColumn;
      const indent = Math.min(entry.depth, 3) * Math.round(0.3 * IN);
      const x = MARGIN_X + col * (colW + colGap) + indent;
      const y = areaTop + row * rowH;
      const top = entry.depth === 0;
      const size = top ? 16 : 14;
      const numW = Math.round(0.65 * IN);
      const titleW = colW - indent - numW;
      xml += X.shape(nextId, {
        name: 'Entry', box: { x, y, w: colW - indent, h: rowH },
        paras: [X.paragraph([
          X.run(`${entry.number}`, { size, bold: true, color: 'scheme:accent1', lang: ctx.lang }),
          X.run(` ${metrics.fitOneLine(entry.title, titleW, measure(ctx, 'body', size, top))}`, { size, bold: top, color: 'scheme:tx1', lang: ctx.lang }),
        ])],
        text: { inset: 0, anchor: 'ctr', autofit: false },
      });
    });
    slides.push({ xml: X.slideXml(xml), rels: [], media: [] });
  }
  return slides;
}

/** One step's slides: the first with its pictures, then any "(continued)" ones. */
function stepSlides(ctx, step, tpl) {
  const { t } = ctx;
  const items = stepItems(step);
  const pics = [];
  const img = ctx.images.get(step.stepId);
  if (img) pics.push({ img, alt: step.altText });
  const chart = (step.blocks || []).some((b) => b.kind === 'flowchart') ? ctx.images.get(flowchartImageKey(step.stepId)) : null;
  if (chart) pics.push({ img: chart, alt: flowchartAlt(step, ctx.ast) });

  const title = step.title || t('Untitled step');
  const header = planHeader(ctx, step.number, title, { titleRight: ctx.titleRight });
  const area = { x: MARGIN_X, y: header.bottom + HEADER_GAP, w: SLIDE_W - MARGIN_X * 2 };
  area.h = ctx.bottomLimit - area.y;
  const position = SCREENSHOT_POSITIONS.includes(tpl.screenshotPosition) ? tpl.screenshotPosition : 'auto';
  const plan = planStep(ctx, items, pics, area, position);

  const slides = [];
  const notes = tpl.speakerNotes || plan.first.mode === 'full' ? notesText(ctx, step, items) : '';
  // The first slide.
  {
    ctx.slideLinks = [];
    const nextId = X.ids();
    const p = plan.first;
    let xml = accentBar(ctx, nextId) + headerXml(ctx, nextId, header);
    const rels = [];
    const media = [];
    let bottom = area.y;
    if (p.column && p.items.length) {
      const col = columnXml(ctx, nextId, p.items, p.column, p.scale);
      xml += col.xml;
      bottom = col.bottom;
    }
    if (p.fit && p.fit.placed.length) {
      // Beside the text the pictures start at the top; below it they follow the text.
      const picTop = p.mode === 'below' ? (p.items.length ? bottom + GAP : area.y) : p.picBox.y;
      p.fit.placed.forEach((at, i) => {
        const relId = 2 + i; // rId1 = layout
        const name = `image${ctx.nextMedia()}.png`;
        media.push({ name, data: encodePng(pics[i].img) });
        rels.push({ id: relId, name });
        xml += X.picture(nextId, {
          relId,
          box: { x: p.picBox.x + at.x, y: picTop + at.y, w: at.w, h: at.h },
          alt: pics[i].alt,
          name: 'Screenshot',
          border: ctx.screenshotBorder,
          shadow: true,
        });
      });
      if (p.below.length) {
        xml += columnXml(ctx, nextId, p.below, { x: area.x, y: picTop + p.fit.h + GAP, w: area.w }, p.scale).xml;
      }
    }
    slides.push({ xml: X.slideXml(xml), rels, media, notes, links: ctx.slideLinks });
  }
  // The rest of the text, on as many slides as it needs.
  const queue = plan.rest.slice();
  const contHeader = planHeader(ctx, step.number, t('{title} (continued)', { title }), { titleRight: ctx.titleRight });
  const contArea = { x: MARGIN_X, y: contHeader.bottom + HEADER_GAP, w: SLIDE_W - MARGIN_X * 2 };
  contArea.h = ctx.bottomLimit - contArea.y;
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const scale = SCALES[0];
    ctx.slideLinks = [];
    const taken = takeFitting(ctx, queue, contArea.w, scale, contArea.h, { force: true });
    const nextId = X.ids();
    const xml = accentBar(ctx, nextId) + headerXml(ctx, nextId, contHeader) + columnXml(ctx, nextId, taken, contArea, scale).xml;
    slides.push({ xml: X.slideXml(xml), rels: [], media: [], notes: '', links: ctx.slideLinks });
  }
  return slides;
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';

function relsXml(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join('')}</Relationships>`;
}

function exportPptx(ast, outDir, template = {}) {
  const tpl = withBrand('pptx', DEFAULT_TEMPLATE, ast, template);
  const brand = ast.branding;
  const { t, tc } = exportText(ast);
  // A brand image's size on a slide: its pixels at 96 dpi, shrunk to fit.
  const emuBox = (asset, maxW, maxH) => {
    const size = fitSize(asset.width * EMU_PER_PX, asset.height * EMU_PER_PX, maxW, maxH);
    return { w: size.width, h: size.height };
  };
  // The master's logo: in the corner the profile picks (top right unless it says otherwise), or none.
  const logoPosition = brand?.pptx?.logoPosition || 'top-right';
  const atBottom = logoPosition.startsWith('bottom');
  const logoBox = brand?.logo?.png && logoPosition !== 'none' ? emuBox(brand.logo, LOGO_MAX_W, atBottom ? FOOTER_LOGO_MAX_H : LOGO_MAX_H) : null;
  const logoAt = logoBox && {
    ...logoBox,
    x: logoPosition.endsWith('left') ? MARGIN_X : SLIDE_W - MARGIN_X - logoBox.w,
    y: atBottom ? SLIDE_H - LOGO_BOTTOM - logoBox.h : LOGO_TOP,
  };
  const footer = Boolean(brand && (brand.footer.text || brand.footer.pageNumbers));
  let bottomLimit = footer ? FOOTER_Y - FOOTER_CLEAR : SLIDE_H - BOTTOM;
  if (logoAt && atBottom) bottomLimit = Math.min(bottomLimit, logoAt.y - FOOTER_CLEAR);
  // Background pictures, as slide media.
  const background = (asset, name) => {
    const media = backgroundMedia(asset, name);
    return media ? { asset, media } : null;
  };
  const titleBackground = tpl.titleSlide ? background(brand?.pptx?.titleBackground, 'brand-title-background') : null;
  const slideBackground = background(brand?.pptx?.slideBackground, 'brand-slide-background');
  let mediaCounter = 0;
  const ctx = {
    ast,
    brand,
    t,
    tc,
    lang: languageTag(ast.language),
    headingFont: brand?.fonts.heading.name || brand?.fonts.body.name || 'Calibri',
    bodyFont: brand?.fonts.body.name || 'Calibri',
    onPrimary: textOn(brand?.colors.primary || '#2563EB').slice(1),
    images: tpl.includeImages ? renderAllImages(ast) : new Map(),
    logoAt,
    logoPosition,
    emuBox,
    titleBackground,
    slideBackground,
    screenshotBorder: brand?.screenshots?.border ? { color: brand.screenshots.borderColor.slice(1), w: 12700 } : { color: 'CBD5E1', w: 9525 },
    // Step headers start below a top-left logo and stop short of a top-right
    // one; body text stops above the footer row and a bottom logo.
    top: logoAt && logoPosition === 'top-left' ? Math.max(TOP, logoAt.y + logoAt.h + Math.round(0.15 * IN)) : TOP,
    titleRight: logoAt && logoPosition === 'top-right' ? logoAt.x - Math.round(0.25 * IN) : SLIDE_W - MARGIN_X,
    bottomLimit,
    nextMedia: () => ++mediaCounter,
    // Links on the slide being drawn: { id, href } or { id, stepId }, as rId100 and up.
    slideLinks: [],
    addLink(target) {
      const same = this.slideLinks.find((l) => (target.href ? l.href === target.href : l.stepId === target.stepId));
      const link = same || { id: `rId${100 + this.slideLinks.length}`, ...target };
      if (!same) this.slideLinks.push(link);
      return { id: link.id, slide: Boolean(link.stepId) };
    },
  };

  const slides = []; // { xml, rels: [{ id, name }], media: [{ name, data }], notes }
  if (tpl.titleSlide) slides.push(titleSlide(ctx));
  const toc = tpl.includeToc && ast.steps.length > 1 ? tocEntries(ast) : [];
  if (toc.length) slides.push(...tocSlides(ctx, toc));
  // Each step's first slide (1-based), for links that jump to it.
  const stepSlide = new Map();
  for (const step of ast.steps) {
    stepSlide.set(step.stepId, slides.length + 1);
    slides.push(...stepSlides(ctx, step, tpl));
  }

  const withNotes = slides.some((s) => s.notes);
  const entries = [];
  const overrides = [];
  const presRels = [`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  const sldIds = [];
  let notesCount = 0;

  slides.forEach((slide, i) => {
    const n = i + 1;
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: slide.xml });
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT}.slide+xml"/>`);
    const slideRels = [
      `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
      ...slide.rels.map((r) => `<Relationship Id="rId${r.id}" Type="${REL}/image" Target="../media/${r.name}"/>`),
      ...(slide.links || []).map((l) => (l.href
        ? `<Relationship Id="${l.id}" Type="${REL}/hyperlink" Target="${escapeXml(l.href)}" TargetMode="External"/>`
        : `<Relationship Id="${l.id}" Type="${REL}/slide" Target="slide${stepSlide.get(l.stepId)}.xml"/>`)),
    ];
    if (slide.notes) {
      notesCount += 1;
      const notesId = Math.max(1, ...slide.rels.map((r) => r.id), ...(slide.links || []).map((l) => Number(l.id.slice(3)))) + 1;
      slideRels.push(`<Relationship Id="rId${notesId}" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${notesCount}.xml"/>`);
      entries.push(
        { name: `ppt/notesSlides/notesSlide${notesCount}.xml`, data: X.notesXml(slide.notes) },
        {
          name: `ppt/notesSlides/_rels/notesSlide${notesCount}.xml.rels`,
          data: relsXml([
            `<Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>`,
            `<Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/>`,
          ]),
        },
      );
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${notesCount}.xml" ContentType="${CT}.notesSlide+xml"/>`);
    }
    entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: relsXml(slideRels) });
    for (const m of slide.media) entries.push({ name: `ppt/media/${m.name}`, data: m.data, store: true });
    presRels.push(`<Relationship Id="rId${n + 1}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${256 + i}" r:id="rId${n + 1}"/>`);
  });

  // The brand's images, shared by the master and the title slide.
  if (brand?.logo?.png) entries.push({ name: 'ppt/media/brand-logo.png', data: brand.logo.png, store: true });
  if (brand?.banner?.png && tpl.titleSlide) entries.push({ name: 'ppt/media/brand-banner.png', data: brand.banner.png, store: true });
  for (const bg of [titleBackground, slideBackground]) if (bg) entries.push({ name: `ppt/media/${bg.media.name}`, data: bg.media.data, store: true });

  let notesMasterRef = '';
  if (withNotes) {
    const relId = slides.length + 2;
    presRels.push(`<Relationship Id="rId${relId}" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`);
    notesMasterRef = `<p:notesMasterIdLst><p:notesMasterId r:id="rId${relId}"/></p:notesMasterIdLst>`;
    entries.push(
      { name: 'ppt/notesMasters/notesMaster1.xml', data: X.notesMasterXml() },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: relsXml([`<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/>`]) },
      { name: 'ppt/theme/theme2.xml', data: themeXml(brand) },
    );
    overrides.push(
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>`,
      '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    );
  }

  const masterRels = [
    `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/>`,
  ];
  if (logoAt) masterRels.push(`<Relationship Id="rId3" Type="${REL}/image" Target="../media/brand-logo.png"/>`);
  if (slideBackground) masterRels.push(`<Relationship Id="rId4" Type="${REL}/image" Target="../media/${slideBackground.media.name}"/>`);

  entries.push(
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${overrides.join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: relsXml([`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`]),
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${X.NS}>
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesMasterRef}
<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>
<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`,
    },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml(ctx) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relsXml(masterRels) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT_XML },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: relsXml([`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`]),
    },
    { name: 'ppt/theme/theme1.xml', data: themeXml(brand) },
  );

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.pptx`);
  fs.writeFileSync(file, zipSync(entries));
  return { file, slideCount: slides.length, imageCount: mediaCounter };
}

module.exports = {
  exportPptx,
  DEFAULT_TEMPLATE,
  OPTION_INFO,
  SCREENSHOT_POSITIONS,
  // For tests.
  _internal: { stepItems, planStep, fitPictures, itemHeight, SLIDE_W, SLIDE_H },
};
