'use strict';

const { renderMarkdownGuide } = require('./markdown-guide');
const { guideSummary } = require('./document-layout');
const { htmlToText } = require('../core/util');

/**
 * Wiki.js markdown exporter. Same step/body structure as the generic
 * Markdown exporter, but written for Wiki.js 2: its own callout syntax,
 * no raw-HTML decoration, Wiki.js's built-in page TOC instead of an inline
 * one, image links that can point at a wiki asset folder, and optional
 * page metadata for Git-synced wikis.
 */

const WIKIJS_TEMPLATE = {
  toc: false,
  includeImages: true,
  assetFolder: '',
  frontMatter: false,
};

const OPTION_INFO = {
  toc: { label: 'Add a contents list', hint: 'Wiki.js already shows a table of contents beside the page.' },
  includeImages: { label: 'Include screenshots' },
  assetFolder: {
    label: 'Wiki asset folder',
    placeholder: '/guides/images',
    hint: 'Where you will upload the screenshots in Wiki.js. Leave empty to keep links relative to the page.',
  },
  frontMatter: { label: 'Add page metadata', hint: 'For wikis synced from Git storage.' },
};

function yamlString(value) {
  return JSON.stringify(String(value || ''));
}

function frontMatterLines(ast) {
  const description = htmlToText(ast.guide.descriptionHtml || '').replace(/\s+/g, ' ').trim() || guideSummary(ast);
  const date = new Date(ast.generatedAt || Date.now()).toISOString();
  return [
    '---',
    `title: ${yamlString(ast.guide.title)}`,
    `description: ${yamlString(description)}`,
    'published: true',
    `date: ${date}`,
    'tags: ',
    'editor: markdown',
    `dateCreated: ${date}`,
    '---',
    '',
  ];
}

function exportWikiJs(ast, outDir, template = {}) {
  const tpl = { ...WIKIJS_TEMPLATE, ...template };
  const folder = String(tpl.assetFolder || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return renderMarkdownGuide(ast, outDir, tpl, {
    defaults: WIKIJS_TEMPLATE,
    alertStyle: 'wikijs',
    tocTitle: 'Contents',
    fileExt: '.md',
    accentBar: false,
    frontMatter: tpl.frontMatter ? frontMatterLines : null,
    // Wiki.js stores uploads flat inside the chosen folder.
    imageUrl: folder
      ? (relPath) => `${folder.startsWith('/') ? '' : '/'}${folder}/${relPath.split('/').pop()}`
      : (relPath) => relPath,
  });
}

module.exports = { exportWikiJs, DEFAULT_TEMPLATE: WIKIJS_TEMPLATE, OPTION_INFO };
