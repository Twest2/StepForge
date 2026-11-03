'use strict';

const { GuideStore } = require('./store');
const { buildRenderAst } = require('./renderast');
const { runExport } = require('../exporters');

/**
 * Entry point for the export helper process (forked via
 * app/export-runner.js). Runs one export job — building the render AST and
 * invoking the exporter — off the main process so a large guide's PDF/DOCX/
 * etc. rendering never blocks the UI.
 */

process.on('message', (job) => {
  let payload;
  try {
    const { dataDir, guideId, format, options, outDir, globals, maxSteps, codeStyle, reviewDays, branding, preparedImages } = job;
    const store = new GuideStore(dataDir);
    // WebP screenshots arrive already decoded to PNG by the main process,
    // which has the Chromium codec; this helper process has none.
    const images = new Map((preparedImages || []).map(([file, base64]) => [file, Buffer.from(base64, 'base64')]));
    const ast = buildRenderAst(store, guideId, { globals, maxSteps, codeStyle, reviewDays, branding, images });
    const result = runExport(format, ast, outDir, options || {});
    payload = { ok: true, result };
  } catch (err) {
    payload = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  process.send(payload, () => process.exit(payload.ok ? 0 : 1));
});
