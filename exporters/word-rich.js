'use strict';

const { escapeXml } = require('../core/util');
const { htmlToBlocks } = require('../core/htmlblocks');

/**
 * Rich text (sanitized description HTML) as WordprocessingML paragraphs:
 * bold, italic, strikethrough, inline code, links to web pages and to other
 * steps, real bulleted and numbered lists, quotes, headings, tables and
 * rules. Shared by the Word and Confluence exports.
 *
 * `styled` documents (Confluence) define List Paragraph, Quote, Heading 4
 * and Hyperlink styles and refer to them. Otherwise (Word) the formatting
 * is written out on each paragraph and run, on top of `rpr` (size, color)
 * and `ppr` (a callout's shading and border) for every paragraph.
 *
 * Lists need a numbering part: `numberingXml()` once the document is built,
 * when `nums` isn't empty. `bullet` is the bullet character: the Symbol
 * font's (Word's own default) or a plain "•" that any font has.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Run properties in schema order: style, font, b, i, strike, color, size, underline. */
function runProps({ bold, italic, strike, code, link } = {}, { styled = true, size = 0, color = '', linkColor = '0563C1', codeFont = 'Courier New' } = {}) {
  return [
    link && styled ? '<w:rStyle w:val="Hyperlink"/>' : '',
    code ? `<w:rFonts w:ascii="${codeFont}" w:hAnsi="${codeFont}" w:cs="${codeFont}"/>` : '',
    bold ? '<w:b/>' : '',
    italic ? '<w:i/>' : '',
    strike ? '<w:strike/>' : '',
    link && !styled ? `<w:color w:val="${linkColor}"/>` : (color ? `<w:color w:val="${color}"/>` : ''),
    size ? `<w:sz w:val="${size}"/>` : '',
    link && !styled ? '<w:u w:val="single"/>' : '',
  ].join('');
}

