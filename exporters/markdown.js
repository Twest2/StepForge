'use strict';

const { DEFAULT_TEMPLATE, anchorFor, renderMarkdownGuide } = require('./markdown-guide');

/**
 * Markdown exporter. Writes <slug>.md plus a steps-<slug>/ image folder,
 * shaped for the site it will be read on (`target`):
 *   standard    callouts as styled HTML (GitLab, Gitea, most viewers)
 *   github      callouts as GitHub alerts (> [!TIP]), no styled HTML
 *   azure       styled HTML plus the =WIDTHx image size Azure DevOps wikis use
 *   mkdocs      title front matter, !!! admonitions (MkDocs / Material)
 *   docusaurus  title front matter, ::: admonitions, MDX-safe text
 */

const TARGETS = ['standard', 'github', 'azure', 'mkdocs', 'docusaurus'];

const OPTION_INFO = {
  toc: { label: 'Add a table of contents', group: 'Contents' },
  includeImages: { label: 'Include screenshots', group: 'Contents' },
  target: { label: 'Write for', group: 'Compatibility', hint: 'Callouts, page title and image links follow what this site expects.', choices: [
    { value: 'standard', label: 'Standard Markdown' },
    { value: 'github', label: 'GitHub' },
    { value: 'azure', label: 'Azure DevOps wiki' },
    { value: 'mkdocs', label: 'MkDocs' },
    { value: 'docusaurus', label: 'Docusaurus' },
  ] },
  imageMaxWidth: { label: 'Maximum screenshot width', group: 'Compatibility', unit: 'px', min: 0, step: 10, dependsOn: 'target', dependsOnValue: 'azure', hint: '0 keeps each screenshot at its own size.' },
};

/** The site to write for; options saved before the dropdown had two switches. */
function markdownTarget(template = {}) {
  if (TARGETS.includes(template.target)) return template.target;
  if (template.githubAlerts) return 'github';
  if (template.azureWiki) return 'azure';
  return 'standard';
}

const titleFrontMatter = (ast) => ['---', `title: ${JSON.stringify(String(ast.guide.title || ''))}`, '---', ''];

function exportMarkdown(ast, outDir, template = {}) {
  const target = markdownTarget(template);
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const docsSite = target === 'mkdocs' || target === 'docusaurus';
  return renderMarkdownGuide(ast, outDir, template, {
    defaults: DEFAULT_TEMPLATE,
    alertStyle: { github: 'gfm', mkdocs: 'mkdocs', docusaurus: 'docusaurus' }[target] || 'html',
    fileExt: '.md',
    accentBar: target === 'standard' || target === 'azure',
    frontMatter: docsSite ? titleFrontMatter : null,
    // Docusaurus treats ./ links as files beside the page and bundles them.
    imageUrl: target === 'docusaurus' ? (relPath) => `./${relPath}` : (relPath) => relPath,
    // MDX needs self-closed tags; plain Markdown images work everywhere.
    brandHtml: target !== 'docusaurus',
    imageWidth: target === 'azure' ? Math.max(0, Number(tpl.imageMaxWidth) || 0) : 0,
    mdx: target === 'docusaurus',
  });
}

module.exports = { exportMarkdown, DEFAULT_TEMPLATE, anchorFor, OPTION_INFO, TARGETS, markdownTarget };
