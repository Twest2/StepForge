'use strict';

const { GuideStore } = require('./store');
const { buildRenderAst } = require('./renderast');
const { runExport } = require('../exporters');
const { prepareExportImages } = require('./image-format');
const { qualityFindings } = require('./quality');
const { stepNumberMap } = require('./step-outline');

/**
 * Entry point for the export helper process (forked via
 * app/export-runner.js). Runs one export job — building the render AST and
 * invoking the exporter — off the main process so a large guide's PDF/DOCX/
 * etc. rendering never blocks the UI.
 */

process.on('message', async (job) => {
  let payload;
  try {
    const { dataDir, guideId, format, options, outDir, globals, maxSteps, codeStyle, reviewDays, branding, language, task = 'export' } = job;
    if (!['export', 'quality', 'title'].includes(task)) throw new Error('Unknown render task.');
    const store = new GuideStore(dataDir);
    // Decode stored screenshots in the worker through the shared codec.
    const images = task === 'export' ? await prepareExportImages(store, guideId, { maxSteps }) : null;
    const ast = buildRenderAst(store, guideId, { globals, maxSteps, codeStyle, reviewDays, branding, images, language });
    let result;
    if (task === 'quality') {
      const steps = store.listSteps(guideId);
      result = qualityFindings(ast, stepNumberMap(store.getGuide(guideId).stepsOrder.map(id => steps.get(id)).filter(Boolean)));
    } else if (task === 'title') result = ast.guide.title;
    else result = runExport(format, ast, outDir, options || {});
    payload = { ok: true, result };
  } catch (err) {
    payload = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  process.send(payload, () => process.exit(payload.ok ? 0 : 1));
});
