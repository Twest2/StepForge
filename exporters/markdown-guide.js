'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
const { guideSlug, imagesDirName, writeStepImages, LEVEL_LABEL, levelLabel, stepContentGroups, codeBlockText, flowchartImageKey, flowchartAlt, stepLinkText, goToParts } = require('./common');
const { exportText } = require('../core/export-text');
const { markdownFenceLanguage } = require('../core/code-highlight');
const { htmlToMarkdown } = require('./htmlmd');
const { tocEntries, guideMetaLines, guideSummary } = require('./document-layout');
const { scaledPng } = require('./branding');

const DEFAULT_TEMPLATE = {
  toc: true,
  includeImages: true,
  target: 'standard', // standard | github | azure | mkdocs | docusaurus
  imageMaxWidth: 0, // Azure DevOps only; 0 = natural size
};

const WIKIJS_CALLOUT_CLASS = {
  info: 'is-info',
  success: 'is-success',
  warn: 'is-warning',
  error: 'is-danger',
};

// MkDocs (admonition extension) and Docusaurus admonition types.
const MKDOCS_KIND = { info: 'note', success: 'tip', warn: 'warning', error: 'danger' };
const DOCUSAURUS_KIND = { info: 'info', success: 'tip', warn: 'warning', error: 'danger' };

const HTML_CALLOUT_THEME = {
  info: { border: '#2563eb', fg: '#1d4ed8', kind: 'note' },
  success: { border: '#10b981', fg: '#047857', kind: 'tip' },
  warn: { border: '#f59e0b', fg: '#b45309', kind: 'warning' },
  error: { border: '#ef4444', fg: '#b91c1c', kind: 'important' },
};

/** Alt text inside ![…]: backslash-escape what would end it early or read as markup. */
function markdownAlt(text) {
  return String(text || '').replace(/[\\[\]<>]/g, '\\$&');
}

function anchorFor(step) {
  return `step-${step.number.replace(/\./g, '-')}`;
}

function quoteBody(text) {
  return text ? text.replace(/\n/g, '\n> ') : '';
}

/**
 * A description written in Markdown, as written: step links point at the
 * step's heading, and active HTML (scripts, styles, frames) is left out.
 */
function markdownSource(source) {
  return source
    .replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|template)\b[^>]*>/gi, '')
    .replace(/\]\(step:([A-Za-z0-9_-]+)\)/g, '](#step-$1)')
    .trim();
}

/**
 * Under a flowchart picture: its shapes' step links, which a picture can't
 * hold in Markdown ("Go to: [Step 3](#step-…) · [Step 5](#step-…)").
 */
function chartLinkLine(chart, ast) {
  const seen = new Set();
  const links = (chart?.links || []).filter((link) => !seen.has(link.stepId) && seen.add(link.stepId)).map((link) => {
    const target = ast.steps.find((s) => s.stepId === link.stepId);
    return target ? `[${stepLinkText(target, ast)}](#step-${target.stepId})` : '';
  }).filter(Boolean);
  const { before, after } = goToParts(ast);
  return links.length ? [`${before}${links.join(' · ')}${after}`, ''] : [];
}

function emitBlock(lines, tb, { alertStyle = 'gfm', ast = null } = {}) {
  const { t } = exportText(ast);
  const body = htmlToMarkdown(tb.descriptionHtml);
  if (alertStyle === 'html') {
    const level = HTML_CALLOUT_THEME[tb.level] ? tb.level : 'info';
    const theme = HTML_CALLOUT_THEME[level];
    const label = levelLabel(level, ast);
    const title = tb.title ? t('{label}: {title}', { label, title: tb.title }) : label;
    const style = `border-left: 4px solid ${theme.border}; padding: 14px 16px; margin: 14px 0; border-radius: 0 16px 16px 0;`;
    lines.push(
      `<div class="sf-callout sf-callout-${theme.kind}" style="${style}">`,
      `<div style="font-weight: 700; color: ${theme.fg}; margin-bottom: ${body ? '6px' : '0'};">${escapeHtml(title)}</div>`,
    );
    if (body) lines.push(`<div style="color: inherit;">${tb.descriptionHtml || ''}</div>`);
    lines.push('</div>', '');
    return;
  }
  if (alertStyle === 'mkdocs') {
    // !!! note "Title", then the body indented four spaces.
    const title = (tb.title || levelLabel(tb.level, ast)).replace(/\s+/g, ' ');
    lines.push(`!!! ${MKDOCS_KIND[tb.level] || 'note'} "${title}"`);
    if (body) lines.push(...body.split('\n').map((line) => (line ? `    ${line}` : '')));
    lines.push('');
    return;
  }
  if (alertStyle === 'docusaurus') {
    const title = (tb.title || levelLabel(tb.level, ast)).replace(/\s+/g, ' ').replace(/[[\]\\]/g, '\\$&');
    lines.push(`:::${DOCUSAURUS_KIND[tb.level] || 'info'}[${title}]`, '');
    if (body) lines.push(body, '');
    lines.push(':::', '');
    return;
  }
  if (alertStyle === 'wikijs') {
    const label = tb.title || levelLabel(tb.level, ast);
    const className = WIKIJS_CALLOUT_CLASS[tb.level] || 'is-info';
    lines.push(`> **${label}**`);
    if (body) lines.push(`> ${quoteBody(body)}`);
    lines.push(`{.${className}}`, '');
    return;
  }

  // GitHub only knows the English alert names (> [!NOTE]).
  const label = LEVEL_LABEL[tb.level] || 'Note';
  lines.push(`> [!${label.toUpperCase()}]`);
  if (tb.title) lines.push(`> **${tb.title}**`);
  if (body) lines.push(`> ${quoteBody(body)}`);
  lines.push('');
}

