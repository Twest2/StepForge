'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify, escapeXml, htmlToText } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, stepContentGroups, codeBlockText } = require('./common');
const { anchorFor, guideMetaLines } = require('./document-layout');

/**
 * Confluence export. Writes a folder containing:
 *   page.xhtml         the page body in Confluence storage format (the
 *                      format the REST API and source editors accept)
 *   page.json          a ready-to-send REST API request body for that page
 *   attachments/       the rendered screenshots the page references
 *   HOW-TO-IMPORT.txt  step-by-step import instructions
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  toc: true,
  imageWidth: 760,
};

const OPTION_INFO = {
  includeImages: { label: 'Include screenshots' },
  toc: { label: 'Add a table of contents' },
  imageWidth: { label: 'Screenshot width', unit: 'px', min: 200, max: 1600, step: 10, hint: 'Display width on the page; the full-size image is attached.' },
};

const PANEL_FOR_LEVEL = {
  info: 'info',
  success: 'tip',
  warn: 'note', // Confluence's yellow panel
  error: 'warning', // Confluence's red panel
};

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function cdata(text) {
  return `<![CDATA[${String(text || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * Turn a sanitized description fragment into well-formed storage-format
 * XHTML: self-close void tags, use numeric entities, and turn internal
 * step links into Confluence anchor links.
 */
function toStorage(html, ast) {
  return String(html || '')
    .replace(/<(br|hr)(\s[^>]*)?\s*\/?>/gi, '<$1 />')
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      if (XML_ENTITIES.has(name)) return m;
      return name === 'nbsp' ? '&#160;' : m.replace('&', '&amp;');
    })
    .replace(/<a\s+href="step:([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, id, label) => {
      const target = ast.steps.find((s) => s.stepId === id);
      const text = htmlToText(label);
      if (!target) return escapeXml(text);
      return `<ac:link ac:anchor="${anchorFor(target)}"><ac:plain-text-link-body>${cdata(text)}</ac:plain-text-link-body></ac:link>`;
    });
}

function macro(name, params = {}, inner = '') {
  const p = Object.entries(params)
    .map(([k, v]) => `<ac:parameter ac:name="${k}">${escapeXml(v)}</ac:parameter>`).join('');
  return `<ac:structured-macro ac:name="${name}">${p}${inner}</ac:structured-macro>`;
}

function panel(tb, ast) {
  const params = tb.title ? { title: tb.title } : {};
  const body = tb.descriptionHtml ? toStorage(tb.descriptionHtml, ast) : '<p />';
  return macro(PANEL_FOR_LEVEL[tb.level] || 'info', params, `<ac:rich-text-body>${body}</ac:rich-text-body>`);
}

