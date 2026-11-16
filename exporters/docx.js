'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('../core/zip');
const { escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, calloutLabel, stepContentGroups, codeBlockText, wordCodeRuns, wordCodeShading, flowchartImageKey, flowchartAlt, stepLinkText, goToParts } = require('./common');
const { exportText } = require('../core/export-text');
const { highlightCode } = require('../core/code-highlight');
const { guideMetaLines, guideSummary, tocEntries } = require('./document-layout');
const { fitSize, textOn, screenshotOptions } = require('./branding');

/**
 * DOCX exporter: WordprocessingML built directly (no dependency), one
 * heading per step with positioned text blocks around the description and
 * screenshot, plus code blocks (Courier) and tables. A brand profile sets the
 * Normal and Heading styles' fonts and colors, puts its banner and logo on
 * the cover, and adds a page header (logo, text) and footer (text, page
 * numbers) to every page after the cover.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  includeToc: true,
  imageWidthTwips: 9000, // ~15.9cm inside A4 margins
};

// The Export dialog's labels, groups and units for these options (exporters/index.js FORMAT_INFO).
const OPTION_INFO = {
  includeImages: { label: 'Include screenshots', group: 'Contents' },
  includeToc: { label: 'Add a table of contents', group: 'Contents' },
  imageWidthTwips: { label: 'Screenshot width', group: 'Screenshots', unit: 'cm', scale: 1440 / 2.54, min: 0.1, step: 'any' },
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
// Match the fixed A4 section below. Leave headroom for font/layout differences
// between Word and LibreOffice; this is a conservative fit estimate, not a
// replacement for either application's pagination engine.
const PRINTABLE_HEIGHT_TWIPS = 16838 - 1134 * 2;
const PRINTABLE_WIDTH_TWIPS = 11906 - 1134 * 2;
const STEP_KEEP_BUDGET = PRINTABLE_HEIGHT_TWIPS - 720;

function paragraphText(xml) {
  return xml.replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Estimate emitted blocks only; do not read or resize screenshot pixels. */
function blockHeight(xml, width = PRINTABLE_WIDTH_TWIPS) {
  if (xml.startsWith('<w:tbl>')) {
    const cells = [...xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)];
    return 160 + Math.max(0, ...cells.map((cell) => {
      const cellWidth = Number(cell[1].match(/<w:tcW w:w="(\d+)"/)?.[1]) || width;
      return [...cell[1].matchAll(/<w:p>[\s\S]*?<\/w:p>/g)]
        .reduce((sum, match) => sum + blockHeight(match[0], cellWidth - 360), 0);
    }));
  }
  const imageHeights = [...xml.matchAll(/<wp:extent cx="\d+" cy="(\d+)"/g)]
    .map((match) => Number(match[1]) / 635);
  const font = Math.max(22, ...[...xml.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => Number(m[1])));
  // Half-points -> twips, with a deliberately generous average glyph width.
  const charsPerLine = Math.max(1, Math.floor(width / (font * 10 * 0.65)));
  const lines = paragraphText(xml).split('\n').reduce((sum, line) =>
    sum + Math.max(1, Math.ceil([...line].reduce((n, c) => n + (c.codePointAt(0) > 0x2ff ? 2 : 1), 0) / charsPerLine)), 0);
  const heading = /<w:pStyle w:val="Heading/.test(xml);
  return Math.max(imageHeights.reduce((a, b) => a + b, 0), lines * font * 10 * 1.3)
    + (heading ? 480 : 160);
}

function paragraphKeeps(xml, next, lines) {
  if (!xml.startsWith('<w:p>')) return xml;
  const match = xml.match(/^<w:p>(?:<w:pPr>([\s\S]*?)<\/w:pPr>)?/);
  const props = (match[1] || '').replace(/<w:keep(?:Next|Lines)\b[^>]*\/>/g, '');
  const style = props.match(/<w:pStyle\b[^>]*\/>/)?.[0] || '';
  const keeps = `<w:keepNext w:val="${next ? 1 : 0}"/><w:keepLines w:val="${lines ? 1 : 0}"/>`;
  return `<w:p><w:pPr>${style}${keeps}${props.replace(style, '')}</w:pPr>${xml.slice(match[0].length)}`;
}

