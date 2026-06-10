'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('../core/zip');
const { escapeXml } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages } = require('./common');

/**
 * PPTX exporter: a title slide plus one 16:9 slide per step (title bar +
 * screenshot + description). PresentationML written directly.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  titleSlide: true,
};

const SLIDE_W = 12192000; // EMU, 16:9
const SLIDE_H = 6858000;
const EMU_PER_PX = 9525;

let shapeIdCounter = 10; // reset per export for deterministic output

function textBox(x, y, w, h, runsXml) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeIdCounter++}" name="TextBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${runsXml}</p:txBody></p:sp>`;
}

function para(text, { size = 1800, bold = false, color = '111827' } = {}) {
  return `<a:p><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function picture(relId, x, y, w, h) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${relId + 100}" name="Screenshot"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function slideXml(content) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${content}
</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="StepForge">
<a:themeElements>
<a:clrScheme name="StepForge"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="10B981"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4><a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="EC4899"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
<a:fontScheme name="StepForge"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="StepForge"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

function exportPptx(ast, outDir, template = {}) {
  shapeIdCounter = 10;
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  const slides = []; // { xml, rels: [{id, target}], media: [{name, data}] }

  if (tpl.titleSlide) {
    slides.push({
      xml: slideXml(
        textBox(914400, 2300000, SLIDE_W - 1828800, 1200000, para(ast.guide.title, { size: 4000, bold: true })) +
        textBox(914400, 3600000, SLIDE_W - 1828800, 800000,
          para(`${ast.steps.length} steps — ${ast.generatedAt.slice(0, 10)}`, { size: 1800, color: '6B7280' }))
      ),
      rels: [], media: [],
    });
  }

  let mediaCounter = 0;
  for (const step of ast.steps) {
    let content = textBox(457200, 274638, SLIDE_W - 914400, 700000,
      para(`${step.number}. ${step.title || 'Untitled step'}`, { size: 2400, bold: true }));
    const rels = [];
    const media = [];

    const img = images.get(step.stepId);
    if (img) {
      mediaCounter += 1;
      const name = `image${mediaCounter}.png`;
      media.push({ name, data: encodePng(img) });
      const relId = 2; // rId1 = layout, rId2 = image
      rels.push({ id: relId, name });
      // Fit image into a centered region below the title.
      const maxW = SLIDE_W - 1219200, maxH = SLIDE_H - 1554638 - (step.descriptionText ? 700000 : 200000);
      let w = img.width * EMU_PER_PX, h = img.height * EMU_PER_PX;
      const scale = Math.min(maxW / w, maxH / h, 1);
      w = Math.round(w * scale); h = Math.round(h * scale);
      content += picture(relId, Math.round((SLIDE_W - w) / 2), 1054638, w, h);
    }
    if (step.descriptionText) {
      content += textBox(457200, SLIDE_H - 850000, SLIDE_W - 914400, 700000,
        para(step.descriptionText.slice(0, 300), { size: 1400, color: '374151' }));
    }
    slides.push({ xml: slideXml(content), rels, media });
  }

  const entries = [];
  const overrides = [];
  const presRels = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
  ];
  const sldIds = [];

  slides.forEach((slide, i) => {
    const n = i + 1;
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: slide.xml });
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    const slideRels = [
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
      ...slide.rels.map((r) => `<Relationship Id="rId${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${r.name}"/>`),
    ];
    entries.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels.join('')}</Relationships>`,
    });
    for (const m of slide.media) entries.push({ name: `ppt/media/${m.name}`, data: m.data, store: true });
    presRels.push(`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${256 + i}" r:id="rId${n + 1}"/>`);
  });

  entries.push(
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${overrides.join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>
<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join('')}</Relationships>`,
    },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER_XML },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT_XML },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    },
    { name: 'ppt/theme/theme1.xml', data: THEME_XML },
  );

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${guideSlug(ast)}.pptx`);
  fs.writeFileSync(file, zipSync(entries));
  return { file, slideCount: slides.length, imageCount: mediaCounter };
}

module.exports = { exportPptx, DEFAULT_TEMPLATE };