/** One run per line of `text`, with a line break between them. */
function runXml(text, format = {}, options = {}) {
  const rpr = runProps(format, options);
  return String(text).split('\n').map((line, i) => (
    `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
  )).join('');
}

/**
 * Paragraph properties in schema order. `parts` holds the pieces a paragraph
 * needs: style, numPr, pBdr (whole element), shd, spacing, ind.
 */
function paragraphProps({ style = '', numPr = '', pBdr = '', shd = '', spacing = '', ind = '' } = {}) {
  return [style ? `<w:pStyle w:val="${style}"/>` : '', numPr, pBdr, shd, spacing, ind].join('');
}

function paragraph(content, props = '') {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
}

class WordRichText {
  /**
   * `rel(type, target, external)` adds a relationship and returns its id;
   * `anchorFor(step)` is the bookmark a step's heading carries; `table(rows)`
   * writes a description's table rows (arrays of cell text).
   */
  constructor({ ast, rel, anchorFor, table, styled = true, size = 0, color = '', linkColor = '0563C1', bullet = SYMBOL_BULLET }) {
    this.ast = ast;
    this.rel = rel;
    this.anchorFor = anchorFor;
    this.tableXml = table;
    this.styled = styled;
    this.runOptions = { styled, size, color, linkColor };
    this.bullet = bullet;
    this.nums = []; // numbering instances: { id, abstractId }
  }

  newList(ordered) {
    const id = this.nums.length + 1;
    this.nums.push({ id, abstractId: ordered ? 1 : 0 });
    return id;
  }

  /** Runs with links: to another step's heading (a bookmark), or to a web page. */
  runs(runs, options = this.runOptions) {
    return runs.map((r) => {
      if (r.href && r.href.startsWith('step:')) {
        const target = this.ast.steps.find((s) => s.stepId === r.href.slice(5));
        if (!target) return runXml(r.text, r, options);
        return `<w:hyperlink w:anchor="${this.anchorFor(target)}">${runXml(r.text, { ...r, link: true }, options)}</w:hyperlink>`;
      }
      if (r.href && /^(https?:|mailto:)/i.test(r.href)) {
        return `<w:hyperlink r:id="${this.rel('hyperlink', r.href, true)}">${runXml(r.text, { ...r, link: true }, options)}</w:hyperlink>`;
      }
      return runXml(r.text, r, options);
    }).join('');
  }

  /**
   * Description HTML as paragraphs. `ppr` adds properties to every paragraph
   * ({ pBdr, shd } for a callout's box); `rpr` overrides run size or color.
   * `flatLists` writes list items as "•" and "1." lines without indenting
   * them: a paragraph's border follows its indent, so a real list would
   * break a callout's box.
   */
  richText(html, { ppr = {}, rpr = {}, flatLists = false } = {}) {
    const options = { ...this.runOptions, ...rpr };
    const styled = this.styled;
    const out = [];
    const lists = []; // the open list at each depth: { ordered, id }
    let rows = []; // consecutive table rows, written as one Word table
    const endTable = () => { if (rows.length) out.push(this.tableXml(rows)); rows = []; };
    const props = (own) => paragraphProps({ ...ppr, ...own });
    for (const block of htmlToBlocks(html || '')) {
      if (block.type === 'tr') { lists.length = 0; rows.push(block.cells); continue; }
      endTable();
      const isList = block.type === 'li' || block.type === 'oli';
      const ordered = block.type === 'oli';
      if (!isList) lists.length = 0;
      if (block.type === 'hr') {
        out.push(paragraph('', props({ pBdr: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C1C7D0"/></w:pBdr>' })));
        continue;
      }
      if (isList && flatLists) {
        const nested = '\u2003'.repeat(block.indent || 0);
        const marker = block.cont ? '\u2003' : (ordered ? `${block.n}.` : '\u2022');
        out.push(paragraph(runXml(`${nested}${marker}\u2002`, {}, options) + this.runs(block.runs, options), props()));
        continue;
      }
      if (isList) {
        // One list per nesting depth (zero-based), so a parent list keeps
        // counting after a nested list of either kind ends.
        const lvl = Math.min(2, block.indent || 0);
        lists.length = Math.min(lists.length, lvl + 1);
        let list = lists[lvl];
        if (!list || list.ordered !== ordered || (ordered && block.n === 1 && !block.cont)) {
          list = lists[lvl] = { ordered, id: this.newList(ordered) };
        }
        const style = styled ? 'ListParagraph' : '';
        const spacing = styled ? '' : '<w:spacing w:after="60"/>';
        // A line after a break in the item continues it: same indent, no new number.
        out.push(block.cont
          ? paragraph(this.runs(block.runs, options), props({ style, spacing, ind: `<w:ind w:left="${720 * (lvl + 1)}"/>` }))
          : paragraph(this.runs(block.runs, options), props({ style, spacing, numPr: `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${list.id}"/></w:numPr>` })));
        continue;
      }
      if (/^h[1-4]$/.test(block.type)) {
        out.push(styled
          ? paragraph(this.runs(block.runs, options), props({ style: 'Heading4' }))
          : paragraph(this.runs(block.runs.map((r) => ({ ...r, bold: true })), options), props({ spacing: '<w:spacing w:before="120" w:after="60"/>' })));
      } else if (block.type === 'blockquote') {
        out.push(styled
          ? paragraph(this.runs(block.runs, options), props({ style: 'Quote' }))
          : paragraph(this.runs(block.runs.map((r) => ({ ...r, italic: true })), { ...options, color: '505F79' }),
            props({ ind: `<w:ind w:left="${360 * Math.max(1, block.indent)}"/>` })));
      } else {
        out.push(paragraph(this.runs(block.runs, options), props()));
      }
    }
    endTable();
    return out.join('');
  }

  /** The numbering part for the lists written so far. */
  numberingXml() {
    return numberingXml(this.nums, { bullet: this.bullet });
  }
}

const SYMBOL_BULLET = '\uF0B7';

function numberingXml(nums, { bullet: mark = SYMBOL_BULLET } = {}) {
  const level = (ilvl, fmt, text) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>`
    + `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>`
    + `${fmt === 'bullet' && mark === SYMBOL_BULLET ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : ''}</w:lvl>`;
  const bullet = [0, 1, 2].map((l) => level(l, 'bullet', mark)).join('');
  const decimal = [0, 1, 2].map((l) => level(l, ['decimal', 'lowerLetter', 'lowerRoman'][l], `%${l + 1}.`)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullet}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimal}</w:abstractNum>
${nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abstractId}"/>${n.abstractId === 1 ? [0, 1, 2].map((l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('') : ''}</w:num>`).join('\n')}
</w:numbering>`;
}

module.exports = { WordRichText, runXml, paragraph, numberingXml };
