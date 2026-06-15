'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

const WORKER_PATH = path.join(__dirname, '..', 'core', 'export-worker.js');

/**
 * Run an export job in a forked helper process, so building the render AST
 * and rendering the output (e.g. a multi-step PDF) never blocks the main
 * process — and therefore never freezes the editor window — no matter how
 * large the guide is.
 */
function runExportInWorker({ dataDir, guideId, format, options, outDir, globals, maxSteps }) {
  return new Promise((resolve, reject) => {
    const worker = fork(WORKER_PATH, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      worker.kill();
      fn(value);
    };

    worker.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error((msg && msg.error) || 'Export worker failed.'));
    });
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => {
      finish(reject, new Error(`Export worker exited unexpectedly (code ${code}).`));
    });

    worker.send({ dataDir, guideId, format, options, outDir, globals, maxSteps });
  });
}

module.exports = { runExportInWorker };
