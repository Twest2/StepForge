'use strict';

const { exportJson } = require('./json');
const { exportMarkdown } = require('./markdown');
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
  'html-simple': exportHtmlSimple,
  'html-rich': exportHtmlRich,
  confluence: exportConfluence,
  pdf: exportPdf,
  gif: exportGifGuide,
  'image-bundle': exportImageBundle,
  docx: exportDocx,
  pptx: exportPptx,
};

function runExport(format, ast, outDir, templateOptions = {}) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new Error(`unknown export format: ${format}`);
  return exporter(ast, outDir, templateOptions);
}

module.exports = { EXPORTERS, runExport };
