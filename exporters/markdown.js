'use strict';

const { DEFAULT_TEMPLATE, anchorFor, renderMarkdownGuide } = require('./markdown-guide');

/**
 * Markdown exporter. Writes <slug>.md plus a steps-<slug>/ image folder.
 * azureWiki mode emits resized image syntax (=WxH) Azure DevOps wikis accept.
 * githubAlerts mode writes callouts as GitHub alerts (> [!TIP]) and drops the
 * styled HTML GitHub would strip.
 */

const OPTION_INFO = {
  toc: { label: 'Add a table of contents', group: 'Contents' },
  includeImages: { label: 'Include screenshots', group: 'Contents' },
  githubAlerts: { label: 'GitHub Markdown', group: 'Compatibility', hint: 'Write callouts as GitHub alerts instead of styled HTML.' },
  azureWiki: { label: 'Azure DevOps wiki', group: 'Compatibility', hint: 'Size screenshots with the image syntax Azure DevOps wikis use.' },
  imageMaxWidth: { label: 'Maximum screenshot width', group: 'Compatibility', unit: 'px', min: 0, step: 10, dependsOn: 'azureWiki', hint: '0 keeps each screenshot at its own size.' },
};

function exportMarkdown(ast, outDir, template = {}) {
  const github = Boolean({ ...DEFAULT_TEMPLATE, ...template }.githubAlerts);
  return renderMarkdownGuide(ast, outDir, template, {
    defaults: DEFAULT_TEMPLATE,
    alertStyle: github ? 'gfm' : 'html',
    tocTitle: 'Contents',
    fileExt: '.md',
    accentBar: !github,
  });
}

module.exports = { exportMarkdown, DEFAULT_TEMPLATE, anchorFor, OPTION_INFO };
