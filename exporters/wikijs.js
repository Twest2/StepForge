'use strict';

const { DEFAULT_TEMPLATE, renderMarkdownGuide } = require('./markdown-guide');

/**
 * Wiki.js markdown exporter. Same step/body structure as the generic
 * Markdown exporter, but omits the manual Contents section by default and
 * emits Wiki.js-friendly callout blocks.
 */

const WIKIJS_TEMPLATE = {
  toc: false,
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