/** Plain text that Markdown shouldn't read as formatting. */
function markdownText(text) {
  return String(text || '').replace(/[\\`*_[\]<>#|]/g, '\\$&');
}

const BRAND_FILES = ['brand-banner.png', 'brand-logo.png'];

/**
 * The brand's banner and logo as PNGs beside the screenshots, and the lines
 * that show them. `html` writes <img> tags sized for a sharp logo (GitHub,
 * GitLab and Azure DevOps render them); otherwise plain Markdown images at
 * their own size, for wikis that don't allow HTML.
 */
function brandImageLines(ast, outDir, { html, imageUrl }) {
  const { t } = exportText(ast);
  const brand = ast.branding;
  const dir = path.join(outDir, imagesDirName(ast));
  if (!brand) {
    // An earlier branded export into this folder shouldn't leave its logo behind.
    for (const name of BRAND_FILES) fs.rmSync(path.join(dir, name), { force: true });
    return [];
  }
  const lines = [];
  const align = brand.cover === 'centered' ? ' align="center"' : '';
  const write = (name, png) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), png.data);
    return imageUrl(`${imagesDirName(ast)}/${name}`);
  };
  const banner = brand.banner ? scaledPng(brand.banner, 1600, 480) : null;
  if (banner) {
    const url = write('brand-banner.png', banner);
    lines.push(html ? `<p${align}><img src="${escapeHtml(url)}" alt="" width="100%"></p>` : `![](${url})`, '');
  }
  const logo = brand.logo ? scaledPng(brand.logo, html ? 480 : 320, html ? 96 : 64) : null;
  if (logo) {
    const url = write('brand-logo.png', logo);
    const alt = t('Logo');
    lines.push(html ? `<p${align}><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" height="${Math.min(48, logo.height)}"></p>` : `![${markdownAlt(alt)}](${url})`, '');
  }
  if (brand.header.text) lines.push(`*${markdownText(brand.header.text)}*`, '');
  return lines;
}

/**
 * Docusaurus reads .md files as MDX, where `{` starts a JavaScript
 * expression and `<` a JSX tag: escape them outside code, keeping the
 * step anchors StepForge writes.
 */
function mdxSafe(markdown) {
  let fence = null;
  return markdown.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (marker) { fence = marker[1]; return line; }
    if (/^<a id="[\w-]+"><\/a>$/.test(line)) return line;
    // Odd parts are inline code, which MDX leaves alone.
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part
      : part.replace(/\\?[{}<]/g, (m) => (m.length === 2 ? m : `\\${m}`)))).join('');
  }).join('\n');
}

