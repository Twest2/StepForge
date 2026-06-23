'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PdfBuilder } = require('../core/pdf');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { htmlToText } = require('../core/util');
const { htmlToBlocks } = require('../core/htmlblocks');

const LIST_INDENT = 14;
const QUOTE_INDENT = 10;
const HEADING_BUMP = { h1: 2.5, h2: 2, h3: 1.5, h4: 1 };

// Callout styling per text-block level, matching the colors used in the
// HTML/editor UI so a "Tip" looks distinct from a "Warning" at a glance.
const LEVEL_STYLE = {
  info: { accent: [59, 130, 246], tint: [239, 246, 255] }, // blue — Note
  success: { accent: [16, 185, 129], tint: [236, 253, 245] }, // green — Tip
  warn: { accent: [245, 158, 11], tint: [255, 251, 235] }, // amber — Warning
  error: { accent: [239, 68, 68], tint: [254, 242, 242] }, // red — Important
};

function fontForRun(run) {
  if (run.code) return 'F3';
  if (run.bold && run.italic) return 'F5';
  if (run.bold) return 'F2';
  if (run.italic) return 'F4';
  return 'F1';
}

/** Split formatted runs into words (font/link tagged) and greedily wrap to maxWidth. */
function wrapRuns(pdf, runs, size, maxWidth) {
  const words = [];
  for (const run of runs) {
    const font = fontForRun(run);
    for (const part of run.text.split(/(\s+)/)) {
      if (part === '') continue;
      words.push({ text: part, font, href: run.href });
    }
  }
  const lines = [];
  let line = [];
  let w = 0;
  for (const word of words) {
    const isSpace = /^\s+$/.test(word.text);
    const ww = pdf.textWidth(word.text, size, word.font);
    if (!isSpace && line.length && w + ww > maxWidth) {
      lines.push(line);
      line = [];
      w = 0;
    }
    if (isSpace && !line.length) continue;
    line.push(word);
    w += ww;
  }
  if (line.length) lines.push(line);
  return lines;
}

/**
 * Lay out description HTML into render-ready items, preserving bold,
 * italic, links, lists, blockquotes and headings.
 * Returns { items, height }; items: { kind: 'hr', width } | { kind: 'text',
 * lines, size, lineHeight, indent, prefix, muted }.
 */
function layoutDescription(pdf, html, maxWidth, baseSize) {
  const items = [];
  let height = 0;
  for (const block of htmlToBlocks(html || '')) {
    if (block.type === 'hr') {
      items.push({ kind: 'hr', width: maxWidth });
      height += 12;
      continue;
    }
    let size = baseSize;
    let runs = block.runs;
    let indent = (block.indent || 0) * LIST_INDENT;
    let prefix = null;
    let muted = false;
    if (HEADING_BUMP[block.type]) {
      size = baseSize + HEADING_BUMP[block.type];
      runs = runs.map((r) => ({ ...r, bold: true }));
    } else if (block.type === 'li') {
      prefix = '•';
      indent += LIST_INDENT;
    } else if (block.type === 'oli') {
      prefix = `${block.n}.`;
      indent += LIST_INDENT;
    } else if (block.type === 'blockquote') {
      indent += QUOTE_INDENT;
      muted = true;
    }
    const lines = wrapRuns(pdf, runs, size, maxWidth - indent);
    const lineHeight = size * 1.35;
    items.push({ kind: 'text', lines, size, lineHeight, indent, prefix, muted });
    height += lines.length * lineHeight + 4;
  }
  return { items, height };
}

/**
 * PDF exporter: cover block, optional TOC, one section per step with the
 * annotated screenshot, text blocks, code blocks, and tables. Generated
 * natively from the Render AST (see build/agent_audit.md for the fallback
 * rationale). Bookmarks navigate to each step.
 */

const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

const DEFAULT_TEMPLATE = {
  pageSize: 'a4',
  margin: 48,
  includeCover: true,
  includeToc: true,
  includeImages: true,
  imageMaxHeightRatio: 0.55, // of usable page height
  accentColor: [37, 99, 235],
};

