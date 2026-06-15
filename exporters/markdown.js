'use strict';

const { DEFAULT_TEMPLATE, anchorFor, renderMarkdownGuide } = require('./markdown-guide');

/**
 * Markdown exporter. Writes <slug>.md plus a steps-<slug>/ image folder.
 * azureWiki mode emits resized image syntax (=WxH) Azure DevOps wikis accept.
 */

function exportMarkdown(ast, outDir, template = {}) {
  return renderMarkdownGuide(ast, outDir, template, {
    defaults: DEFAULT_TEMPLATE,
    alertStyle: 'html',
    tocTitle: 'Contents',
    fileExt: '.md',
  });
}

module.exports = { exportMarkdown, DEFAULT_TEMPLATE, anchorFor };
