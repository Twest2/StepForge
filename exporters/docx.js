'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('../core/zip');
const { escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { guideMetaLines, guideSummary, tocEntries } = require('./document-layout');

/**
 * DOCX exporter: WordprocessingML built directly (no dependency), one
 * heading + description + screenshot per step, text blocks, code blocks
 * (Courier), and tables.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  includeToc: true,
  imageWidthTwips: 9000, // ~15.9cm inside A4 margins
};

// Callout styling per text-block level, matching the colors used in the
// HTML/PDF exports so a "Tip" looks distinct from a "Warning" at a glance.
const LEVEL_STYLE = {
  info: { fill: 'EFF6FF', color: '1D4ED8' }, // blue — Note
  success: { fill: 'ECFDF5', color: '047857' }, // green — Tip
  warn: { fill: 'FFFBEB', color: 'B45309' }, // amber — Warning
  error: { fill: 'FEF2F2', color: 'B91C1C' }, // red — Important
};

const EMU_PER_PX = 9525; // 96 dpi

function p(children, props = '') {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${children}</w:p>`;
}

function run(text, { bold = false, size = 22, font = '', color = '' } = {}) {
  const rpr = [
    bold ? '<w:b/>' : '',
    `<w:sz w:val="${size}"/>`,
    font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>` : '',
    color ? `<w:color w:val="${color}"/>` : '',
  ].join('');
  const lines = String(text).split('\n');
  return lines.map((line, i) =>
    `${i > 0 ? '<w:r><w:br/></w:r>' : ''}<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
  ).join('');
}

function drawing(relId, widthPx, heightPx, maxWidthTwips) {
  // scale to maxWidth (twips -> px at 96dpi: twips/15)
  const maxWpx = maxWidthTwips / 15;
  let w = widthPx, h = heightPx;
  if (w > maxWpx) { h = Math.round((h * maxWpx) / w); w = Math.round(maxWpx); }
  const cx = Math.round(w * EMU_PER_PX), cy = Math.round(h * EMU_PER_PX);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${relId}" name="Screenshot ${relId}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${relId}" name="img${relId}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function pageBreak() {
  return p('<w:r><w:br w:type="page"/></w:r>');
}

// Width (in twips) of the text column inside the A4 page margins used by
// <w:sectPr> below (11906 - 1134*2), i.e. where TOC page-number tabs land.
const TOC_TAB_POS = 9638;

/** Bookmark name anchoring a step's heading, referenced by its TOC entry. */
function bookmarkName(step) {
  return `toc_${String(step.number).replace(/\./g, '_')}`;
}

/** A `PAGEREF <anchor>` field, cached as "1" until Word recalculates it. */
function pageRefField(anchor) {
  return '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> PAGEREF ${anchor} \\h </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
}

/** One TOC line: hyperlink to the step's heading, dot leader, page number. */
function tocEntryContent(entry) {
  const anchor = bookmarkName(entry.step);
  return `<w:hyperlink w:anchor="${anchor}">${run(`${entry.number}. ${entry.title}`, { size: 20 })}</w:hyperlink>` +
    '<w:r><w:tab/></w:r>' +
    pageRefField(anchor);
}

/**
 * The TOC as real, navigable entries (one per step) rather than a bare
 * "Update contents in Word" placeholder, so the table is correct on first
 * open. Still wrapped in a `TOC` field (spanning the first..last paragraph)
 * so Word can refresh page numbers via Update Field / the updateFields prompt.
 */
function tocFieldParagraphs(ast) {
  const entries = tocEntries(ast);
  const beginField = '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const endField = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

  return entries.map((entry, i) => {
    const pPr = `<w:pStyle w:val="TOC${Math.min(3, Math.max(1, entry.depth + 1))}"/>` +
      `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${TOC_TAB_POS}"/></w:tabs>`;
    const lead = i === 0 ? beginField : '';
    const trail = i === entries.length - 1 ? endField : '';
    return `<w:p><w:pPr>${pPr}</w:pPr>${lead}${tocEntryContent(entry)}${trail}</w:p>`;
  });
}

function headingStyleForDepth(depth) {
  return `Heading${Math.min(3, depth + 1)}`;
}

function headingOutlineLevelForDepth(depth) {
  return Math.min(2, Math.max(0, depth));
}

function headingParagraphProps(depth, forceNewPage = false) {
  const parts = [];
  if (forceNewPage) parts.push('<w:pageBreakBefore/>');
  parts.push(`<w:pStyle w:val="${headingStyleForDepth(depth)}"/>`);
  parts.push(`<w:outlineLvl w:val="${headingOutlineLevelForDepth(depth)}"/>`);
  return parts.join('');
}

function table(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const grid = `<w:tblGrid>${'<w:gridCol w:w="2400"/>'.repeat(cols)}</w:tblGrid>`;
  const borders = '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="C8CCD2"/>`).join('') +
    '</w:tblBorders>';
  const body = rows.map((row, ri) => {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      cells.push(`<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${p(run(row[c] ?? '', { bold: ri === 0, size: 20 }))}</w:tc>`);
    }
    return `<w:tr>${cells.join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${body}</w:tbl>`;
}

function stylesXml() {
  const headingStyle = (styleId, name, outlineLvl, size, color) => `
  <w:style w:type="paragraph" w:styleId="${styleId}">
    <w:name w:val="${name}"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:uiPriority w:val="${9 + outlineLvl}"/>
    <w:qFormat/>
    <w:unhideWhenUsed/>
    <w:pPr>
      <w:keepNext/>
      <w:keepLines/>
      <w:spacing w:before="${outlineLvl === 0 ? 360 : outlineLvl === 1 ? 240 : 180}" w:after="120"/>
      <w:outlineLvl w:val="${outlineLvl}"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:sz w:val="${size}"/>
      <w:szCs w:val="${size}"/>
      <w:color w:val="${color}"/>
    </w:rPr>
  </w:style>`;

  const tocStyle = (level) => `
  <w:style w:type="paragraph" w:styleId="TOC${level}">
    <w:name w:val="toc ${level}"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:autoRedefine/>
    <w:uiPriority w:val="39"/>
    <w:unhideWhenUsed/>
    <w:pPr>
      <w:spacing w:after="60"/>
      <w:ind w:left="${(level - 1) * 360}"/>
      <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${TOC_TAB_POS}"/></w:tabs>
    </w:pPr>
    <w:rPr>
      <w:sz w:val="20"/>
      <w:szCs w:val="20"/>
    </w:rPr>
  </w:style>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="160"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:uiPriority w:val="1"/>
    <w:rPr>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
    </w:rPr>
  </w:style>
  ${headingStyle('Heading1', 'Heading 1', 0, 30, '2563EB')}
  ${headingStyle('Heading2', 'Heading 2', 1, 26, '1D4ED8')}
  ${headingStyle('Heading3', 'Heading 3', 2, 22, '1E40AF')}
  ${tocStyle(1)}
  ${tocStyle(2)}
  ${tocStyle(3)}
</w:styles>`;
}

function exportDocx(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  const media = [];   // { name, data }
  const rels = [];    // relationship XML strings
  let relCounter = 1; // rId1 reserved for settings.xml; rId2 for styles.xml
  let bookmarkCounter = 0;
  let stepImageCount = 0;

  rels.push(`<Relationship Id="rId${++relCounter}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);

  const body = [];
  body.push(p(
    run(ast.guide.title, { bold: true, size: 48 }),
    '<w:pBdr><w:bottom w:val="single" w:sz="24" w:space="12" w:color="2563EB"/></w:pBdr>'
  ));
  if (ast.guide.descriptionText) body.push(p(run(ast.guide.descriptionText, { size: 22, color: '444444' })));
  for (const line of guideMetaLines(ast)) body.push(p(run(line, { size: 20, color: '6B7280' })));
  body.push(p(run(guideSummary(ast), { size: 18, color: '888888' })));

  body.push(pageBreak());

  if (tpl.includeToc && ast.steps.length > 1) {
    body.push(p(
      run('Contents', { bold: true, size: 28 }),
      '<w:pBdr><w:bottom w:val="single" w:sz="20" w:space="8" w:color="2563EB"/></w:pBdr>'
    ));
    body.push(...tocFieldParagraphs(ast));
    body.push(pageBreak());
  }

  const emitTextBlock = (tb) => {
    const style = LEVEL_STYLE[tb.level] || LEVEL_STYLE.info;
    const label = `${LEVEL_LABEL[tb.level] || 'Note'}${tb.title ? `: ${tb.title}` : ''}`;
    body.push(p(
      `${run(label, { bold: true, size: 20, color: style.color })}${tb.descriptionText ? run('\n' + tb.descriptionText, { size: 20, color: '1F2937' }) : ''}`,
      `<w:shd w:val="clear" w:fill="${style.fill}"/><w:pBdr><w:left w:val="single" w:sz="24" w:space="4" w:color="${style.color}"/></w:pBdr>`
    ));
  };

  for (const step of ast.steps) {
    const headingLevel = Math.min(3, Math.max(1, step.depth + 1));
    const headSize = headingLevel === 1 ? 30 : headingLevel === 2 ? 26 : 22;
    const bookmarkId = ++bookmarkCounter;
    const anchor = bookmarkName(step);
    body.push(p(
      `<w:bookmarkStart w:id="${bookmarkId}" w:name="${anchor}"/>` +
      run(`${step.number}. ${step.title || 'Untitled step'}`, { bold: true, size: headSize }) +
      `<w:bookmarkEnd w:id="${bookmarkId}"/>`,
      headingParagraphProps(step.depth, step.forceNewPage)
    ));

    const { before, rest } = stepContentGroups(step);
    for (const tb of before) emitTextBlock(tb);
    if (step.descriptionText) body.push(p(run(step.descriptionText, { size: 20, color: '1F2937' })));

    const img = images.get(step.stepId);
    if (img) {
      const relId = ++relCounter;
      const name = `image${relCounter}.png`;
      media.push({ name, data: encodePng(img) });
      rels.push(`<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      body.push(p(drawing(relId, img.width, img.height, tpl.imageWidthTwips)));
      stepImageCount += 1;
    }

    for (const block of rest) {
      if (block.kind === 'text') {
        emitTextBlock(block);
      } else if (block.kind === 'code') {
        body.push(p(run(codeBlockText(block), { size: 18, font: 'Courier New', color: '1F2937' }),
          '<w:shd w:val="clear" w:fill="F3F4F6"/>'));
      } else if (block.kind === 'table') {
        if (block.rows && block.rows.length) body.push(table(block.rows), p(''));
      }
    }
  }

  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:updateFields w:val="true"/>
</w:settings>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${body.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body>
</w:document>`;

  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    { name: 'word/document.xml', data: documentXml },
    {
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
${rels.join('\n')}
</Relationships>`,
    },
    { name: 'word/settings.xml', data: settingsXml },
    { name: 'word/styles.xml', data: stylesXml() },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, store: true })),
  ];

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.docx`);
  fs.writeFileSync(file, zipSync(entries));
  return { file, imageCount: stepImageCount };
}

module.exports = { exportDocx, DEFAULT_TEMPLATE };