function exportPdf(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const size = PAGE_SIZES[tpl.pageSize] || PAGE_SIZES.a4;
  const pdf = new PdfBuilder({ pageWidth: size.width, pageHeight: size.height });
  const M = tpl.margin;
  const usableW = size.width - 2 * M;
  const usableH = size.height - 2 * M;
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  let y = M;
  // Never start a page break when already at the top of a page — an item
  // taller than a full page (e.g. a step's combined head height) must
  // still render and overflow naturally rather than push out a blank page.
  const ensure = (needed) => {
    if (y > M && y + needed > size.height - M) {
      pdf.addPage();
      y = M;
    }
  };
  const writeLines = (text, { size: fs_ = 10.5, font = 'F1', color = [0, 0, 0], leading = 1.35, indent = 0 } = {}) => {
    for (const line of pdf.wrapText(text, fs_, usableW - indent, font)) {
      ensure(fs_ * leading);
      pdf.text(line, M + indent, y, { size: fs_, font, color });
      y += fs_ * leading;
    }
  };
  /** Render laid-out description items, preserving bold/italic/links/lists. */
  const writeDescription = (html, { size: baseSize = 10.5, color = [0, 0, 0], indent: indentBase = 0 } = {}) => {
    const { items } = layoutDescription(pdf, html, usableW - indentBase, baseSize);
    for (const item of items) {
      if (item.kind === 'hr') {
        ensure(12);
        pdf.rect(M + indentBase, y + 5, item.width, 0.8, { fill: [225, 228, 232] });
        y += 12;
        continue;
      }
      item.lines.forEach((line, idx) => {
        ensure(item.lineHeight);
        const textX = M + indentBase + item.indent;
        if (idx === 0 && item.prefix) pdf.text(item.prefix, textX - LIST_INDENT, y, { size: item.size, font: 'F1', color });
        const parts = line.map((word) => ({
          text: word.text,
          font: word.font,
          color: word.href ? tpl.accentColor : (item.muted ? [100, 100, 100] : color),
        }));
        pdf.textRun(parts, textX, y, item.size);
        y += item.lineHeight;
      });
      y += 4;
    }
  };

  /** Height a callout block (emitBlock) will occupy, including its trailing gap. */
  const measureBlock = (tb) => {
    const { height: bodyH } = tb.descriptionHtml
      ? layoutDescription(pdf, tb.descriptionHtml, usableW - 18, 9.5)
      : { height: 0 };
    return 16 + bodyH + 6;
  };

  /** Height an image will occupy on the page, including its trailing gap. */
  const measureImage = (stepId) => {
    const img = images.get(stepId);
    if (!img) return 0;
    const maxH = usableH * tpl.imageMaxHeightRatio;
    let h = (img.height / img.width) * usableW;
    if (h > maxH) h = maxH;
    return h + 10;
  };

  const measureCode = (block) => {
    const lines = String(codeBlockText(block) || '').split('\n');
    const lineH = 9 * 1.3;
    return lines.length * lineH + 16;
  };

  const measureTable = (block) => {
    if (!block.rows || !block.rows.length) return 0;
    return block.rows.length * 16 + 8;
  };

  /**
   * Compute the vertical space a step will need: `head` is the title, the
   * accent rule, positioned text blocks, the description, and the image —
   * kept together on one page — and `total` adds the remaining blocks plus
   * the trailing gap, used to decide whether the whole step fits on a
   * fresh page.
   */
  const measureStep = (step) => {
    const headSize = step.depth > 0 ? 12 : 14;
    const titleText = `${step.number}. ${step.title || 'Untitled step'}${step.skipped ? '  (skipped)' : ''}`;
    const titleLines = pdf.wrapText(titleText, headSize, usableW, 'F2');
    let head = Math.max(40, titleLines.length * headSize * 1.35 + 8);

    const {
      beforeTitle,
      afterTitle,
      beforeDescription,
      afterDescription,
      beforeImage,
      afterImage,
      rest,
    } = stepContentGroups(step);
    for (const tb of [...beforeTitle, ...afterTitle, ...beforeDescription, ...afterDescription, ...beforeImage, ...afterImage]) {
      head += measureBlock(tb);
    }
    if (step.descriptionHtml) head += layoutDescription(pdf, step.descriptionHtml, usableW, 10.5).height;
    head += measureImage(step.stepId);

    let restHeight = 0;
    for (const block of rest) {
      if (block.kind === 'text') restHeight += measureBlock(block);
      else if (block.kind === 'code') restHeight += measureCode(block);
      else if (block.kind === 'table') restHeight += measureTable(block);
    }

    return { head, total: head + restHeight + 10 };
  };

  pdf.addPage();

  if (tpl.includeCover) {
    // Keep the cover title near the top edge instead of vertically centering it.
    y = M;
    writeLines(ast.guide.title, { size: 28, font: 'F2' });
    y += 10;
    pdf.rect(M, y, usableW, 3, { fill: tpl.accentColor });
    y += 16;
    const meta = ast.guide.metadata || {};
    const metaLines = [
      meta.author && `Author: ${meta.author}`,
      meta.coAuthors && `Co-authors: ${meta.coAuthors}`,
      meta.organization && `Organization: ${meta.organization}`,
    ].filter(Boolean);
    for (const line of metaLines) writeLines(line, { size: 11, color: [90, 90, 90] });
    if (metaLines.length) y += 8;
    if (ast.guide.descriptionHtml) writeDescription(ast.guide.descriptionHtml, { size: 12, color: [70, 70, 70] });
    y += 14;
    writeLines(`${ast.steps.length} steps — generated ${ast.generatedAt.slice(0, 10)}`, { size: 10, color: [120, 120, 120] });
    pdf.addPage();
    y = M;
  }

  // Filled in below as each step claims its page, so the Contents entries
  // above (already laid out before pagination starts) can link to it.
  const tocTargets = new Map(); // stepId -> { pageIndex }

  if (tpl.includeToc && ast.steps.length > 1) {
    writeLines('Contents', { size: 16, font: 'F2' });
    y += 4;
    const tocSize = 10.5;
    const lineH = tocSize * 1.35;
    for (const step of ast.steps) {
      const indent = 14 * step.depth;
      const target = {};
      tocTargets.set(step.stepId, target);
      for (const line of pdf.wrapText(`${step.number}.  ${step.title || 'Untitled step'}`, tocSize, usableW - indent, 'F1')) {
        ensure(lineH);
        pdf.text(line, M + indent, y, { size: tocSize, color: tpl.accentColor });
        pdf.linkRect(M + indent, y, usableW - indent, lineH, target);
        y += lineH;
      }
    }
    pdf.addPage();
    y = M;
  }

  let first = true;
  let forcedFresh = false;
  const pageBottom = size.height - M;
  for (const step of ast.steps) {
    const { head: headHeight, total: totalHeight } = measureStep(step);
    // Start a fresh page when: the step's "New page" toggle is set; the
    // previous step overflowed past one page (so this step shouldn't share
    // the spillover page); or this step doesn't fit in what's left of the
    // current page. The last check is skipped when already at the top of a
    // page, so an overlong step doesn't push out a blank page first.
    const needsFreshPage = !first && (
      step.forceNewPage || forcedFresh || (y > M && y + totalHeight > pageBottom)
    );
    if (needsFreshPage) { pdf.addPage(); y = M; }
    first = false;
    // Keep the title, accent rule, lead-in blocks, description, and image
    // together — never split across a page boundary.
    ensure(headHeight);
    pdf.bookmark(`${step.number}. ${step.title || 'Untitled step'}`);
    const tocTarget = tocTargets.get(step.stepId);
    if (tocTarget) tocTarget.pageIndex = pdf.pages.length - 1;
    const {
      beforeTitle,
      afterTitle,
      beforeDescription,
      afterDescription,
      beforeImage,
      afterImage,
      rest,
    } = stepContentGroups(step);
    for (const tb of beforeTitle) emitBlock(tb);
    const headSize = step.depth > 0 ? 12 : 14;
    writeLines(`${step.number}. ${step.title || 'Untitled step'}${step.skipped ? '  (skipped)' : ''}`, { size: headSize, font: 'F2' });
    pdf.rect(M, y, usableW, 0.8, { fill: [225, 228, 232] });
    y += 8;

    for (const tb of afterTitle) emitBlock(tb);
    for (const tb of beforeDescription) emitBlock(tb);
    if (step.descriptionHtml) writeDescription(step.descriptionHtml);
    for (const tb of afterDescription) emitBlock(tb);
    for (const tb of beforeImage) emitBlock(tb);

    const img = images.get(step.stepId);
    if (img) {
      const maxH = usableH * tpl.imageMaxHeightRatio;
      let w = usableW;
      let h = (img.height / img.width) * w;
      if (h > maxH) { h = maxH; w = (img.width / img.height) * h; }
      ensure(h + 6);
      pdf.image(img, M, y, w, h);
      y += h + 10;
    }
    for (const tb of afterImage) emitBlock(tb);

    for (const block of rest) {
      if (block.kind === 'text') {
        emitBlock(block);
      } else if (block.kind === 'code') {
        const lines = String(codeBlockText(block) || '').split('\n');
        const lineH = 9 * 1.3;
        ensure(Math.min(lines.length, 4) * lineH + 12);
        const boxH = lines.length * lineH + 10;
        pdf.rect(M, y, usableW, Math.min(boxH, size.height - M - y), { fill: [243, 244, 246] });
        y += 6;
        for (const line of lines) {
          ensure(lineH);
          pdf.text(line.slice(0, 95), M + 8, y, { size: 9, font: 'F3', color: [31, 41, 55] });
          y += lineH;
        }
        y += 10;
      } else if (block.kind === 'table') {
        if (!block.rows || !block.rows.length) continue;
        const cols = Math.max(...block.rows.map((r) => r.length));
        const colW = usableW / cols;
        for (let r = 0; r < block.rows.length; r++) {
          const rowH = 16;
          ensure(rowH + 2);
          if (r === 0) pdf.rect(M, y, usableW, rowH, { fill: [238, 240, 244] });
          pdf.rect(M, y, usableW, rowH, { stroke: [200, 204, 210], lineWidth: 0.6 });
          for (let c = 0; c < cols; c++) {
            pdf.text(String(block.rows[r][c] ?? '').slice(0, Math.floor(colW / 5)), M + c * colW + 4, y + 3, {
              size: 9, font: r === 0 ? 'F2' : 'F1',
            });
          }
          y += rowH;
        }
        y += 8;
      }
    }

    y += 10;
    forcedFresh = totalHeight > usableH;
  }

  function emitBlock(tb) {
    const label = `${LEVEL_LABEL[tb.level] || 'Note'}${tb.title ? `: ${tb.title}` : ''}`;
    const { items, height: bodyH } = tb.descriptionHtml
      ? layoutDescription(pdf, tb.descriptionHtml, usableW - 18, 9.5)
      : { items: [], height: 0 };
    const blockH = 16 + bodyH;
    const style = LEVEL_STYLE[tb.level] || LEVEL_STYLE.info;
    ensure(blockH + 4);
    pdf.rect(M, y, usableW, blockH, { fill: style.tint });
    pdf.rect(M, y, 3, blockH, { fill: style.accent });
    pdf.text(label, M + 10, y + 2, { size: 9.5, font: 'F2', color: style.accent });
    let by = y + 16;
    for (const item of items) {
      if (item.kind === 'hr') {
        pdf.rect(M + 10, by + 5, item.width, 0.8, { fill: [225, 228, 232] });
        by += 12;
        continue;
      }
      item.lines.forEach((line, idx) => {
        const textX = M + 10 + item.indent;
        if (idx === 0 && item.prefix) pdf.text(item.prefix, textX - LIST_INDENT, by, { size: item.size, font: 'F1' });
        const parts = line.map((word) => ({
          text: word.text,
          font: word.font,
          color: word.href ? tpl.accentColor : (item.muted ? [100, 100, 100] : [0, 0, 0]),
        }));
        pdf.textRun(parts, textX, by, item.size);
        by += item.lineHeight;
      });
      by += 4;
    }
    y += blockH + 6;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.pdf`);
  fs.writeFileSync(file, pdf.build());
  return { file, imageCount: images.size, pageCount: pdf.pages.length };
}

module.exports = { exportPdf, DEFAULT_TEMPLATE };