function renderMarkdownGuide(ast, outDir, template = {}, {
  defaults = DEFAULT_TEMPLATE,
  alertStyle = 'gfm',
  tocTitle = null, // the export language's "Contents"
  fileExt = '.md',
  accentBar = true,
  titleHeading = true,
  frontMatter = null, // (ast) => lines, written before the body
  imageUrl = (relPath) => relPath,
  brandHtml = true, // show the brand's logo and banner with <img> tags
  imageWidth = 0, // > 0: Azure DevOps image size syntax (=WIDTHx)
  mdx = false, // escape text that MDX (Docusaurus) would read as code
} = {}) {
  const tpl = { ...defaults, ...template };
  const { t, tc } = exportText(ast);
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? writeStepImages(ast, outDir) : new Map();
  const head = frontMatter ? frontMatter(ast) : [];
  const lines = [];
  const withToc = tpl.toc && ast.steps.length > 1;

  lines.push(...brandImageLines(ast, outDir, { html: brandHtml, imageUrl }));
  if (titleHeading) lines.push(`# ${ast.guide.title}`, '');
  const accent = ast.branding ? ast.branding.colors.primary.toLowerCase() : '#2563eb';
  if (accentBar) lines.push(`<div style="height:4px;background:${accent};border-radius:999px;margin:12px 0 18px;"></div>`, '');
  const metaLines = guideMetaLines(ast);
  if (metaLines.length) lines.push(metaLines.join(' · '), '');
  lines.push(`*${guideSummary(ast)}*`, '');
  if (ast.guide.descriptionHtml) lines.push(htmlToMarkdown(ast.guide.descriptionHtml), '');

  if (withToc) {
    lines.push(`## ${tocTitle || tc('Table of contents', 'Contents')}`, '');
    for (const entry of tocEntries(ast)) {
      const indent = '  '.repeat(entry.depth);
      lines.push(`${indent}- [${entry.number}. ${entry.title}](#${entry.anchor})`);
    }
    lines.push('');
  }

  // Steps something links to (a description's Step link, a flowchart
  // shape) always get their heading anchor, which those links point at.
  const linkTargets = new Set();
  const collectTargets = (text) => {
    for (const m of String(text || '').matchAll(/step:([A-Za-z0-9_-]+)/g)) linkTargets.add(m[1]);
  };
  collectTargets(ast.guide.descriptionHtml);
  for (const step of ast.steps) {
    collectTargets(step.descriptionHtml);
    collectTargets(step.descriptionMarkdown);
    for (const block of step.blocks || []) collectTargets(block.descriptionHtml);
    for (const link of [...(step.image?.links || []), ...(step.flowchartImage?.links || [])]) linkTargets.add(link.stepId);
  }

  for (const step of ast.steps) {
    const heading = step.depth > 0 ? '###' : '##';
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
    const emit = (tb) => {
      if (tb.kind !== 'flowchart') { emitBlock(lines, tb, { alertStyle, ast }); return; }
      const chart = images.get(flowchartImageKey(step.stepId));
      if (chart) lines.push(`![${markdownAlt(flowchartAlt(step, ast))}](${imageUrl(chart.relPath)})`, '', ...chartLinkLine(step.flowchartImage, ast));
    };
    if (accentBar || withToc || linkTargets.has(step.stepId)) lines.push(`<a id="${anchorFor(step)}"></a>`, '');
    for (const tb of beforeTitle) emit(tb);
    lines.push(`${heading} ${step.number}. ${step.title || t('Untitled step')}`, '');
    if (step.skipped) lines.push(`*${t('(skipped)')}*`, '');
    for (const tb of afterTitle) emit(tb);
    for (const tb of beforeDescription) emit(tb);
    if (step.descriptionMarkdown) lines.push(markdownSource(step.descriptionMarkdown), '');
    else if (step.descriptionHtml) lines.push(htmlToMarkdown(step.descriptionHtml), '');
    for (const tb of afterDescription) emit(tb);

    for (const tb of beforeImage) emit(tb);
    const img = images.get(step.stepId);
    if (img) {
      if (imageWidth > 0) {
        lines.push(`![${markdownAlt(step.altText)}](${imageUrl(img.relPath)} =${imageWidth}x)`, '');
      } else {
        lines.push(`![${markdownAlt(step.altText)}](${imageUrl(img.relPath)})`, '');
      }
      if (step.image?.flowchart) lines.push(...chartLinkLine(step.image, ast));
    }
    for (const tb of afterImage) emit(tb);

    for (const block of rest) {
      if (block.kind === 'text') {
        emitBlock(lines, block, { alertStyle, ast });
      } else if (block.kind === 'code') {
        lines.push(`\`\`\`${markdownFenceLanguage(block.language)}`, codeBlockText(block), '```', '');
      } else if (block.kind === 'table') {
        if (!block.rows || !block.rows.length) continue;
        const width = Math.max(...block.rows.map((r) => r.length));
        const pad = (r) => { const c = [...r]; while (c.length < width) c.push(''); return c; };
        lines.push(`| ${pad(block.rows[0]).join(' | ')} |`);
        lines.push(`|${' --- |'.repeat(width)}`);
        for (const row of block.rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
        lines.push('');
      }
    }
  }

  if (ast.branding?.footer.text) lines.push('---', '', `*${markdownText(ast.branding.footer.text)}*`);

  const file = path.join(outDir, `${guideSlug(ast)}${fileExt}`);
  let body = lines.join('\n');
  if (mdx) body = mdxSafe(body);
  let text = [...head, body].join('\n').replace(/\n{3,}/g, '\n\n');
  // Step links in descriptions point at step ids; retarget them to the
  // exported heading anchors.
  for (const step of ast.steps) text = text.split(`(#step-${step.stepId})`).join(`(#${anchorFor(step)})`);
  fs.writeFileSync(file, text + '\n');
  return { file, imageCount: images.size };
}

module.exports = {
  DEFAULT_TEMPLATE,
  anchorFor,
  renderMarkdownGuide,
  mdxSafe,
};