function table(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  return `<table><tbody>${rows.map((row, r) => `<tr>${Array.from({ length: width }, (_, i) => {
    const cell = escapeXml(row[i] ?? '');
    return r === 0 ? `<th><p>${cell}</p></th>` : `<td><p>${cell}</p></td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderStep(step, ast, attachmentNames, tpl) {
  const groups = stepContentGroups(step);
  const panels = (list) => list.map((tb) => panel(tb, ast));
  const out = [];
  out.push(...panels(groups.beforeTitle));
  const tag = step.depth > 0 ? 'h3' : 'h2';
  out.push(`<${tag}>${macro('anchor', { '': anchorFor(step) })}${escapeXml(step.number)}. ${escapeXml(step.title || 'Untitled step')}</${tag}>`);
  if (step.skipped) out.push(`<p>${macro('status', { colour: 'Yellow', title: 'Skipped' })}</p>`);
  out.push(...panels(groups.afterTitle), ...panels(groups.beforeDescription));
  if (step.descriptionHtml) out.push(toStorage(step.descriptionHtml, ast));
  out.push(...panels(groups.afterDescription), ...panels(groups.beforeImage));

  const attachment = attachmentNames.get(step.stepId);
  if (attachment) {
    const width = Math.max(100, Math.round(Number(tpl.imageWidth) || DEFAULT_TEMPLATE.imageWidth));
    out.push(`<p><ac:image ac:border="true" ac:width="${width}" ac:alt="Step ${escapeXml(step.number)}"><ri:attachment ri:filename="${escapeXml(attachment)}" /></ac:image></p>`);
  }
  out.push(...panels(groups.afterImage));

  for (const block of groups.rest) {
    if (block.kind === 'text') {
      out.push(panel(block, ast));
    } else if (block.kind === 'code') {
      const params = block.language ? { language: block.language } : {};
      out.push(macro('code', params, `<ac:plain-text-body>${cdata(codeBlockText(block))}</ac:plain-text-body>`));
    } else if (block.kind === 'table' && block.rows && block.rows.length) {
      out.push(table(block.rows));
    }
  }
  return out.join('\n');
}

function importGuide(ast, attachmentCount) {
  const title = ast.guide.title || 'Untitled guide';
  return `How to add "${title}" to Confluence
${'='.repeat(title.length + 26)}

This folder holds one Confluence page:

  page.xhtml     The page body, in Confluence storage format.
  page.json      The same page, ready to send to the Confluence REST API.
  attachments/   ${attachmentCount} screenshot${attachmentCount === 1 ? '' : 's'} the page shows.

The page refers to its screenshots by file name, so upload the files in
attachments/ to the page itself.


Option A: Confluence REST API (Cloud or Data Center)
----------------------------------------------------

1. Open page.json and replace SPACEKEY with the key of the space the page
   should go in. To create it under an existing page, add
   "ancestors": [{"id": "PARENT_PAGE_ID"}] next to "space".

2. Create the page. On Confluence Cloud, sign in with your email and an API
   token from https://id.atlassian.com/manage-profile/security/api-tokens

     curl -u you@example.com:API_TOKEN -H "Content-Type: application/json" \\
       -X POST -d @page.json https://YOUR-SITE.atlassian.net/wiki/rest/api/content

   On Data Center, use https://YOUR-SERVER/rest/api/content with a personal
   access token (-H "Authorization: Bearer TOKEN") instead.

   The response contains the new page's "id".

3. Upload the screenshots to that page (run from this folder):

     for f in attachments/*.png; do
       curl -u you@example.com:API_TOKEN -H "X-Atlassian-Token: no-check" \\
         -X POST -F "file=@$f" \\
         https://YOUR-SITE.atlassian.net/wiki/rest/api/content/PAGE_ID/child/attachment
     done


Option B: a source editor
-------------------------

If your Confluence has an app that edits a page's storage format (such as
"Confluence Source Editor"):

1. Create a page titled "${title}" and save it.
2. Attach every file in attachments/ to the page.
3. Open the source editor, paste in the contents of page.xhtml, and publish.
`;
}

function exportConfluence(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const folder = path.join(outDir, `${guideSlug(ast)}-confluence`);
  const attachmentDir = path.join(folder, 'attachments');
  fs.mkdirSync(folder, { recursive: true });
  // Clear screenshots from an earlier export so renamed steps don't linger.
  if (fs.existsSync(attachmentDir)) {
    for (const f of fs.readdirSync(attachmentDir)) if (/^\d{3}-.*\.png$/.test(f)) fs.rmSync(path.join(attachmentDir, f));
  }

  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  const attachmentNames = new Map();
  let n = 0;
  for (const step of ast.steps) {
    const img = images.get(step.stepId);
    if (!img) continue;
    n += 1;
    const fileName = `${String(n).padStart(3, '0')}-${slugify(step.title || step.stepId, step.stepId)}.png`;
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, fileName), encodePng(img));
    attachmentNames.set(step.stepId, fileName);
  }

  const meta = guideMetaLines(ast);
  const count = ast.steps.length;
  const intro = [
    ast.guide.descriptionHtml ? toStorage(ast.guide.descriptionHtml, ast) : '',
    `<p><em>${escapeXml([`${count} step${count === 1 ? '' : 's'}`, ...meta].join(' · '))}</em></p>`,
    tpl.toc && count > 1 ? macro('toc', { maxLevel: '3', style: 'none' }) : '',
  ].filter(Boolean);
  const body = [
    ...intro,
    ...ast.steps.map((step) => renderStep(step, ast, attachmentNames, tpl)),
  ].join('\n');

  const file = path.join(folder, 'page.xhtml');
  fs.writeFileSync(file, `${body}\n`);
  fs.writeFileSync(path.join(folder, 'page.json'), `${JSON.stringify({
    type: 'page',
    title: ast.guide.title || 'Untitled guide',
    space: { key: 'SPACEKEY' },
    body: { storage: { value: body, representation: 'storage' } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(folder, 'HOW-TO-IMPORT.txt'), importGuide(ast, attachmentNames.size));
  return { file, folder, previewFile: folder, attachmentCount: attachmentNames.size };
}

module.exports = { exportConfluence, DEFAULT_TEMPLATE, OPTION_INFO };
