'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('../core/zip');
const { escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { guideMetaLines, guideSummary } = require('./document-layout');
const raster = require('../core/raster');

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

function calloutIcon(level) {
  const img = raster.createImage(24, 24, [0, 0, 0, 0]);
  const fill = {
    info: [37, 99, 235, 255],
    success: [16, 185, 129, 255],
    warn: [245, 158, 11, 255],
    error: [239, 68, 68, 255],
  }[level] || [37, 99, 235, 255];
  raster.fillOval(img, 1, 1, 22, 22, fill);
  const glyph = level === 'success' ? 'v' : level === 'warn' ? '!' : level === 'error' ? 'x' : 'i';
  raster.drawTextCentered(img, 12, 13, glyph, 12, [255, 255, 255, 255]);
  return img;
}

function pageBreak() {
  return p('<w:r><w:br w:type="page"/></w:r>');
}

function headingStyleForDepth(depth) {
  return `Heading${Math.min(3, depth + 1)}`;
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

function exportDocx(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  const media = [];   // { name, data }
  const rels = [];    // relationship XML strings
  let relCounter = 1; // rId1 reserved for settings.xml
  let stepImageCount = 0;

  const iconRelIds = {};
  for (const level of ['info', 'success', 'warn', 'error']) {
    const icon = calloutIcon(level);
    const relId = ++relCounter;
    iconRelIds[level] = relId;
    const name = `callout-${level}.png`;
    media.push({ name, data: encodePng(icon) });
    rels.push(`<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
  }

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
    body.push(p(
      `<w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u"><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Update contents in Word</w:t></w:r></w:fldSimple>`
    ));
    body.push(pageBreak());
  }

  const emitTextBlock = (tb) => {
    const style = LEVEL_STYLE[tb.level] || LEVEL_STYLE.info;
    const iconRelId = iconRelIds[tb.level] || iconRelIds.info;
    const label = `${LEVEL_LABEL[tb.level] || 'Note'}${tb.title ? `: ${tb.title}` : ''}`;
    body.push(p(
      `${drawing(iconRelId, 16, 16, 240)}${run(label, { bold: true, size: 20, color: style.color })}${tb.descriptionText ? run('\n' + tb.descriptionText, { size: 20, color: '1F2937' }) : ''}`,
      `<w:shd w:val="clear" w:fill="${style.fill}"/><w:pBdr><w:left w:val="single" w:sz="24" w:space="4" w:color="${style.color}"/></w:pBdr>`
    ));
  };

  for (const step of ast.steps) {
    const headingLevel = Math.min(3, Math.max(1, step.depth + 1));
    const headSize = headingLevel === 1 ? 30 : headingLevel === 2 ? 26 : 22;
    body.push(p(
      run(`${step.number}. ${step.title || 'Untitled step'}`, { bold: true, size: headSize }),
      `${step.forceNewPage ? '<w:pageBreakBefore/>' : ''}<w:pStyle w:val="${headingStyleForDepth(step.depth)}"/>`
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
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, store: true })),
  ];

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.docx`);
  fs.writeFileSync(file, zipSync(entries));
  return { file, imageCount: stepImageCount };
}

module.exports = { exportDocx, DEFAULT_TEMPLATE };
