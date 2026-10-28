'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('../core/util');
const { guideSlug, imagesDirName, writeStepImages, LEVEL_LABEL, stepContentGroups, codeBlockText } = require('./common');
const { markdownFenceLanguage } = require('../core/code-highlight');
const { htmlToMarkdown } = require('./htmlmd');
const { tocEntries, guideMetaLines, guideSummary } = require('./document-layout');
const { scaledPng } = require('./branding');

const DEFAULT_TEMPLATE = {
  toc: true,
  includeImages: true,
  azureWiki: false,
  githubAlerts: false,
  imageMaxWidth: 0, // 0 = natural size
};

const WIKIJS_CALLOUT_CLASS = {
  info: 'is-info',
  success: 'is-success',
  warn: 'is-warning',
  error: 'is-danger',
};

const HTML_CALLOUT_THEME = {
  info: { label: 'Note', border: '#2563eb', fg: '#1d4ed8', kind: 'note' },
  success: { label: 'Tip', border: '#10b981', fg: '#047857', kind: 'tip' },
  warn: { label: 'Warning', border: '#f59e0b', fg: '#b45309', kind: 'warning' },
  error: { label: 'Important', border: '#ef4444', fg: '#b91c1c', kind: 'important' },
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

function emitBlock(lines, tb, { alertStyle = 'gfm' } = {}) {
  const body = htmlToMarkdown(tb.descriptionHtml);
  if (alertStyle === 'html') {
    const theme = HTML_CALLOUT_THEME[tb.level] || HTML_CALLOUT_THEME.info;
    const label = theme.label;
    const title = tb.title ? `${label}: ${tb.title}` : label;
    const style = `border-left: 4px solid ${theme.border}; padding: 14px 16px; margin: 14px 0; border-radius: 0 16px 16px 0;`;
    lines.push(
      `<div class="sf-callout sf-callout-${theme.kind}" style="${style}">`,
      `<div style="font-weight: 700; color: ${theme.fg}; margin-bottom: ${body ? '6px' : '0'};">${escapeHtml(title)}</div>`,
    );
    if (body) lines.push(`<div style="color: inherit;">${tb.descriptionHtml || ''}</div>`);
    lines.push('</div>', '');
    return;
  }
  if (alertStyle === 'wikijs') {
    const label = tb.title || LEVEL_LABEL[tb.level] || 'Note';
    const className = WIKIJS_CALLOUT_CLASS[tb.level] || 'is-info';
    lines.push(`> **${label}**`);
    if (body) lines.push(`> ${quoteBody(body)}`);
    lines.push(`{.${className}}`, '');
    return;
  }

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
    lines.push(html ? `<p${align}><img src="${escapeHtml(url)}" alt="Logo" height="${Math.min(48, logo.height)}"></p>` : `![Logo](${url})`, '');
  }
  if (brand.header.text) lines.push(`*${markdownText(brand.header.text)}*`, '');
  return lines;
}

function renderMarkdownGuide(ast, outDir, template = {}, {
  defaults = DEFAULT_TEMPLATE,
  alertStyle = 'gfm',
  tocTitle = 'Contents',
  fileExt = '.md',
  accentBar = true,
  titleHeading = true,
  frontMatter = null, // (ast) => lines, written before the body
  imageUrl = (relPath) => relPath,
  brandHtml = true, // show the brand's logo and banner with <img> tags
} = {}) {
  const tpl = { ...defaults, ...template };
  fs.mkdirSync(outDir, { recursive: true });
  const images = tpl.includeImages ? writeStepImages(ast, outDir) : new Map();
  const lines = frontMatter ? frontMatter(ast) : [];
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
    lines.push(`## ${tocTitle}`, '');
    for (const entry of tocEntries(ast)) {
      const indent = '  '.repeat(entry.depth);
      lines.push(`${indent}- [${entry.number}. ${entry.title}](#${entry.anchor})`);
    }
    lines.push('');
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
    if (accentBar || withToc) lines.push(`<a id="${anchorFor(step)}"></a>`, '');
    for (const tb of beforeTitle) emitBlock(lines, tb, { alertStyle });
    lines.push(`${heading} ${step.number}. ${step.title || 'Untitled step'}`, '');
    if (step.skipped) lines.push('*(skipped)*', '');
    for (const tb of afterTitle) emitBlock(lines, tb, { alertStyle });
    for (const tb of beforeDescription) emitBlock(lines, tb, { alertStyle });
    if (step.descriptionHtml) lines.push(htmlToMarkdown(step.descriptionHtml), '');
    for (const tb of afterDescription) emitBlock(lines, tb, { alertStyle });

    for (const tb of beforeImage) emitBlock(lines, tb, { alertStyle });
    const img = images.get(step.stepId);
    if (img) {
      if (tpl.azureWiki && tpl.imageMaxWidth > 0) {
        lines.push(`![${markdownAlt(step.altText)}](${imageUrl(img.relPath)} =${tpl.imageMaxWidth}x)`, '');
      } else {
        lines.push(`![${markdownAlt(step.altText)}](${imageUrl(img.relPath)})`, '');
      }
    }
    for (const tb of afterImage) emitBlock(lines, tb, { alertStyle });

    for (const block of rest) {
      if (block.kind === 'text') {
        emitBlock(lines, block, { alertStyle });
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
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
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
};
