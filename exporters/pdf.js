'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PdfBuilder } = require('../core/pdf');
const { guideSlug, renderAllImages, LEVEL_LABEL } = require('./common');
const { htmlToText } = require('../core/util');

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
  const ensure = (needed) => {
    if (y + needed > size.height - M) {
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

  pdf.addPage();

  if (tpl.includeCover) {
    y = M + usableH * 0.18;
    pdf.rect(M, y - 18, usableW, 3, { fill: tpl.accentColor });
    y += 6;
    writeLines(ast.guide.title, { size: 26, font: 'F2' });
    y += 8;
    if (ast.guide.descriptionText) writeLines(ast.guide.descriptionText, { size: 12, color: [70, 70, 70] });
    y += 14;
    writeLines(`${ast.steps.length} steps — generated ${ast.generatedAt.slice(0, 10)}`, { size: 10, color: [120, 120, 120] });
    pdf.addPage();
    y = M;
  }

  if (tpl.includeToc && ast.steps.length > 1) {
    writeLines('Contents', { size: 16, font: 'F2' });
    y += 4;
    for (const step of ast.steps) {
      writeLines(`${step.number}.  ${step.title || 'Untitled step'}`, {
        size: 10.5, indent: 14 * step.depth,
      });
    }
    pdf.addPage();
    y = M;
  }

  let first = true;
  for (const step of ast.steps) {
    if (step.forceNewPage && !first) { pdf.addPage(); y = M; }
    first = false;
    ensure(40);
    pdf.bookmark(`${step.number}. ${step.title || 'Untitled step'}`);
    const headSize = step.depth > 0 ? 12 : 14;
    writeLines(`${step.number}. ${step.title || 'Untitled step'}${step.skipped ? '  (skipped)' : ''}`, { size: headSize, font: 'F2' });
    pdf.rect(M, y, usableW, 0.8, { fill: [225, 228, 232] });
    y += 8;

    emitBlocks(step, 'before-description');
    if (step.descriptionText) { writeLines(step.descriptionText); y += 4; }

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

    for (const cb of step.codeBlocks) {
      const lines = String(cb.code || '').split('\n');
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
    }

    for (const tb of step.tableBlocks || []) {
      if (!tb.rows || !tb.rows.length) continue;
      const cols = Math.max(...tb.rows.map((r) => r.length));
      const colW = usableW / cols;
      for (let r = 0; r < tb.rows.length; r++) {
        const rowH = 16;
        ensure(rowH + 2);
        if (r === 0) pdf.rect(M, y, usableW, rowH, { fill: [238, 240, 244] });
        pdf.rect(M, y, usableW, rowH, { stroke: [200, 204, 210], lineWidth: 0.6 });
        for (let c = 0; c < cols; c++) {
          pdf.text(String(tb.rows[r][c] ?? '').slice(0, Math.floor(colW / 5)), M + c * colW + 4, y + 3, {
            size: 9, font: r === 0 ? 'F2' : 'F1',
          });
        }
        y += rowH;
      }
      y += 8;
    }

    emitBlocks(step, 'after-description');
    emitBlocks(step, 'after-image');
    y += 10;
  }

  function emitBlocks(step, position) {
    for (const tb of step.textBlocks.filter((b) => b.position === position)) {
      const label = `${LEVEL_LABEL[tb.level] || 'Note'}${tb.title ? `: ${tb.title}` : ''}`;
      const bodyLines = tb.descriptionText ? pdf.wrapText(tb.descriptionText, 9.5, usableW - 18) : [];
      const blockH = 16 + bodyLines.length * 13;
      ensure(blockH + 4);
      pdf.rect(M, y, 3, blockH, { fill: tpl.accentColor });
      pdf.text(label, M + 10, y + 2, { size: 9.5, font: 'F2' });
      let by = y + 16;
      for (const line of bodyLines) {
        pdf.text(line, M + 10, by, { size: 9.5 });
        by += 13;
      }
      y += blockH + 6;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.pdf`);
  fs.writeFileSync(file, pdf.build());
  return { file, imageCount: images.size, pageCount: pdf.pages.length };
}

module.exports = { exportPdf, DEFAULT_TEMPLATE };
