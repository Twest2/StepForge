'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PdfBuilder, FONT_FAMILIES } = require('../core/pdf');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { htmlToText } = require('../core/util');
const { htmlToBlocks } = require('../core/htmlblocks');
const { highlightCode } = require('../core/code-highlight');
const { guideMetaLines } = require('./document-layout');
const { withBrand, brandRaster, fitSize, fontKind, textOn, hexToRgb } = require('./branding');

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

const CODE_SIZE = 9;
const CODE_LINE_H = CODE_SIZE * 1.3;
const CODE_PAD_X = 8;
const CODE_WRAP_INDENT = 2; // characters, on the continuation rows of a wrapped line
// The Plain code theme: the original light-gray box.
const PLAIN_CODE = { background: [243, 244, 246], foreground: [31, 41, 55] };

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function codeFont(run) {
  if (run.bold && run.italic) return 'F8';
  if (run.bold) return 'F6';
  if (run.italic) return 'F7';
  return 'F3';
}

/**
 * Lay a code block out as page rows: lines highlighted in the code theme,
 * tabs expanded, and anything wider than `width` characters wrapped (at a
 * space when there's one in the second half of the row) onto indented rows.
 */
function layoutCode(block, codeStyle, width) {
  const text = String(codeBlockText(block) || '');
  const hl = highlightCode(text, block.language, codeStyle);
  const background = hl ? rgb(hl.background) : PLAIN_CODE.background;
  const lines = hl
    ? hl.lines.map((line) => line.map((run) => ({ text: run.text, font: codeFont(run), color: rgb(run.color) })))
    : text.replace(/\r\n?/g, '\n').split('\n').map((line) => [{ text: line, font: 'F3', color: PLAIN_CODE.foreground }]);
  const rows = [];
  for (const line of lines) {
    const chars = [];
    for (const run of line) {
      for (const ch of run.text.replace(/\t/g, '    ')) chars.push({ ch, run });
    }
    let at = 0;
    let indent = 0;
    do {
      const room = Math.max(1, width - indent);
      let end = Math.min(chars.length, at + room);
      if (end < chars.length) {
        for (let i = end - 1; i > at + room / 2; i--) {
          if (chars[i].ch === ' ') { end = i + 1; break; }
        }
      }
      const runs = [];
      for (const { ch, run } of chars.slice(at, end)) {
        const prev = runs[runs.length - 1];
        if (prev && prev.font === run.font && prev.color === run.color) prev.text += ch;
        else runs.push({ text: ch, font: run.font, color: run.color });
      }
      rows.push({ runs, indent });
      at = end;
      indent = CODE_WRAP_INDENT;
    } while (at < chars.length);
  }
  return { background, rows };
}

