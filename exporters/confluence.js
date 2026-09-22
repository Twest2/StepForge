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
 *   page-cloud.json    REST API v2 request body (Confluence Cloud)
 *   page-datacenter.json  REST API request body (Confluence Data Center/Server)
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

// Languages every Confluence code macro accepts (Cloud supports more); an
// unknown value can render as an error, so anything else becomes plain text.
const CODE_LANGUAGES = new Set([
  'actionscript3', 'applescript', 'bash', 'c#', 'cpp', 'css', 'coldfusion', 'delphi', 'diff', 'erl',
  'groovy', 'java', 'javafx', 'js', 'perl', 'php', 'powershell', 'py', 'ruby', 'sass', 'scala', 'sql',
  'text', 'vb', 'xml', 'yml',
]);
const CODE_ALIASES = {
  javascript: 'js', typescript: 'js', ts: 'js', json: 'js', node: 'js',
  python: 'py', python3: 'py', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  ps1: 'powershell', pwsh: 'powershell', yaml: 'yml', html: 'xml', xhtml: 'xml', svg: 'xml',
  csharp: 'c#', cs: 'c#', 'c++': 'cpp', c: 'cpp', rb: 'ruby', erlang: 'erl', scss: 'sass',
  patch: 'diff', vbnet: 'vb', plaintext: 'text', txt: 'text',
};

function codeLanguage(lang) {
  const key = String(lang || '').trim().toLowerCase();
  const mapped = CODE_ALIASES[key] || key;
  return CODE_LANGUAGES.has(mapped) ? mapped : null;
}

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function cdata(text) {
  return `<![CDATA[${String(text || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

// Named HTML entities XML doesn't define; anything else unknown is escaped.
const HTML_ENTITIES = {
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, euro: 8364, yen: 165, copy: 169, reg: 174, trade: 8482,
  deg: 176, plusmn: 177, times: 215, divide: 247, micro: 181, para: 182, middot: 183, sect: 167,
  laquo: 171, raquo: 187, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, sbquo: 8218, bdquo: 8222,
  ndash: 8211, mdash: 8212, hellip: 8230, bull: 8226, prime: 8242, larr: 8592, rarr: 8594, uarr: 8593,
  darr: 8595, harr: 8596, check: 10003, ensp: 8194, emsp: 8195, thinsp: 8201, zwj: 8205, zwnj: 8204,
  agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231,
  egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239,
  ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, oslash: 248, ugrave: 249,
  uacute: 250, ucirc: 251, uuml: 252, yacute: 253, yuml: 255, szlig: 223,
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199,
  Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207,
  Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, Oslash: 216, Ugrave: 217,
  Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221,
};

const VOID = new Set(['br', 'hr']);

/**
 * Re-nest tags so the fragment is well-formed XML: stray closing tags are
 * dropped and anything left open is closed. Confluence rejects the whole
 * page if a single description is malformed.
 */
function balanceTags(html) {
  const open = [];
  const out = String(html).replace(/<(\/?)([a-zA-Z][\w:]*)([^>]*?)(\/?)>/g, (tag, close, rawName, rest, selfClose) => {
    const name = rawName.toLowerCase();
    if (selfClose || VOID.has(name)) return tag;
    if (!close) { open.push(name); return tag; }
    const i = open.lastIndexOf(name);
    if (i < 0) return '';
    // Close anything opened inside this element first.
    const closing = open.splice(i).reverse().map((n) => `</${n}>`).join('');
    return closing;
  });
  return out + open.reverse().map((n) => `</${n}>`).join('');
}

/**
 * Turn a sanitized description fragment into well-formed storage-format
 * XHTML: self-close void tags, use numeric entities, balance tags, and turn
 * internal step links into Confluence anchor links.
 */
function toStorage(html, ast) {
  const xhtml = String(html || '')
    .replace(/<(br|hr)(\s[^>]*)?\s*\/?>/gi, '<$1 />')
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      if (XML_ENTITIES.has(name)) return m;
      return HTML_ENTITIES[name] ? `&#${HTML_ENTITIES[name]};` : `&amp;${name};`;
    })
    // A bare "&" that doesn't start an entity.
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  return balanceTags(xhtml)
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
      const language = codeLanguage(block.language);
      const params = language ? { language } : {};
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

  page.xhtml             The page body, in Confluence storage format.
  page-cloud.json        The page as a Confluence Cloud REST API request.
  page-datacenter.json   The page as a Confluence Data Center REST API request.
  attachments/           ${attachmentCount} screenshot${attachmentCount === 1 ? '' : 's'} the page shows.

