'use strict';

const { zipSync } = require('../core/zip');
const { escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { htmlToBlocks } = require('../core/htmlblocks');
const { LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { guideMetaLines } = require('./document-layout');

/**
 * A Word document shaped for Confluence's "Import Word document" feature
 * (Cloud: Create > More actions > Templates and import; Data Center:
 * More options > Import Word Document), so the page can be created from
 * the browser without API access.
 *
 * It sticks to what that importer turns into native Confluence content:
 * Heading styles, real Word lists, tables, inline PNG images and
 * hyperlinks. No cover page, contents field, page breaks, text boxes or
 * shapes, which the importer drops or turns into placeholders.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_PX = 9525;
const MAX_IMAGE_PX = 624; // 6.5in at 96dpi: fits Letter and A4 margins

const CALLOUT = {
  info: { fill: 'DEEBFF', border: '0052CC' },
  success: { fill: 'E3FCEF', border: '00875A' },
  warn: { fill: 'FFFAE6', border: 'FF991F' },
  error: { fill: 'FFEBE6', border: 'DE350B' },
};

function runXml(text, { bold, italic, code, link } = {}) {
  const rpr = [
    link ? '<w:rStyle w:val="Hyperlink"/>' : '',
    code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : '',
    bold ? '<w:b/>' : '',
    italic ? '<w:i/>' : '',
  ].join('');
  return String(text).split('\n').map((line, i) => (
    `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
  )).join('');
}

function paragraph(content, props = '') {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
}

class WordDocument {
  constructor(ast) {
    this.ast = ast;
    this.rels = [];
    this.media = [];
    this.nums = []; // numbering instances: { id, abstractId }
    this.nextRel = 3; // rId1 styles, rId2 numbering
    this.nextBookmark = 1;
  }

  rel(type, target, external = false) {
    const id = `rId${this.nextRel++}`;
    this.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  }

  newList(ordered) {
    const id = this.nums.length + 1;
    this.nums.push({ id, abstractId: ordered ? 1 : 0 });
    return id;
  }

  anchorFor(step) {
    return `step_${String(step.number).replace(/\./g, '_')}`;
  }

  runs(runs) {
    return runs.map((r) => {
      if (r.href && r.href.startsWith('step:')) {
        const target = this.ast.steps.find((s) => s.stepId === r.href.slice(5));
        if (!target) return runXml(r.text, r);
        return `<w:hyperlink w:anchor="${this.anchorFor(target)}">${runXml(r.text, { ...r, link: true })}</w:hyperlink>`;
      }
      if (r.href && /^(https?:|mailto:)/i.test(r.href)) {
        return `<w:hyperlink r:id="${this.rel('hyperlink', r.href, true)}">${runXml(r.text, { ...r, link: true })}</w:hyperlink>`;
      }
      return runXml(r.text, r);
    }).join('');
  }

  /** Rich description HTML -> Word paragraphs, with real lists. */
  richText(html) {
    const out = [];
    let list = null; // { ordered, id }
    for (const block of htmlToBlocks(html || '')) {
      const isList = block.type === 'li' || block.type === 'oli';
      const ordered = block.type === 'oli';
      if (!isList) list = null;
      if (block.type === 'hr') {
        out.push(paragraph('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C1C7D0"/></w:pBdr>'));
        continue;
      }
      if (isList) {
        if (!list || list.ordered !== ordered || (ordered && block.n === 1 && block.indent <= 1)) {
          list = { ordered, id: this.newList(ordered) };
        }
        const lvl = Math.min(2, Math.max(0, block.indent - 1));
        out.push(paragraph(this.runs(block.runs), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${list.id}"/></w:numPr>`));
        continue;
      }
      if (/^h[1-4]$/.test(block.type)) {
        out.push(paragraph(this.runs(block.runs), '<w:pStyle w:val="Heading4"/>'));
      } else if (block.type === 'blockquote') {
        out.push(paragraph(this.runs(block.runs), '<w:pStyle w:val="Quote"/>'));
      } else {
        out.push(paragraph(this.runs(block.runs)));
      }
    }
    return out.join('');
  }

  callout(tb) {
    const style = CALLOUT[tb.level] || CALLOUT.info;
    const label = tb.title || LEVEL_LABEL[tb.level] || 'Note';
    const border = `<w:left w:val="single" w:sz="24" w:space="0" w:color="${style.border}"/>`;
    const content = paragraph(runXml(label, { bold: true })) + (this.richText(tb.descriptionHtml) || paragraph(''));
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>`
      + '<w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid>'
      + `<w:tr><w:tc><w:tcPr><w:tcW w:w="5000" w:type="pct"/><w:shd w:val="clear" w:color="auto" w:fill="${style.fill}"/></w:tcPr>${content}</w:tc></w:tr></w:tbl>`
      + paragraph('');
  }

  table(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const colW = Math.floor(9360 / cols);
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="C1C7D0"/>`).join('');
    const body = rows.map((row, r) => `<w:tr>${Array.from({ length: cols }, (_, c) => (
      `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${r === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>' : ''}</w:tcPr>`
      + `${paragraph(runXml(row[c] ?? '', { bold: r === 0 }))}</w:tc>`
    )).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>`
      + `<w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(cols)}</w:tblGrid>${body}</w:tbl>${paragraph('')}`;
  }

  image(img, alt) {
    const name = `image${this.media.length + 1}.png`;
    this.media.push({ name, data: encodePng(img) });
    const id = this.rel('image', `media/${name}`);
    const scale = Math.min(1, MAX_IMAGE_PX / img.width);
    const cx = Math.round(img.width * scale * EMU_PER_PX);
    const cy = Math.round(img.height * scale * EMU_PER_PX);
    const docPrId = this.media.length;
    return paragraph('<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="${escapeXml(name)}" descr="${escapeXml(alt)}"/>`
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXml(name)}" descr="${escapeXml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>');
  }

  step(step, images, tpl) {
    const g = stepContentGroups(step);
    const blocks = (list) => list.map((tb) => this.callout(tb)).join('');
    const bm = this.nextBookmark++;
    const style = step.depth > 0 ? 'Heading3' : 'Heading2';
    const heading = paragraph(
      `<w:bookmarkStart w:id="${bm}" w:name="${this.anchorFor(step)}"/>`
      + runXml(`${step.number}. ${step.title || 'Untitled step'}`)
      + `<w:bookmarkEnd w:id="${bm}"/>`,
      `<w:pStyle w:val="${style}"/>`,
    );
    const parts = [blocks(g.beforeTitle), heading];
    if (step.skipped) parts.push(paragraph(runXml('Skipped', { italic: true })));
    parts.push(blocks(g.afterTitle), blocks(g.beforeDescription), this.richText(step.descriptionHtml),
      blocks(g.afterDescription), blocks(g.beforeImage));
    const img = images.get(step.stepId);
    if (img && tpl.includeImages) parts.push(this.image(img, `Step ${step.number}`));
    parts.push(blocks(g.afterImage));
    for (const block of g.rest) {
      if (block.kind === 'text') parts.push(this.callout(block));
      else if (block.kind === 'code') {
        parts.push(paragraph(runXml(codeBlockText(block), { code: true }), '<w:pStyle w:val="Code"/>'));
      } else if (block.kind === 'table' && block.rows && block.rows.length) parts.push(this.table(block.rows));
    }
    return parts.join('');
  }

  build(images, tpl) {
    const ast = this.ast;
    const intro = [];
    if (ast.guide.descriptionHtml) intro.push(this.richText(ast.guide.descriptionHtml));
    const count = ast.steps.length;
    const meta = [`${count} step${count === 1 ? '' : 's'}`, ...guideMetaLines(ast)].join(' · ');
    intro.push(paragraph(runXml(meta, { italic: true })));
    const body = intro.join('') + ast.steps.map((s) => this.step(s, images, tpl)).join('');

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

    return zipSync([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'docProps/core.xml', data: coreProps(ast.guide.title || 'Untitled guide') },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: STYLES },
      { name: 'word/numbering.xml', data: numberingXml(this.nums) },
      {
        name: 'word/_rels/document.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>
${this.rels.join('\n')}
</Relationships>`,
      },
      ...this.media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, store: true })),
    ]);
  }
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

function coreProps(title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(title)}</dc:title><dc:creator>StepForge</dc:creator>
</cp:coreProperties>`;
}

function style(id, name, { type = 'paragraph', ppr = '', rpr = '', basedOn = 'Normal', outline = null } = {}) {
  return `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>`
    + `${basedOn && type === 'paragraph' ? `<w:basedOn w:val="${basedOn}"/><w:next w:val="Normal"/>` : ''}<w:qFormat/>`
    + `${ppr || outline !== null ? `<w:pPr>${ppr}${outline !== null ? `<w:outlineLvl w:val="${outline}"/>` : ''}</w:pPr>` : ''}`
    + `${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}</w:style>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${style('Heading2', 'heading 2', { ppr: '<w:keepNext/><w:spacing w:before="360" w:after="120"/>', rpr: '<w:b/><w:sz w:val="32"/>', outline: 1 })}
${style('Heading3', 'heading 3', { ppr: '<w:keepNext/><w:spacing w:before="240" w:after="80"/>', rpr: '<w:b/><w:sz w:val="26"/>', outline: 2 })}
${style('Heading4', 'heading 4', { ppr: '<w:keepNext/><w:spacing w:before="200" w:after="60"/>', rpr: '<w:b/><w:sz w:val="22"/>', outline: 3 })}
${style('ListParagraph', 'List Paragraph', { ppr: '<w:spacing w:after="60"/><w:ind w:left="720"/>' })}
${style('Quote', 'Quote', { ppr: '<w:ind w:left="720"/>', rpr: '<w:i/><w:color w:val="505F79"/>' })}
${style('Code', 'Code', { ppr: '<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>', rpr: '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/>' })}
${style('Hyperlink', 'Hyperlink', { type: 'character', basedOn: null, rpr: '<w:color w:val="0052CC"/><w:u w:val="single"/>' })}
</w:styles>`;

function numberingXml(nums) {
  const level = (ilvl, fmt, text) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>`
    + `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>`
    + `${fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : ''}</w:lvl>`;
  const bullet = [0, 1, 2].map((l) => level(l, 'bullet', '')).join('');
  const decimal = [0, 1, 2].map((l) => level(l, ['decimal', 'lowerLetter', 'lowerRoman'][l], `%${l + 1}.`)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullet}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimal}</w:abstractNum>
${nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abstractId}"/>${n.abstractId === 1 ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`).join('\n')}
</w:numbering>`;
}

/** Build the .docx bytes for a guide. */
function buildConfluenceWord(ast, images, tpl = { includeImages: true }) {
  return new WordDocument(ast).build(images, tpl);
}

module.exports = { buildConfluenceWord };
