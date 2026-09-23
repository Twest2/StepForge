'use strict';

const { DEFAULT_TEMPLATE, anchorFor, renderMarkdownGuide } = require('./markdown-guide');

/**
 * Markdown exporter. Writes <slug>.md plus a steps-<slug>/ image folder.
 * azureWiki mode emits resized image syntax (=WxH) Azure DevOps wikis accept.
 * githubAlerts mode writes callouts as GitHub alerts (> [!TIP]) and drops the
 * styled HTML GitHub would strip.
 */

const OPTION_INFO = {
  githubAlerts: { label: 'GitHub Markdown', hint: 'Write callouts as GitHub alerts (> [!TIP]) instead of styled HTML.' },
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