Create the page first, then upload the files in attachments/ to it. The page
refers to its screenshots by file name, so they appear as soon as they are
uploaded.

Run the commands below from this folder in a bash shell with curl (macOS,
Linux, or Git Bash / WSL on Windows).


Confluence Cloud (your-site.atlassian.net)
------------------------------------------

You need your Atlassian email and an API token. Create a token at
https://id.atlassian.com/manage-profile/security/api-tokens

1. Find the ID of the space the page goes in. Replace KEY with the space key
   (shown in the space's URL, e.g. .../wiki/spaces/KEY/...):

     curl -u you@example.com:API_TOKEN \\
       "https://YOUR-SITE.atlassian.net/wiki/api/v2/spaces?keys=KEY"

   Copy the "id" value from the response.

2. Open page-cloud.json and replace SPACE_ID with that id. To put the page
   under an existing page, also add  "parentId": "PARENT_PAGE_ID",  next to
   "spaceId" (the parent page ID is the number in that page's URL).

3. Create the page:

     curl -u you@example.com:API_TOKEN -H "Content-Type: application/json" \\
       -X POST -d @page-cloud.json \\
       https://YOUR-SITE.atlassian.net/wiki/api/v2/pages

   Copy the new page's "id" from the response.

4. Upload the screenshots to it (replace PAGE_ID):

     for f in attachments/*.png; do
       curl -u you@example.com:API_TOKEN -H "X-Atlassian-Token: nocheck" \\
         -X POST -F "file=@$f" \\
         https://YOUR-SITE.atlassian.net/wiki/rest/api/content/PAGE_ID/child/attachment
     done


Confluence Data Center / Server
-------------------------------

You need a personal access token (Profile > Personal Access Tokens).

1. Open page-datacenter.json and replace SPACEKEY with the space key. To put
   the page under an existing page, add  "ancestors": [{"id": "PARENT_PAGE_ID"}],
   next to "space".

2. Create the page:

     curl -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \\
       -X POST -d @page-datacenter.json \\
       https://YOUR-CONFLUENCE/rest/api/content

   Copy the new page's "id" from the response.

3. Upload the screenshots to it (replace PAGE_ID):

     for f in attachments/*.png; do
       curl -H "Authorization: Bearer TOKEN" -H "X-Atlassian-Token: nocheck" \\
         -X POST -F "file=@$f" \\
         https://YOUR-CONFLUENCE/rest/api/content/PAGE_ID/child/attachment
     done

If your Confluence has an app that edits a page's storage format (such as
"Confluence Source Editor"), you can instead create the page, attach the
screenshots, and paste page.xhtml into the source editor.
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
  const title = ast.guide.title || 'Untitled guide';
  fs.writeFileSync(path.join(folder, 'page-cloud.json'), `${JSON.stringify({
    spaceId: 'SPACE_ID',
    status: 'current',
    title,
    body: { representation: 'storage', value: body },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(folder, 'page-datacenter.json'), `${JSON.stringify({
    type: 'page',
    title,
    space: { key: 'SPACEKEY' },
    body: { storage: { value: body, representation: 'storage' } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(folder, 'HOW-TO-IMPORT.txt'), importGuide(ast, attachmentNames.size));
  return { file, folder, previewFile: folder, attachmentCount: attachmentNames.size };
}

module.exports = { exportConfluence, DEFAULT_TEMPLATE, OPTION_INFO };