function fontForRun(run, fonts = FONT_FAMILIES.sans) {
  if (run.code) return 'F3';
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

/** Split formatted runs into words (font/link tagged) and greedily wrap to maxWidth. */
function wrapRuns(pdf, runs, size, maxWidth, fonts) {
  const words = [];
  for (const run of runs) {
    const font = fontForRun(run, fonts);
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
function layoutDescription(pdf, html, maxWidth, baseSize, fonts = FONT_FAMILIES.sans) {
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
    const lines = wrapRuns(pdf, runs, size, maxWidth - indent, fonts);
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
  const tpl = withBrand('pdf', DEFAULT_TEMPLATE, ast, template);
  // A brand profile sets the text and link colors, and the closest built-in
  // fonts to its own (Helvetica, Times or Courier).
  const brand = ast.branding;
  const bodyFonts = FONT_FAMILIES[brand ? fontKind(brand.fonts.body.name) : 'sans'];
  const headFonts = FONT_FAMILIES[brand ? fontKind(brand.fonts.heading.name) : 'sans'];
  const ink = brand ? hexToRgb(brand.colors.text) : [0, 0, 0];
  const linkColor = brand ? hexToRgb(brand.colors.accent) : tpl.accentColor;
  const size = PAGE_SIZES[tpl.pageSize] || PAGE_SIZES.a4;
  const pdf = new PdfBuilder({
    pageWidth: size.width,
    pageHeight: size.height,
    title: ast.guide.title || 'Untitled guide',
    author: ast.guide.metadata?.author || '',
  });
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
  const writeLines = (text, { size: fs_ = 10.5, font = bodyFonts.regular, color = ink, leading = 1.35, indent = 0 } = {}) => {
    for (const line of pdf.wrapText(text, fs_, usableW - indent, font)) {
      ensure(fs_ * leading);
      pdf.text(line, M + indent, y, { size: fs_, font, color });
      y += fs_ * leading;
    }
  };
  /** Render laid-out description items, preserving bold/italic/links/lists. */
  const writeDescription = (html, { size: baseSize = 10.5, color = ink, indent: indentBase = 0 } = {}) => {
    const { items } = layoutDescription(pdf, html, usableW - indentBase, baseSize, bodyFonts);
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
        if (idx === 0 && item.prefix) pdf.text(item.prefix, textX - LIST_INDENT, y, { size: item.size, font: bodyFonts.regular, color });
        const parts = line.map((word) => ({
          text: word.text,
          font: word.font,
          color: word.href ? linkColor : (item.muted ? [100, 100, 100] : color),
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
      ? layoutDescription(pdf, tb.descriptionHtml, usableW - 18, 9.5, bodyFonts)
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

  const codeChars = Math.floor((usableW - 2 * CODE_PAD_X) / pdf.textWidth('M', CODE_SIZE, 'F3'));
  const codeLayouts = new Map();
  const codeLayoutFor = (block) => {
    if (!codeLayouts.has(block)) codeLayouts.set(block, layoutCode(block, ast.codeStyle, codeChars));
    return codeLayouts.get(block);
  };
  const measureCode = (block) => codeLayoutFor(block).rows.length * CODE_LINE_H + 16;

  /**
   * Draw a code block: the theme background behind each page's share of the
   * rows (so a block continuing on the next page keeps its background), and
   * each row as colored runs.
   */
  const drawCode = (block) => {
    const { background, rows } = codeLayoutFor(block);
    ensure(Math.min(rows.length, 4) * CODE_LINE_H + 12);
    let i = 0;
    let padTop = 6;
    while (i < rows.length) {
      if (i > 0) {
        pdf.addPage();
        y = M;
        padTop = 4;
      }
      const fits = Math.floor((size.height - M - y - padTop - 4) / CODE_LINE_H);
      const n = Math.max(1, Math.min(rows.length - i, fits));
      pdf.rect(M, y, usableW, padTop + n * CODE_LINE_H + 4, { fill: background });
      y += padTop;
      for (const row of rows.slice(i, i + n)) {
        const x = M + CODE_PAD_X + pdf.textWidth(' '.repeat(row.indent), CODE_SIZE, 'F3');
        pdf.textRun(row.runs, x, y, CODE_SIZE);
        y += CODE_LINE_H;
      }
      y += 4;
      i += n;
    }
    y += 6;
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
    const titleLines = pdf.wrapText(titleText, headSize, usableW, headFonts.bold);
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
    if (step.descriptionHtml) head += layoutDescription(pdf, step.descriptionHtml, usableW, 10.5, bodyFonts).height;
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

  const logo = brand ? brandRaster(brand.logo) : null;
  const banner = brand ? brandRaster(brand.banner) : null;

  /**
   * The cover's banner, logo, title and accent rule. Standard puts the logo
   * above a left-aligned title; Centered centers them; Band sets them on a
   * full-width block of the brand's primary color.
   */
  const drawCoverHead = () => {
    const style = brand?.cover || 'standard';
    const titleSize = 28;
    const lineH = titleSize * 1.35;
    if (banner) {
      let w = usableW;
      let h = (banner.height / banner.width) * w;
      if (h > 170) { h = 170; w = (banner.width / banner.height) * h; }
      pdf.image(banner, M + (usableW - w) / 2, y, w, h);
      y += h + 18;
    }
    const logoBox = logo ? fitSize(logo.width, logo.height, 200, 56) : null;
    const titleLines = pdf.wrapText(ast.guide.title, titleSize, usableW, headFonts.bold);
    if (style === 'band') {
      const top = banner ? y - 8 : 0;
      const padTop = banner ? 24 : M;
      const height = padTop + (logoBox ? logoBox.height + 18 : 0) + titleLines.length * lineH + 28;
      const onBand = hexToRgb(textOn(brand.colors.primary));
      pdf.rect(0, top, size.width, height, { fill: hexToRgb(brand.colors.primary) });
      y = top + padTop;
      if (logoBox) { pdf.image(logo, M, y, logoBox.width, logoBox.height); y += logoBox.height + 18; }
      for (const line of titleLines) { pdf.text(line, M, y, { size: titleSize, font: headFonts.bold, color: onBand }); y += lineH; }
      y = top + height + 22;
      return;
    }
    const centered = style === 'centered';
    const xFor = (w) => (centered ? M + (usableW - w) / 2 : M);
    if (logoBox) { pdf.image(logo, xFor(logoBox.width), y, logoBox.width, logoBox.height); y += logoBox.height + 18; }
    for (const line of titleLines) {
      ensure(lineH);
      pdf.text(line, xFor(pdf.textWidth(line, titleSize, headFonts.bold)), y, { size: titleSize, font: headFonts.bold, color: ink });
      y += lineH;
    }
    y += 10;
    const ruleW = centered ? 120 : usableW;
    pdf.rect(xFor(ruleW), y, ruleW, 3, { fill: tpl.accentColor });
    y += 16;
  };

  if (tpl.includeCover) {
    // Keep the cover title near the top edge instead of vertically centering it.
    y = M;
    drawCoverHead();
    const metaLines = guideMetaLines(ast);
    // Centered covers center the short lines too; the description stays a paragraph.
    const coverLine = (text, opts) => {
      if (brand?.cover !== 'centered') { writeLines(text, opts); return; }
      for (const line of pdf.wrapText(text, opts.size, usableW, bodyFonts.regular)) {
        ensure(opts.size * 1.35);
        pdf.text(line, M + (usableW - pdf.textWidth(line, opts.size, bodyFonts.regular)) / 2, y, { ...opts, font: bodyFonts.regular });
        y += opts.size * 1.35;
      }
    };
    for (const line of metaLines) coverLine(line, { size: 11, color: [90, 90, 90] });
    if (metaLines.length) y += 8;
    if (ast.guide.descriptionHtml) writeDescription(ast.guide.descriptionHtml, { size: 12, color: [70, 70, 70] });
    y += 14;
    coverLine(`${ast.steps.length} steps — generated ${ast.generatedAt.slice(0, 10)}`, { size: 10, color: [120, 120, 120] });
    pdf.addPage();
    y = M;
  }

  // Filled in below as each step claims its page, so the Contents entries
  // above (already laid out before pagination starts) can link to it.
  const tocTargets = new Map(); // stepId -> { pageIndex }

  if (tpl.includeToc && ast.steps.length > 1) {
    writeLines('Contents', { size: 16, font: headFonts.bold });
    y += 4;
    const tocSize = 10.5;
    const lineH = tocSize * 1.35;
    for (const step of ast.steps) {
      const indent = 14 * step.depth;
      const target = {};
      tocTargets.set(step.stepId, target);
      for (const line of pdf.wrapText(`${step.number}.  ${step.title || 'Untitled step'}`, tocSize, usableW - indent, bodyFonts.regular)) {
        ensure(lineH);
        pdf.text(line, M + indent, y, { size: tocSize, font: bodyFonts.regular, color: tpl.accentColor });
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
    writeLines(`${step.number}. ${step.title || 'Untitled step'}${step.skipped ? '  (skipped)' : ''}`, { size: headSize, font: headFonts.bold });
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
        drawCode(block);
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
              size: 9, font: r === 0 ? bodyFonts.bold : bodyFonts.regular, color: ink,
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
      ? layoutDescription(pdf, tb.descriptionHtml, usableW - 18, 9.5, bodyFonts)
      : { items: [], height: 0 };
    const blockH = 16 + bodyH;
    const style = LEVEL_STYLE[tb.level] || LEVEL_STYLE.info;
    ensure(blockH + 4);
    pdf.rect(M, y, usableW, blockH, { fill: style.tint });
    pdf.rect(M, y, 3, blockH, { fill: style.accent });
    pdf.text(label, M + 10, y + 2, { size: 9.5, font: bodyFonts.bold, color: style.accent });
    let by = y + 16;
    for (const item of items) {
      if (item.kind === 'hr') {
        pdf.rect(M + 10, by + 5, item.width, 0.8, { fill: [225, 228, 232] });
        by += 12;
        continue;
      }
      item.lines.forEach((line, idx) => {
        const textX = M + 10 + item.indent;
        if (idx === 0 && item.prefix) pdf.text(item.prefix, textX - LIST_INDENT, by, { size: item.size, font: bodyFonts.regular, color: ink });
        const parts = line.map((word) => ({
          text: word.text,
          font: word.font,
          color: word.href ? linkColor : (item.muted ? [100, 100, 100] : ink),
        }));
        pdf.textRun(parts, textX, by, item.size);
        by += item.lineHeight;
      });
      by += 4;
    }
    y += blockH + 6;
  }

  if (brand) {
    // The brand's header (logo, text) and footer (text, page numbers) in the
    // margins of every page but the cover, which shows the logo already.
    const muted = [110, 116, 124];
    const total = pdf.pages.length;
    const headLogo = brand.header.logo && logo ? fitSize(logo.width, logo.height, 120, Math.max(8, Math.min(20, M - 16))) : null;
    const rightAlign = (text, font) => size.width - M - pdf.textWidth(text, 8, font);
    for (let i = tpl.includeCover ? 1 : 0; i < total; i++) {
      pdf.onPage(i, () => {
        if (headLogo) pdf.image(logo, M, (M - headLogo.height) / 2, headLogo.width, headLogo.height);
        if (brand.header.text) {
          pdf.text(brand.header.text, rightAlign(brand.header.text, bodyFonts.regular), (M - 8) / 2, { size: 8, font: bodyFonts.regular, color: muted });
        }
        const footY = size.height - M / 2 - 4;
        if (brand.footer.text) pdf.text(brand.footer.text, M, footY, { size: 8, font: bodyFonts.regular, color: muted });
        if (brand.footer.pageNumbers) {
          const label = `Page ${i + 1} of ${total}`;
          pdf.text(label, rightAlign(label, bodyFonts.regular), footY, { size: 8, font: bodyFonts.regular, color: muted });
        }
      });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.pdf`);
  fs.writeFileSync(file, pdf.build());
  return { file, imageCount: images.size, pageCount: pdf.pages.length };
}

module.exports = { exportPdf, DEFAULT_TEMPLATE };
