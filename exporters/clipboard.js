'use strict';

const { escapeHtml, htmlToText } = require('../core/util');
const { encodePng } = require('../core/png');
const { highlightCode } = require('../core/code-highlight');
const { renderAllImages, stepContentGroups, codeBlockText, LEVEL_LABEL, levelLabel, flowchartImageKey, flowchartAlt } = require('./common');
const { guideMetaLines, stepCount } = require('./document-layout');
const { exportText } = require('../core/export-text');
const { fitRaster, scaledPng, cssFontStack } = require('./branding');

/**
 * The guide as clipboard content (Share → Copy to clipboard): HTML that
 * pastes into mail, chat and document apps (Outlook, Gmail, Teams, Google
 * Docs, Word, Notion), plus a plain-text version for apps that only take
 * text.
 *
 * Those apps drop <style> sheets, scripts and most layout CSS, so the HTML
 * is plain elements with inline styles, and nothing outside the guide's
 * content (no contents list, checklist or footer links). Screenshots are
 * the exported ones (annotations, blurs, focused view) as data: URLs,
 * scaled down to `maxImageWidth` so a long guide still fits on the
 * clipboard and in a mail message.
 */

const DEFAULT_TEMPLATE = {
  includeImages: true,
  maxImageWidth: 800,
  accentColor: '#2563EB',
};

const TEXT = '#1f2328';
const MUTED = '#59636e';
const BORDER = '#d0d7de';
const SOFT = '#f6f8fa';
// Single quotes: these go inside style="…" attributes.
const MONO = "Consolas, 'Courier New', monospace";

const LEVEL_COLORS = {
  info: { color: '#0969da', background: '#ddf4ff' },
  success: { color: '#1a7f37', background: '#dafbe1' },
  warn: { color: '#9a6700', background: '#fff8c5' },
  error: { color: '#cf222e', background: '#ffebe9' },
};

const style = (rules) => ` style="${rules}"`;

/**
 * A sanitized description fragment with inline styles on the elements apps
 * would otherwise show bare (tables, quotes, code), and internal step links
 * reduced to their text: a pasted guide has no steps to jump to.
 */
