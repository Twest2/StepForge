'use strict';

/**
 * Settings → Branding → Advanced CSS → Write with AI: a local model (Ollama)
 * writes CSS for the HTML exports from a description of the change. The
 * result is shown for review and only added to the profile when the user
 * chooses to.
 */

// The model sees this much of the profile's CSS, so it doesn't fight it.
const CURRENT_CSS_PROMPT_CHARS = 6000;
const MAX_REQUEST_CHARS = 500;
const MAX_RESULT_CHARS = 20000;

// What the HTML exports can be styled with (docs/BRANDING.md#advanced-css).
const STYLE_REFERENCE = [
  'Variables (use them instead of fixed colors where they fit):',
  '--brand-primary, --brand-accent, --brand-text: the brand colors.',
  '--on-primary: black or white, whichever reads on the primary color.',
  '--link: link color. --text, --muted, --bg, --soft, --border: body text, secondary text, page background, panel background, lines.',
  '--info, --success, --warn, --error (each with a -bg partner such as --warn-bg): Note, Tip, Warning and Important callouts.',
  '--font-body, --font-heading: font lists.',
  '',
  'Selectors:',
  '.page (.page.rich in the rich export): the page column. The rich one is a grid of nav.toc and .content.',
  '.doc-header: top of the page, with .cover-standard, .cover-centered or .cover-band.',
  '.brand-banner, .brand-bar, .brand-logo, .brand-tagline: banner image, the logo row, the logo, the header text.',
  '.doc-header .rule, .doc-header h1, .lede, .meta: accent line, guide title, description, step count line.',
  'nav.contents (simple), nav.toc (rich): contents; entries are .toc-list li.d0 to li.d3, each a holding .num and .label.',
  '.toc-list a.active, .toc-list a.done, .progress, .progress .bar, .progress .fill: rich-export reading state and progress bar.',
  'section.step (.depth-1 to .depth-3 for substeps, .skipped, .done): one step.',
  '.step-head, .step-num, .step-head h2: title row, number badge, step title.',
  '.pill: the "Skipped" label. .done-toggle: the Done checkbox (rich).',
  '.step-body, .desc: everything under the title, and the description.',
  'figure.shot img: screenshots.',
  'aside.callout (.callout-info, .callout-success, .callout-warn, .callout-error) with .callout-title and .callout-body.',
  'pre.code, .code-block, .copy-code: code blocks, their wrapper, the copy button.',
  '.table-wrap table, th, td: tables. .doc-footer: the footer line. .lightbox: the screenshot viewer (rich).',
].join('\n');

/** The prompt for one request: what to change, with the profile's colors, fonts and current CSS. */
function buildBrandCssPrompt({ request = '', css = '', profile = {} } = {}) {
  const colors = profile.colors || {};
  const fonts = profile.fonts || {};
  const current = String(css || '').trim();
  const clipped = current.length > CURRENT_CSS_PROMPT_CHARS ? `${current.slice(0, CURRENT_CSS_PROMPT_CHARS)}\n/* … */` : current;
  const prompt = [
    'Write CSS for a step-by-step guide exported as a web page.',
    'Return JSON only, with no markdown fences and no commentary:',
    '{ "css": string }',
    '',
    `The change to make: ${String(request).trim().slice(0, MAX_REQUEST_CHARS)}`,
    '',
    `Brand colors: primary ${colors.primary || '(default)'}, accent ${colors.accent || '(default)'}, text ${colors.text || '(default)'}.`,
    `Fonts: headings ${fonts.heading?.name || '(default)'}, body ${fonts.body?.name || '(default)'}.`,
    '',
    STYLE_REFERENCE,
    '',
    `The profile's CSS so far:\n${clipped || '(none)'}`,
    '',
    'Rules:',
    '- Write only the new rules this change needs. They are added after the CSS so far, so they win.',
    '- Use only the selectors and variables listed above. Prefer var(--brand-primary) and the other variables to fixed colors.',
    '- Change nothing that wasn\'t asked for.',
    '- No @import, no url() to websites, no comments, no HTML.',
    '- Keep it short and valid.',
  ].join('\n');
  return {
    systemPrompt: 'You are a front-end developer who writes small, clean CSS. Emit only valid JSON matching the schema. Never add commentary or markdown.',
    prompt,
  };
}

/** Remove @import rules and url()s that leave the page: a brand profile's CSS never reaches the internet. */
function withoutOutsideRequests(css) {
  return css
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/url\(\s*(?!['"]?\s*data:)[^)]*\)/gi, 'none');
}

/**
 * The CSS in a model's reply, cleaned up: fences and markup removed, outside
 * requests dropped. Throws when there's no usable CSS.
 */
function normalizeBrandCss(data) {
  let css = typeof data?.css === 'string' ? data.css : '';
  css = css.replace(/^```(?:css)?\s*|\s*```$/g, '');
  // Never markup: the CSS goes inside a <style> element.
  css = css.replace(/<\/?[a-z][^>]*>/gi, '').replace(/</g, '');
  css = withoutOutsideRequests(css).replace(/\n{3,}/g, '\n\n').trim();
  if (!css || !css.includes('{')) {
    throw new Error('The model didn’t write any CSS. Try describing the change another way.');
  }
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth < 0) break;
  }
  if (depth !== 0) throw new Error('The model’s CSS was cut off. Try again, or ask for a smaller change.');
  if (css.length > MAX_RESULT_CHARS) throw new Error('The model wrote more CSS than a change needs. Ask for a smaller change.');
  return css;
}

module.exports = {
  MAX_REQUEST_CHARS,
  STYLE_REFERENCE,
  buildBrandCssPrompt,
  normalizeBrandCss,
};
