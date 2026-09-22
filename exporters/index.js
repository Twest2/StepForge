'use strict';

const { exportJson } = require('./json');
const { exportMarkdown } = require('./markdown');
const { exportWikiJs } = require('./wikijs');
const { exportHtmlSimple, exportHtmlRich } = require('./html');
const { exportConfluence } = require('./confluence');
const { exportPdf } = require('./pdf');
const { exportGifGuide } = require('./gif');
const { exportImageBundle } = require('./image-bundle');
const { exportDocx } = require('./docx');
const { exportPptx } = require('./pptx');

/** Unified dispatch: format id -> exporter(ast, outDir, templateOptions). */
const EXPORTERS = {
  json: exportJson,
  markdown: exportMarkdown,
  wikijs: exportWikiJs,
  'html-simple': exportHtmlSimple,
  'html-rich': exportHtmlRich,
  confluence: exportConfluence,
  pdf: exportPdf,
  gif: exportGifGuide,
  'image-bundle': exportImageBundle,
  docx: exportDocx,
  pptx: exportPptx,
};

/**
 * What the export dialog shows for each format: a one-line description and
 * friendly labels/controls for the options (OPTION_INFO) where an exporter
 * provides them. Options without an entry fall back to a label derived
 * from the key.
 */
const FORMAT_INFO = {
  pdf: { description: 'A print-ready document with a cover page and contents.' },
  markdown: { description: 'A .md file plus a folder of screenshots, for GitHub, GitLab, Azure DevOps and other wikis.' },
  docx: { description: 'A Word document you can keep editing.' },
  pptx: { description: 'A PowerPoint deck with one slide per step.' },
  'html-simple': { description: 'A single web page with screenshots built in. Easy to email, share or print.', options: require('./html').OPTION_INFO },
  'html-rich': { description: 'An interactive checklist page: contents sidebar, "done" toggles and zoomable screenshots.', options: require('./html').OPTION_INFO },
  gif: { description: 'An animated slideshow of the screenshots for chat, tickets and READMEs.', options: require('./gif').OPTION_INFO },
  'image-bundle': { description: 'A folder of numbered, annotated screenshots with an index.json.', options: require('./image-bundle').OPTION_INFO },
  confluence: { description: 'A Word document ready for Confluence\'s built-in import, so you can create the page from the website.', options: require('./confluence').OPTION_INFO },
  wikijs: { description: 'A Wiki.js 2 markdown page with Wiki.js callouts, plus a folder of screenshots.', options: require('./wikijs').OPTION_INFO },
  json: { description: 'The raw guide data and screenshots, for scripts and integrations.' },
};

// Order formats appear in the export dialog: the most common first.
const FORMAT_ORDER = ['pdf', 'markdown', 'docx', 'pptx', 'html-simple', 'html-rich', 'gif', 'image-bundle', 'confluence', 'wikijs', 'json'];

function runExport(format, ast, outDir, templateOptions = {}) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new Error(`unknown export format: ${format}`);
  return exporter(ast, outDir, templateOptions);
}

module.exports = { EXPORTERS, FORMAT_INFO, FORMAT_ORDER, runExport };
