'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify, escapeXml, htmlToText, NAMED_ENTITIES } = require('../core/util');
const { encodePng } = require('../core/png');
const { guideSlug, renderAllImages, stepContentGroups, codeBlockText } = require('./common');
const { anchorFor, guideMetaLines } = require('./document-layout');
const { buildConfluenceWord } = require('./confluence-word');

/**
 * Confluence export. Writes a folder containing:
 *   <Guide title>.docx   a Word document built for Confluence's built-in
 *                        Word import, so anyone can create the page from
 *                        the browser (see confluence-word.js)
 *   HOW-TO-IMPORT.txt    step-by-step import instructions
 * and, when apiFiles is on, rest-api/ with the page in storage format
 * (page.xhtml), REST request bodies for Cloud (v2) and Data Center, and the
 * screenshots as attachments/.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  apiFiles: false,
  toc: true,
  imageWidth: 760,
};

const OPTION_INFO = {
  includeImages: { label: 'Include screenshots' },
  apiFiles: { label: 'Also include REST API files', hint: 'For admins who publish pages with the Confluence API instead of the website.' },
  toc: { label: 'Add a table of contents', hint: 'REST API page only.', dependsOn: 'apiFiles' },
  imageWidth: { label: 'Screenshot width', unit: 'px', min: 200, max: 1600, step: 10, hint: 'REST API page only. The full-size image is attached.', dependsOn: 'apiFiles' },
};

/** The guide title as a safe file name, so the imported page is easy to recognize. */
function wordFileName(ast) {
  const name = String(ast.guide.title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return `${name || guideSlug(ast)}.docx`;
}

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
      return NAMED_ENTITIES[name] ? `&#${NAMED_ENTITIES[name]};` : `&amp;${name};`;
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

function importGuide(ast, wordFile, attachmentCount, apiFiles) {
  const title = ast.guide.title || 'Untitled guide';
  const web = `How to add "${title}" to Confluence
${'='.repeat(title.length + 26)}

Import this Word document from your browser:

  ${wordFile}

No admin rights or API access needed, just permission to create pages in
the space. The screenshots come in with the document.


Confluence Cloud (your-site.atlassian.net)
------------------------------------------

1. In the space, select + Create and choose Page to open a blank page.
2. Next to Share, select More actions (...) > Templates and import.
3. Open the Import tab and select Word document (.docx).
4. Select "${wordFile}" and choose Open.
5. When the import finishes, select Finish. The guide opens as a draft:
   check the title and content, then Publish.


Confluence Data Center / Server
-------------------------------

1. Go to the page the guide should sit under, in view mode (not editing).
2. Select More options (...) > Import Word Document.
3. Choose File, pick "${wordFile}", and select Next.
4. Set the options:
     Root page title:  ${title}
     Where to import:  Import as a new page in the current space
     Split by heading: Don't split
5. Select Import.


Tips
----

- Re-importing creates a new page. To update an existing guide, import it
  again and delete the old page, or copy the new content across.
`;
  if (!apiFiles) return web;
  return `${web}

Optional: publish with the REST API
-----------------------------------

rest-api/ holds the same page for scripts and admins with API access:

  page.xhtml             The page body, in Confluence storage format.
  page-cloud.json        The page as a Confluence Cloud REST API request.
  page-datacenter.json   The page as a Confluence Data Center REST API request.
  attachments/           ${attachmentCount} screenshot${attachmentCount === 1 ? '' : 's'} the page shows.

Create the page first, then upload the files in attachments/ to it. The page
refers to its screenshots by file name, so they appear as soon as they are
uploaded. Run these from the rest-api folder in a bash shell with curl
(macOS, Linux, or Git Bash / WSL on Windows).

Confluence Cloud: use your Atlassian email and an API token from
https://id.atlassian.com/manage-profile/security/api-tokens

1. Find the ID of the space (KEY is the space key from its URL):

     curl -u you@example.com:API_TOKEN \\
       "https://YOUR-SITE.atlassian.net/wiki/api/v2/spaces?keys=KEY"

2. In page-cloud.json, replace SPACE_ID with the "id" from that response.
   To nest the page, also add  "parentId": "PARENT_PAGE_ID",  next to it.

3. Create the page, then note the "id" in the response:

     curl -u you@example.com:API_TOKEN -H "Content-Type: application/json" \\
       -X POST -d @page-cloud.json \\
       https://YOUR-SITE.atlassian.net/wiki/api/v2/pages

4. Upload the screenshots (replace PAGE_ID):

     for f in attachments/*.png; do
       curl -u you@example.com:API_TOKEN -H "X-Atlassian-Token: nocheck" \\
         -X POST -F "file=@$f" \\
         https://YOUR-SITE.atlassian.net/wiki/rest/api/content/PAGE_ID/child/attachment
     done

Confluence Data Center: use a personal access token (Profile > Personal
Access Tokens).

1. In page-datacenter.json, replace SPACEKEY with the space key. To nest the
   page, add  "ancestors": [{"id": "PARENT_PAGE_ID"}],  next to "space".

2. Create the page, then note the "id" in the response:

     curl -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \\
       -X POST -d @page-datacenter.json \\
       https://YOUR-CONFLUENCE/rest/api/content

3. Upload the screenshots (replace PAGE_ID):

     for f in attachments/*.png; do
       curl -H "Authorization: Bearer TOKEN" -H "X-Atlassian-Token: nocheck" \\
         -X POST -F "file=@$f" \\
         https://YOUR-CONFLUENCE/rest/api/content/PAGE_ID/child/attachment
     done
`;
}

function writeApiFiles(ast, dir, images, tpl) {
  const attachmentDir = path.join(dir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  // Clear screenshots from an earlier export so renamed steps don't linger.
  if (fs.existsSync(attachmentDir)) {
    for (const f of fs.readdirSync(attachmentDir)) if (/^\d{3}-.*\.png$/.test(f)) fs.rmSync(path.join(attachmentDir, f));
  }
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

  const count = ast.steps.length;
  const intro = [
    ast.guide.descriptionHtml ? toStorage(ast.guide.descriptionHtml, ast) : '',
    `<p><em>${escapeXml([`${count} step${count === 1 ? '' : 's'}`, ...guideMetaLines(ast)].join(' · '))}</em></p>`,
    tpl.toc && count > 1 ? macro('toc', { maxLevel: '3', style: 'none' }) : '',
  ].filter(Boolean);
  const body = [...intro, ...ast.steps.map((step) => renderStep(step, ast, attachmentNames, tpl))].join('\n');

  fs.writeFileSync(path.join(dir, 'page.xhtml'), `${body}\n`);
  const title = ast.guide.title || 'Untitled guide';
  fs.writeFileSync(path.join(dir, 'page-cloud.json'), `${JSON.stringify({
    spaceId: 'SPACE_ID',
    status: 'current',
    title,
    body: { representation: 'storage', value: body },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'page-datacenter.json'), `${JSON.stringify({
    type: 'page',
    title,
    space: { key: 'SPACEKEY' },
    body: { storage: { value: body, representation: 'storage' } },
  }, null, 2)}\n`);
  return attachmentNames.size;
}

function exportConfluence(ast, outDir, template = {}) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const folder = path.join(outDir, `${guideSlug(ast)}-confluence`);
  fs.mkdirSync(folder, { recursive: true });
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();

  const wordFile = wordFileName(ast);
  const file = path.join(folder, wordFile);
  fs.writeFileSync(file, buildConfluenceWord(ast, images, tpl));

  const apiDir = path.join(folder, 'rest-api');
  const attachmentCount = tpl.apiFiles ? writeApiFiles(ast, apiDir, images, tpl) : 0;
  fs.writeFileSync(path.join(folder, 'HOW-TO-IMPORT.txt'), importGuide(ast, wordFile, attachmentCount, tpl.apiFiles));
  return {
    file,
    folder,
    previewFile: folder,
    imageCount: [...images.keys()].length,
    apiPage: tpl.apiFiles ? path.join(apiDir, 'page.xhtml') : null,
  };
}

module.exports = { exportConfluence, DEFAULT_TEMPLATE, OPTION_INFO };