/**
 * A keep chain belongs to one emitted step, never to Normal or to a sibling.
 * Short notes following its picture are part of the chain. Oversized steps
 * release their long lead-in paragraphs, keeping only the fitting suffix
 * around the picture; long instructions may then split naturally.
 */
function paginateStep(parts, screenshot, { hasChildren, forceNewPage }) {
  const imageIndex = screenshot ? parts.findIndex((xml) => xml.includes(screenshot)) : -1;
  const headingIndex = parts.findIndex((xml) => /<w:bookmarkStart\b/.test(xml));
  if (imageIndex < 0) {
    // Preserve a process heading's attachment to its first child, but don't
    // attach a standalone title-only step to an unrelated following step.
    if (!hasChildren && headingIndex === parts.length - 1) {
      parts[headingIndex] = paragraphKeeps(parts[headingIndex], false, blockHeight(parts[headingIndex]) <= STEP_KEEP_BUDGET);
    }
    return parts;
  }
  // A leading callout is part of a forced-new-page step too. Keep just one
  // break, before its first paragraph, rather than stranding that callout.
  if (forceNewPage && headingIndex > 0 && parts[0].startsWith('<w:p>')) {
    parts[headingIndex] = parts[headingIndex].replace('<w:pageBreakBefore/>', '');
    // CT_PPr is an ordered sequence: pageBreakBefore must follow keepLines and
    // precede the callout's border and shading.
    parts[0] = paragraphKeeps(parts[0], true, true).replace('<w:keepLines w:val="1"/>', '$&<w:pageBreakBefore/>');
  }
  const heights = parts.map((xml) => blockHeight(xml));
  let end = imageIndex;
  let height = heights[imageIndex];
  // Do not pull code blocks, tables, extra figures or long commentary into
  // the screenshot's caption chain.
  while (end + 1 < parts.length) {
    const note = parts[end + 1];
    if (!note.startsWith('<w:p>') || /<w:drawing>|Courier New|<w:rFonts/.test(note)
      || paragraphText(note).length > 600 || heights[end + 1] > 2800
      || height + heights[end + 1] > STEP_KEEP_BUDGET) break;
    height += heights[++end];
  }
  let start = imageIndex;
  while (start > 0 && height + heights[start - 1] <= STEP_KEEP_BUDGET) height += heights[--start];
  return parts.map((xml, i) => {
    if (xml.startsWith('<w:tbl>')) {
      // The normal side-by-side row stays atomic. An over-page row must be
      // allowed to split instead of overflowing or creating blank pages.
      return heights[i] > STEP_KEEP_BUDGET ? xml.replace('<w:cantSplit/>', '') : xml;
    }
    if (i >= start && i <= end && height <= STEP_KEEP_BUDGET) return paragraphKeeps(xml, i < end, true);
    const next = i === headingIndex && i + 1 < parts.length;
    return paragraphKeeps(xml, next, heights[i] <= STEP_KEEP_BUDGET);
  });
}

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

