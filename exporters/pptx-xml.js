'use strict';

const { escapeXml } = require('../core/util');

/**
 * PresentationML / DrawingML building blocks for the PPTX exporter. Boxes are
 * { x, y, w, h } in EMU. Colors are hex ("1F2937") or "scheme:<name>" for a
 * theme color, so a brand theme (or one picked later in PowerPoint) restyles
 * them. Shape ids come from a per-slide counter (`ids()`).
 */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const GROUP_PROPS = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** A shape id counter for one slide; ids 1 (the tree) and below are taken. */
function ids(start = 2) {
  let next = start;
  return () => next++;
}

const int = (v) => Math.round(v);

/** A hex color, or "scheme:<name>" for one of the theme's colors; `alpha` 0..1. */
function colorXml(color, alpha) {
  const a = alpha != null && alpha < 1 ? `<a:alpha val="${int(alpha * 100000)}"/>` : '';
  const c = String(color);
  const [tag, val] = c.startsWith('scheme:') ? ['a:schemeClr', c.slice(7)] : ['a:srgbClr', c.replace(/^#/, '').toUpperCase()];
  return a ? `<${tag} val="${val}">${a}</${tag}>` : `<${tag} val="${val}"/>`;
}

function solidFill(color, alpha) {
  return `<a:solidFill>${colorXml(color, alpha)}</a:solidFill>`;
}

function xfrm(box, tag = 'a:xfrm') {
  return `<${tag}><a:off x="${int(box.x)}" y="${int(box.y)}"/><a:ext cx="${Math.max(0, int(box.w))}" cy="${Math.max(0, int(box.h))}"/></${tag}>`;
}

/** Preset geometry; `radius` (EMU) rounds a roundRect's corners. */
function geometry(geom = 'rect', box, radius = 0) {
  if (geom === 'roundRect') {
    const adj = Math.min(50000, int((radius / Math.max(1, Math.min(box.w, box.h))) * 100000));
    return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
  }
  return `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>`;
}

function lineXml(line) {
  if (!line) return '<a:ln><a:noFill/></a:ln>';
  return `<a:ln w="${int(line.w || 9525)}">${solidFill(line.color, line.alpha)}</a:ln>`;
}

/** A soft drop shadow under a picture or card. */
const SHADOW = '<a:effectLst><a:outerShdw blurRad="76200" dist="19050" dir="5400000" algn="t" rotWithShape="0">'
  + '<a:srgbClr val="0F172A"><a:alpha val="16000"/></a:srgbClr></a:outerShdw></a:effectLst>';

/**
 * One run of text. `font` is a typeface name, or the theme's heading
 * (+mj-lt) or body (+mn-lt) font.
 */
function run(text, { size = 18, bold = false, italic = false, color = 'scheme:tx1', font = '+mn-lt', lang = 'en-US' } = {}) {
  const t = String(text ?? '');
  return `<a:r><a:rPr lang="${lang}" sz="${int(size * 100)}" b="${bold ? 1 : 0}"${italic ? ' i="1"' : ''} dirty="0">${solidFill(color)}`
    + `<a:latin typeface="${escapeXml(font)}"/></a:rPr>`
    + `<a:t>${escapeXml(t)}</a:t></a:r>`;
}

/** A paragraph of runs; `spaceAfter` and `spaceBefore` in points. */
function paragraph(runs, { align = 'l', spaceAfter = 0, spaceBefore = 0, endSize = 0 } = {}) {
  const spacing = (spaceBefore ? `<a:spcBef><a:spcPts val="${int(spaceBefore * 100)}"/></a:spcBef>` : '')
    + (spaceAfter ? `<a:spcAft><a:spcPts val="${int(spaceAfter * 100)}"/></a:spcAft>` : '');
  const pPr = `<a:pPr algn="${align}"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc>${spacing}<a:buNone/></a:pPr>`;
  const end = endSize ? `<a:endParaRPr lang="en-US" sz="${int(endSize * 100)}" dirty="0"/>` : '';
  return `<a:p>${pPr}${Array.isArray(runs) ? runs.join('') : runs}${end}</a:p>`;
}

/**
 * Text paragraphs (one per line of `text`) with the same run style;
 * `spaceBefore` goes above the first only.
 */
function paragraphs(text, style = {}, { align = 'l', spaceAfter = 0, spaceBefore = 0 } = {}) {
  return String(text ?? '').split('\n').map((line, i, all) => paragraph(run(line, style), {
    align, spaceAfter: i < all.length - 1 ? spaceAfter : 0, spaceBefore: i ? 0 : spaceBefore, endSize: line ? 0 : style.size,
  }));
}

function bodyPr({ anchor = 't', inset = 0, insetX = inset, insetY = inset, wrap = true, autofit = true } = {}) {
  return `<a:bodyPr wrap="${wrap ? 'square' : 'none'}" lIns="${int(insetX)}" tIns="${int(insetY)}" rIns="${int(insetX)}" bIns="${int(insetY)}" anchor="${anchor}" rtlCol="0">`
    + `${autofit ? '<a:normAutofit/>' : '<a:noAutofit/>'}</a:bodyPr>`;
}

/**
 * A shape: a rectangle, rounded rectangle or ellipse with an optional fill,
 * outline, shadow and text. `ph` makes it a placeholder (e.g. the slide's
 * title, so PowerPoint's outline and screen readers see it).
 */
function shape(nextId, { name = 'Shape', box, geom = 'rect', radius = 0, fill = null, fillAlpha, line = null, shadow = false, paras = null, text = {}, ph = '', descr = '' }) {
  const id = nextId();
  const nvPr = ph ? `<p:nvPr><p:ph type="${ph}"/></p:nvPr>` : '<p:nvPr/>';
  const cNvSpPr = ph ? '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' : (paras && !fill && !line ? '<p:cNvSpPr txBox="1"/>' : '<p:cNvSpPr/>');
  const spPr = `<p:spPr>${xfrm(box)}${geometry(geom, box, radius)}${fill ? solidFill(fill, fillAlpha) : '<a:noFill/>'}${lineXml(line)}${shadow ? SHADOW : ''}</p:spPr>`;
  const txBody = paras ? `<p:txBody>${bodyPr(text)}<a:lstStyle/>${paras.join('')}</p:txBody>` : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"${descr ? ` descr="${escapeXml(descr)}"` : ''}/>${cNvSpPr}${nvPr}</p:nvSpPr>${spPr}${txBody}</p:sp>`;
}

/** A picture from relationship `relId`, with an optional thin border and shadow. */
function picture(nextId, { relId, box, alt = '', name = 'Picture', border = null, shadow = false }) {
  const id = nextId();
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(name)}" descr="${escapeXml(alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${border ? lineXml(border) : ''}${shadow ? SHADOW : ''}</p:spPr></p:pic>`;
}

/**
 * A table. `rows` is [{ h, cells: [{ paras, fill }] }]; `colWidths` in EMU.
 * Every cell gets a thin `border` line.
 */
function table(nextId, { box, colWidths, rows, border = 'D1D5DB', margin = 64008 }) {
  const id = nextId();
  const edge = (tag) => `<a:${tag} w="9525">${solidFill(border)}</a:${tag}>`;
  const grid = colWidths.map((w) => `<a:gridCol w="${int(w)}"/>`).join('');
  const rowsXml = rows.map((row) => `<a:tr h="${int(row.h)}">${row.cells.map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${cell.paras.join('')}</a:txBody>`
    + `<a:tcPr marL="${margin}" marR="${margin}" marT="${int(margin * 0.6)}" marB="${int(margin * 0.6)}">${edge('lnL')}${edge('lnR')}${edge('lnT')}${edge('lnB')}`
    + `${cell.fill ? solidFill(cell.fill) : '<a:noFill/>'}</a:tcPr></a:tc>`).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `${xfrm(box, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">`
    + `<a:tbl><a:tblPr firstRow="1" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** A background picture (relationship `relId`) stretched over the slide. */
function backgroundXml(relId) {
  return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rId${relId}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}

const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

/** A slide: its shapes, an optional background and whether the master's shapes show. */
function slideXml(content, { hideMaster = false, background = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}${hideMaster ? ' showMasterSp="0"' : ''}>
<p:cSld>${background}<p:spTree>${GROUP_PROPS}
${content}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** Speaker notes for a slide: the slide image and the notes text. */
function notesXml(text) {
  const paras = String(text).split('\n').map((line) => paragraph(run(line, { size: 12, color: 'scheme:tx1' }), { endSize: line ? 0 : 12 }));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NS}><p:cSld><p:spTree>${GROUP_PROPS}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras.join('')}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

/** The notes master: where the slide image and the notes go on a notes page. */
function notesMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster ${NS}><p:cSld><p:spTree>${GROUP_PROPS}`
    + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 381000, y: 685800, w: 6096000, h: 3429000 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 685800, y: 4343400, w: 5486400, h: 4114800 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
    + `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/></p:notesMaster>`;
}

module.exports = {
  NS,
  GROUP_PROPS,
  CLR_MAP,
  ids,
  colorXml,
  solidFill,
  run,
  paragraph,
  paragraphs,
  shape,
  picture,
  table,
  backgroundXml,
  slideXml,
  notesXml,
  notesMasterXml,
};
