'use strict';

const { DEFAULT_TEMPLATE, renderMarkdownGuide } = require('./markdown-guide');

/**
 * Wiki.js markdown exporter. Same step/body structure as the generic
 * Markdown exporter, but uses Wiki.js-friendly callout blocks.
 */

const WIKIJS_TEMPLATE = {
  toc: true,
  includeImages: true,
  imageMaxWidth: 0,
};

function exportWikiJs(ast, outDir, template = {}) {
  return renderMarkdownGuide(ast, outDir, template, {
    defaults: WIKIJS_TEMPLATE,
    alertStyle: 'wikijs',
    tocTitle: 'Contents',
    fileExt: '.md',
  });
}

module.exports = { exportWikiJs, DEFAULT_TEMPLATE: WIKIJS_TEMPLATE };