/** An inline picture; `border` is a hex color for a thin line around it. */
function drawing(relId, widthPx, heightPx, maxWidthTwips, alt, name = `Screenshot ${relId}`, { border = '' } = {}) {
  // scale to maxWidth (twips -> px at 96dpi: twips/15)
  const maxWpx = maxWidthTwips / 15;
  let w = widthPx, h = heightPx;
  if (w > maxWpx) { h = (h * maxWpx) / w; w = maxWpx; }
  // Whole pixels as before, but a very narrow picture keeps its sub-pixel
  // width rather than rounding to an invisible zero extent.
  const px = (v) => (v >= 1 ? Math.round(v) : v);
  const cx = Math.max(1, Math.round(px(w) * EMU_PER_PX)), cy = Math.max(1, Math.round(px(h) * EMU_PER_PX));
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${relId}" name="${escapeXml(name)}" descr="${escapeXml(alt)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${relId}" name="img${relId}" descr="${escapeXml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    (border ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${border.replace('#', '')}"/></a:solidFill></a:ln>` : '') +
    '</pic:spPr>' +
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

// Side by side: the screenshot's column and the description's, inside A4 margins.
const SPLIT_IMAGE_TWIPS = 5300;
const SPLIT_TEXT_TWIPS = 4338;

/** A borderless two-column table: screenshot on the left, description on the right. */
function splitTable(left, right) {
  const none = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="nil"/>`).join('');
  const cell = (width, content, margin) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`
    + `<w:tcMar><w:${margin} w:w="180" w:type="dxa"/></w:tcMar></w:tcPr>${content}</w:tc>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${SPLIT_IMAGE_TWIPS + SPLIT_TEXT_TWIPS}" w:type="dxa"/><w:tblLayout w:type="fixed"/>`
    + `<w:tblBorders>${none}</w:tblBorders><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="${SPLIT_IMAGE_TWIPS}"/><w:gridCol w:w="${SPLIT_TEXT_TWIPS}"/></w:tblGrid>`
    + `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(SPLIT_IMAGE_TWIPS, left, 'right')}${cell(SPLIT_TEXT_TWIPS, right, 'left')}</w:tr></w:tbl>`;
}

function fontsXml(name) {
  const font = escapeXml(name);
  return `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>`;
}

function stylesXml(brand) {
  const bodyFont = brand?.fonts.body.name || 'Calibri';
  const headingFont = brand?.fonts.heading.name || '';
  const primary = brand?.colors.primary.slice(1);
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
      ${headingFont ? fontsXml(headingFont) : ''}
      <w:b/>
      <w:color w:val="${color}"/>
      <w:sz w:val="${size}"/>
      <w:szCs w:val="${size}"/>
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
        <w:rFonts w:ascii="${escapeXml(bodyFont)}" w:hAnsi="${escapeXml(bodyFont)}"/>
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
      ${fontsXml(bodyFont)}
      ${brand ? `<w:color w:val="${brand.colors.text.slice(1)}"/>` : ''}
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
  </w:style>
  ${headingStyle('Heading1', 'Heading 1', 0, 30, primary || '2563EB')}
  ${headingStyle('Heading2', 'Heading 2', 1, 26, primary || '1D4ED8')}
  ${headingStyle('Heading3', 'Heading 3', 2, 22, primary || '1E40AF')}
  ${tocStyle(1)}
  ${tocStyle(2)}
  ${tocStyle(3)}
</w:styles>`;
}

const HDR_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

/** A paragraph with something at the left margin and something at the right, as headers and footers have. */
function marginParagraph(left, right) {
  return p(`${left}${right ? `<w:r><w:tab/></w:r>${right}` : ''}`,
    `<w:tabs><w:tab w:val="right" w:pos="${TOC_TAB_POS}"/></w:tabs><w:spacing w:after="0"/>`);
}

function headerXml(content = '') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${HDR_NS}>${content || p('')}</w:hdr>`;
}

function footerXml(content = '') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${HDR_NS}>${content || p('')}</w:ftr>`;
}

/**
 * "Page 3 of 9" in the export's language, kept current by Word's PAGE and
 * NUMPAGES fields.
 */
function pageNumberRuns(rpr, ast) {
  const text = (value) => (value ? `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>` : '');
  const field = (instr) => `<w:fldSimple w:instr=" ${instr} "><w:r>${rpr}<w:t>1</w:t></w:r></w:fldSimple>`;
  const { t } = exportText(ast);
  return t('Page {page} of {total}').split(/(\{page\}|\{total\})/)
    .map((part) => (part === '{page}' ? field('PAGE') : part === '{total}' ? field('NUMPAGES') : text(part))).join('');
}

function exportDocx(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const { t, tc } = exportText(ast);
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  const media = [];   // { name, data }
  const rels = [];    // relationship XML strings
  let relCounter = 1; // rId1 reserved for settings.xml; rId2 for styles.xml
  let bookmarkCounter = 0;
  let stepImageCount = 0;

  rels.push(`<Relationship Id="rId${++relCounter}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);

  const brand = ast.branding;
  const primary = brand ? brand.colors.primary.slice(1) : '2563EB';
  const ink = brand ? brand.colors.text.slice(1) : '1F2937';
  const imageRel = (name, data) => {
    const relId = ++relCounter;
    media.push({ name, data });
    rels.push(`<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
    return relId;
  };

  const body = [];
  // Under a flowchart picture: its shapes' step links (Word can't link parts of a picture).
  const chartLinkParagraph = (chart) => {
    const seen = new Set();
    const links = (chart?.links || []).filter((link) => !seen.has(link.stepId) && seen.add(link.stepId)).map((link) => {
      const target = ast.steps.find((s) => s.stepId === link.stepId);
      return target ? `<w:hyperlink w:anchor="${bookmarkName(target)}">${run(stepLinkText(target, ast), { size: 20, color: primary })}</w:hyperlink>` : '';
    }).filter(Boolean);
    const { before, after } = goToParts(ast);
    const plain = (text) => (text ? run(text, { size: 20, color: ink }) : '');
    if (links.length) body.push(p(plain(before) + links.join(run(' · ', { size: 20, color: ink })) + plain(after)));
  };
  // Cover: banner, logo and title. Centered centers them; Band sets the
  // logo and title on the brand's primary color.
  const cover = brand?.cover || 'standard';
  const jc = cover === 'centered' ? '<w:jc w:val="center"/>' : '';
  const band = cover === 'band' ? `<w:shd w:val="clear" w:color="auto" w:fill="${primary}"/>` : '';
  if (brand?.banner?.png) {
    const size = fitSize(brand.banner.width, brand.banner.height, 600, 200);
    body.push(p(drawing(imageRel('brand-banner.png', brand.banner.png), size.width, size.height, 99999, t('Banner'), 'Banner'), jc));
  }
  if (brand?.logo?.png) {
    const size = fitSize(brand.logo.width, brand.logo.height, 240, 80);
    body.push(p(drawing(imageRel('brand-logo.png', brand.logo.png), size.width, size.height, 99999, t('Logo'), 'Logo'),
      `${band}${band ? '<w:spacing w:before="0" w:after="0"/><w:ind w:left="0"/>' : ''}${jc}`));
  }
  body.push(band
    ? p(run(ast.guide.title, { bold: true, size: 48, color: textOn(brand.colors.primary).slice(1) }), `${band}<w:spacing w:before="120" w:after="240"/>`)
    : p(run(ast.guide.title, { bold: true, size: 48 }),
      `<w:pBdr><w:bottom w:val="single" w:sz="24" w:space="12" w:color="${primary}"/></w:pBdr>${jc}`));
  if (ast.guide.descriptionText) body.push(p(run(ast.guide.descriptionText, { size: 22, color: '444444' })));
  for (const line of guideMetaLines(ast)) body.push(p(run(line, { size: 20, color: '6B7280' })));
  body.push(p(run(guideSummary(ast), { size: 18, color: '888888' })));

  body.push(pageBreak());

  if (tpl.includeToc && ast.steps.length > 1) {
    body.push(p(
      run(tc('Table of contents', 'Contents'), { bold: true, size: 28 }),
      `<w:pBdr><w:bottom w:val="single" w:sz="20" w:space="8" w:color="${primary}"/></w:pBdr>`
    ));
    body.push(...tocFieldParagraphs(ast));
    body.push(pageBreak());
  }

  // The brand's screenshot alignment, border and step layout.
  const shots = screenshotOptions(ast);
  const alignProps = shots.align === 'left' ? '' : `<w:jc w:val="${shots.align}"/>`;

  const emitTextBlock = (tb) => {
    const style = LEVEL_STYLE[tb.level] || LEVEL_STYLE.info;
    const label = calloutLabel(tb, ast);
    body.push(p(
      `${run(label, { bold: true, size: 20, color: style.color })}${tb.descriptionText ? run('\n' + tb.descriptionText, { size: 20, color: ink }) : ''}`,
      `<w:shd w:val="clear" w:fill="${style.fill}"/><w:pBdr><w:left w:val="single" w:sz="24" w:space="4" w:color="${style.color}"/></w:pBdr>`
    ));
  };

  const parentIds = new Set(ast.steps.map((step) => step.parentStepId).filter(Boolean));
  for (const step of ast.steps) {
    const stepStart = body.length;
    let screenshotParagraph = '';
    const headingLevel = Math.min(3, Math.max(1, step.depth + 1));
    const headSize = headingLevel === 1 ? 30 : headingLevel === 2 ? 26 : 22;
    const bookmarkId = ++bookmarkCounter;
    const anchor = bookmarkName(step);
    const {
      beforeTitle,
      afterTitle,
      beforeDescription,
      afterDescription,
      beforeImage,
      afterImage,
      rest,
    } = stepContentGroups(step);
    // Text blocks and the flowchart block, at their positions.
    const emit = (tb, maxTwips = tpl.imageWidthTwips) => {
      if (tb.kind !== 'flowchart') { emitTextBlock(tb); return; }
      const chart = images.get(flowchartImageKey(step.stepId));
      if (!chart) return;
      const relId = imageRel(`flowchart${relCounter + 1}.png`, encodePng(chart));
      // Drawn at 2x: show it at its natural size, never wider than a screenshot.
      const widthTwips = Math.min(maxTwips, Math.round((chart.width / 2) * 15));
      body.push(p(drawing(relId, chart.width, chart.height, widthTwips, flowchartAlt(step, ast)), alignProps));
      chartLinkParagraph(step.flowchartImage);
      stepImageCount += 1;
    };
    for (const tb of beforeTitle) emit(tb);
    body.push(p(
      `<w:bookmarkStart w:id="${bookmarkId}" w:name="${anchor}"/>` +
      run(`${step.number}. ${step.title || t('Untitled step')}`, { bold: true, size: headSize }) +
      `<w:bookmarkEnd w:id="${bookmarkId}"/>`,
      headingParagraphProps(step.depth, step.forceNewPage)
    ));
    for (const tb of afterTitle) emit(tb);
    const img = images.get(step.stepId);
    const description = step.descriptionText ? p(run(step.descriptionText, { size: 20, color: ink })) : '';
    const screenshot = (maxTwips) => {
      const relId = ++relCounter;
      const name = `image${relCounter}.png`;
      media.push({ name, data: encodePng(img) });
      rels.push(`<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      stepImageCount += 1;
      // Very tall pictures must still fit a printable page. Limit only their
      // on-page extent; the embedded PNG bytes and annotations are untouched.
      const boundedWidth = Math.min(maxTwips, (img.width / img.height) * (PRINTABLE_HEIGHT_TWIPS - 1440));
      screenshotParagraph = p(drawing(relId, img.width, img.height, boundedWidth, step.altText, undefined, { border: shots.border ? shots.borderColor : '' }), alignProps);
      return screenshotParagraph;
    };
    if (img && description && shots.layout === 'side-by-side') {
      // Screenshot on the left, description on the right. Callouts keep their
      // place: before the image above it, after the description under it.
      for (const tb of beforeDescription) emit(tb);
      const cell = (fill) => { const start = body.length; fill(); return body.splice(start).join(''); };
      const left = cell(() => { for (const tb of beforeImage) emit(tb, SPLIT_IMAGE_TWIPS); body.push(screenshot(SPLIT_IMAGE_TWIPS)); });
      const right = cell(() => { body.push(description); for (const tb of afterDescription) emit(tb, SPLIT_TEXT_TWIPS); });
      body.push(splitTable(left, right));
      if (step.image?.flowchart) chartLinkParagraph(step.image);
    } else {
      for (const tb of beforeDescription) emit(tb);
      if (description) body.push(description);
      for (const tb of afterDescription) emit(tb);
      for (const tb of beforeImage) emit(tb);
      if (img) {
        body.push(screenshot(tpl.imageWidthTwips));
        if (step.image?.flowchart) chartLinkParagraph(step.image);
      }
    }

    for (const tb of afterImage) emit(tb);

    for (const block of rest) {
      if (block.kind === 'text') {
        emitTextBlock(block);
      } else if (block.kind === 'code') {
        const hl = highlightCode(codeBlockText(block), block.language, ast.codeStyle);
        body.push(hl
          ? p(wordCodeRuns(hl, { size: 18 }), wordCodeShading(hl))
          : p(run(codeBlockText(block), { size: 18, font: 'Courier New', color: '1F2937' }), '<w:shd w:val="clear" w:fill="F3F4F6"/>'));
      } else if (block.kind === 'table') {
        if (block.rows && block.rows.length) body.push(table(block.rows), p(''));
      }
    }
    const stepParts = body.splice(stepStart);
    body.push(...paginateStep(stepParts, screenshotParagraph, {
      hasChildren: parentIds.has(step.stepId), forceNewPage: step.forceNewPage,
    }));
  }

  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:updateFields w:val="true"/>
</w:settings>`;

  // Page header and footer, left off the cover (titlePg gives it empty ones).
  const parts = [];
  let sectionRefs = '';
  if (brand) {
    const rpr = `<w:rPr><w:sz w:val="16"/><w:color w:val="6B7280"/></w:rPr>`;
    const textRun = (text) => (text ? `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : '');
    const headerRels = [];
    let headLogo = '';
    if (brand.header.logo && brand.logo?.png) {
      const size = fitSize(brand.logo.width, brand.logo.height, 160, 32);
      headLogo = drawing(1, size.width, size.height, 99999, t('Logo'), 'Header logo');
      headerRels.push('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/brand-logo.png"/>');
      if (!media.some((m) => m.name === 'brand-logo.png')) media.push({ name: 'brand-logo.png', data: brand.logo.png });
    }
    const pageNumbers = brand.footer.pageNumbers ? pageNumberRuns(rpr, ast) : '';
    const add = (kind, n, xml, partRels = []) => {
      const relId = ++relCounter;
      parts.push({ name: `word/${kind}${n}.xml`, data: xml, kind, rels: partRels });
      rels.push(`<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${kind}${n}.xml"/>`);
      return `rId${relId}`;
    };
    const header = add('header', 1, headerXml(headLogo || brand.header.text ? marginParagraph(headLogo, textRun(brand.header.text)) : ''), headerRels);
    const footer = add('footer', 1, footerXml(brand.footer.text || pageNumbers ? marginParagraph(textRun(brand.footer.text), pageNumbers) : ''));
    const firstHeader = add('header', 2, headerXml());
    const firstFooter = add('footer', 2, footerXml());
    sectionRefs = `<w:headerReference w:type="default" r:id="${header}"/><w:headerReference w:type="first" r:id="${firstHeader}"/>`
      + `<w:footerReference w:type="default" r:id="${footer}"/><w:footerReference w:type="first" r:id="${firstFooter}"/>`;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${body.join('\n')}
<w:sectPr>${sectionRefs}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"${brand ? ' w:header="567" w:footer="567"' : ''}/>${brand ? '<w:titlePg/>' : ''}</w:sectPr>
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
${parts.map((part) => `<Override PartName="/${part.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part.kind}+xml"/>`).join('\n')}
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
    { name: 'word/styles.xml', data: stylesXml(brand) },
    ...parts.flatMap((part) => [
      { name: part.name, data: part.data },
      ...(part.rels.length ? [{
        name: part.name.replace('word/', 'word/_rels/').concat('.rels'),
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${part.rels.join('')}</Relationships>`,
      }] : []),
    ]),
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, store: true })),
  ];

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.docx`);
  fs.writeFileSync(file, zipSync(entries));
  return { file, imageCount: stepImageCount };
}

module.exports = { exportDocx, DEFAULT_TEMPLATE, OPTION_INFO };