function inlineDescription(html) {
  return String(html || '')
    .replace(/<a\s+href="step:[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<table>/gi, `<table${style('border-collapse:collapse;margin:8px 0')}>`)
    .replace(/<(th|td)((?:\s+(?:colspan|rowspan)="\d+")*)>/gi, (m, tag, attrs) => `<${tag}${attrs}${style(`border:1px solid ${BORDER};padding:4px 8px;text-align:left;vertical-align:top${tag.toLowerCase() === 'th' ? `;background:${SOFT}` : ''}`)}>`)
    .replace(/<blockquote>/gi, `<blockquote${style(`margin:8px 0;padding:0 12px;border-left:3px solid ${BORDER};color:${MUTED}`)}>`)
    .replace(/<pre>/gi, `<pre${style(`font-family:${MONO};font-size:13px;background:${SOFT};padding:8px 12px;white-space:pre-wrap`)}>`)
    .replace(/<code>/gi, `<code${style(`font-family:${MONO};font-size:13px`)}>`);
}

function callout(block, ast) {
  const level = LEVEL_LABEL[block.level] ? block.level : 'info';
  const { color, background } = LEVEL_COLORS[level];
  const heading = escapeHtml(block.title || levelLabel(level, ast));
  const body = block.descriptionHtml ? `<div>${inlineDescription(block.descriptionHtml)}</div>` : '';
  return `<div${style(`margin:12px 0;padding:8px 12px;border:1px solid ${color};border-radius:6px;background:${background}`)}>`
    + `<p${style(`margin:0;font-weight:bold;color:${color}`)}>${heading}</p>${body}</div>`;
}

function codeHtml(block, ast) {
  const text = codeBlockText(block);
  const hl = highlightCode(text, block.language, ast.codeStyle);
  const box = `font-family:${MONO};font-size:13px;line-height:1.45;padding:8px 12px;margin:12px 0;border-radius:6px;white-space:pre-wrap`;
  if (!hl) return `<pre${style(`${box};background:${SOFT};color:${TEXT}`)}>${escapeHtml(text)}</pre>`;
  const lines = hl.lines.map((line) => line.map((run) => {
    const rules = [run.color !== hl.foreground ? `color:${run.color}` : '', run.italic ? 'font-style:italic' : '', run.bold ? 'font-weight:bold' : '']
      .filter(Boolean).join(';');
    return rules ? `<span${style(rules)}>${escapeHtml(run.text)}</span>` : escapeHtml(run.text);
  }).join(''));
  return `<pre${style(`${box};background:${hl.background};color:${hl.foreground}`)}>${lines.join('\n')}</pre>`;
}

function tableHtml(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const cell = (tag, value, extra = '') => `<${tag}${style(`border:1px solid ${BORDER};padding:4px 8px;text-align:left;vertical-align:top${extra}`)}>${escapeHtml(value ?? '')}</${tag}>`;
  return `<table${style('border-collapse:collapse;margin:12px 0')}>${rows.map((row, r) => `<tr>${Array.from({ length: width }, (_, i) => (r === 0
    ? cell('th', row[i], `;background:${SOFT}`)
    : cell('td', row[i]))).join('')}</tr>`).join('')}</table>`;
}

/** A PNG data: URL for an RGBA image, scaled to at most maxWidth pixels wide. */
function pngImage(img, maxWidth) {
  const out = fitRaster(img, maxWidth, Number.MAX_SAFE_INTEGER);
  return { src: `data:image/png;base64,${encodePng(out).toString('base64')}`, width: out.width, height: out.height };
}

function imageTag({ src, width, height }, alt, extra = '') {
  return `<img src="${src}" width="${width}" height="${height}" alt="${escapeHtml(alt)}"${style(`max-width:100%;height:auto${extra}`)}>`;
}

function renderStep(step, ast, images, tpl) {
  const { t } = exportText(ast);
  const groups = stepContentGroups(step);
  const chart = () => {
    const img = images.get(flowchartImageKey(step.stepId));
    return img ? `<p${style('margin:12px 0')}>${imageTag(pngImage(img, tpl.maxImageWidth), flowchartAlt(step, ast), '')}</p>` : '';
  };
  // Text blocks and the flowchart block, at their positions.
  const callouts = (list) => list.map((tb) => (tb.kind === 'flowchart' ? chart() : callout(tb, ast))).filter(Boolean);
  const out = [...callouts(groups.beforeTitle)];
  const tag = step.depth > 0 ? 'h3' : 'h2';
  const size = step.depth > 0 ? 16 : 18;
  const skipped = step.skipped ? ` <span${style(`font-size:12px;font-weight:normal;color:${MUTED}`)}>${escapeHtml(t('(Skipped)'))}</span>` : '';
  out.push(`<${tag}${style(`font-size:${size}px;line-height:1.3;margin:24px 0 8px;color:${TEXT}`)}>`
    + `<span${style(`color:${tpl.accentColor}`)}>${escapeHtml(step.number)}.</span> ${escapeHtml(step.title || t('Untitled step'))}${skipped}</${tag}>`);
  out.push(...callouts(groups.afterTitle), ...callouts(groups.beforeDescription));
  if (step.descriptionHtml) out.push(`<div>${inlineDescription(step.descriptionHtml)}</div>`);
  out.push(...callouts(groups.afterDescription), ...callouts(groups.beforeImage));
  const img = images.get(step.stepId);
  if (img) out.push(`<p${style('margin:12px 0')}>${imageTag(pngImage(img, tpl.maxImageWidth), step.altText, `;border:1px solid ${BORDER}`)}</p>`);
  out.push(...callouts(groups.afterImage));
  for (const block of groups.rest) {
    if (block.kind === 'text') out.push(callout(block, ast));
    else if (block.kind === 'code') out.push(codeHtml(block, ast));
    else if (block.kind === 'table' && block.rows && block.rows.length) out.push(tableHtml(block.rows));
  }
  return out.join('\n');
}

function metaText(ast) {
  return [stepCount(ast), ...guideMetaLines(ast)].join(' · ');
}

function brandHeader(brand, tpl, ast) {
  const { t } = exportText(ast);
  if (!brand) return [];
  const out = [];
  const banner = brand.banner ? scaledPng(brand.banner, tpl.maxImageWidth, 240) : null;
  if (banner) out.push(`<p${style('margin:0 0 16px')}>${imageTag({ src: `data:image/png;base64,${banner.data.toString('base64')}`, width: banner.width, height: banner.height }, '')}</p>`);
  const logo = brand.logo ? scaledPng(brand.logo, 260, 48) : null;
  if (logo) out.push(`<p${style('margin:0 0 8px')}>${imageTag({ src: `data:image/png;base64,${logo.data.toString('base64')}`, width: logo.width, height: logo.height }, t('Logo'))}</p>`);
  if (brand.header.text) out.push(`<p${style(`margin:0 0 12px;color:${MUTED};font-size:13px`)}>${escapeHtml(brand.header.text)}</p>`);
  return out;
}

function clipboardHtml(ast, tpl, images) {
  const { t } = exportText(ast);
  const brand = ast.branding;
  const font = brand?.fonts?.body?.name ? cssFontStack(brand.fonts.body.name) : '"Segoe UI", Arial, sans-serif';
  const parts = [
    ...brandHeader(brand, tpl, ast),
    `<h1${style(`font-size:24px;line-height:1.25;margin:0 0 8px;color:${TEXT}`)}>${escapeHtml(ast.guide.title || t('Untitled guide'))}</h1>`,
    ast.guide.descriptionHtml ? `<div>${inlineDescription(ast.guide.descriptionHtml)}</div>` : '',
    `<p${style(`margin:8px 0 0;color:${MUTED};font-size:12px`)}>${escapeHtml(metaText(ast))}</p>`,
    ...ast.steps.map((step) => renderStep(step, ast, images, tpl)),
    brand?.footer.text ? `<p${style(`margin:24px 0 0;color:${MUTED};font-size:12px`)}>${escapeHtml(brand.footer.text)}</p>` : '',
  ].filter(Boolean);
  return `<div${style(`font-family:${escapeHtml(font.replace(/"/g, '\''))};font-size:14px;line-height:1.5;color:${TEXT}`)}>\n${parts.join('\n')}\n</div>`;
}

const indent = (text, prefix) => text.split('\n').map((line) => (line ? prefix + line : line)).join('\n');

function textBlock(block, ast) {
  const { t } = exportText(ast);
  const label = levelLabel(block.level, ast);
  const heading = block.title ? t('{label}: {title}', { label, title: block.title }) : t('{label}:', { label });
  const body = htmlToText(block.descriptionHtml || '').trim();
  return body ? `${heading}\n${body}` : heading;
}

/** The same guide as plain text, for apps that don't take HTML. */
function clipboardText(ast) {
  const { t } = exportText(ast);
  const out = [ast.guide.title || t('Untitled guide')];
  const description = htmlToText(ast.guide.descriptionHtml || '').trim();
  if (description) out.push(description);
  out.push(metaText(ast));
  if (ast.branding?.header.text) out.unshift(ast.branding.header.text);
  for (const step of ast.steps) {
    const groups = stepContentGroups(step);
    const parts = [];
    // Plain text has no pictures: a flowchart block is left out.
    const texts = (list) => list.filter((tb) => tb.kind !== 'flowchart').map((tb) => textBlock(tb, ast));
    parts.push(...texts(groups.beforeTitle));
    parts.push(`${step.number}. ${step.title || t('Untitled step')}${step.skipped ? ` ${t('(Skipped)')}` : ''}`);
    parts.push(...texts(groups.afterTitle), ...texts(groups.beforeDescription));
    const desc = htmlToText(step.descriptionHtml || '').trim();
    if (desc) parts.push(desc);
    parts.push(...texts(groups.afterDescription), ...texts(groups.beforeImage), ...texts(groups.afterImage));
    for (const block of groups.rest) {
      if (block.kind === 'text') parts.push(textBlock(block, ast));
      else if (block.kind === 'code') parts.push(indent(codeBlockText(block), '    '));
      else if (block.kind === 'table' && block.rows && block.rows.length) parts.push(block.rows.map((row) => row.join(' | ')).join('\n'));
    }
    out.push(parts.join('\n\n'));
  }
  if (ast.branding?.footer.text) out.push(ast.branding.footer.text);
  return `${out.join('\n\n')}\n`;
}

/**
 * Build the clipboard content. Returns { html, text, imageCount }. Writes
 * no files: `outDir` is only there so the export worker can run it like
 * any other exporter.
 */
function exportClipboard(ast, outDir, template = {}) {
  // The brand's primary color numbers the steps, as in the HTML exports.
  const primary = ast.branding?.colors?.primary;
  const tpl = { ...DEFAULT_TEMPLATE, ...(primary && { accentColor: primary }), ...template };
  if (!/^#[0-9a-f]{6}$/i.test(String(tpl.accentColor))) tpl.accentColor = DEFAULT_TEMPLATE.accentColor;
  tpl.maxImageWidth = Math.max(100, Math.round(Number(tpl.maxImageWidth) || DEFAULT_TEMPLATE.maxImageWidth));
  const images = tpl.includeImages ? renderAllImages(ast) : new Map();
  return { html: clipboardHtml(ast, tpl, images), text: clipboardText(ast), imageCount: images.size };
}

const PNG_DATA_URL = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g;

/**
 * Swap each PNG image for a JPEG where that is smaller, so a guide of
 * photo-like screenshots stays a reasonable size. `toJpeg(png)` returns the
 * JPEG bytes, or null to keep the PNG (an image with transparency).
 */
function preferSmallerImages(html, toJpeg) {
  return html.replace(PNG_DATA_URL, (match, base64) => {
    const png = Buffer.from(base64, 'base64');
    let jpeg = null;
    try { jpeg = toJpeg(png); } catch { jpeg = null; }
    if (!jpeg || jpeg.length >= png.length) return match;
    return `src="data:image/jpeg;base64,${jpeg.toString('base64')}"`;
  });
}

module.exports = { exportClipboard, preferSmallerImages, DEFAULT_TEMPLATE };
