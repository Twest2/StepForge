'use strict';

// Reproducible, local-only profile: node scripts/profile-render-ast.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { GuideStore } = require('../core/store');
const { buildRenderAst } = require('../core/renderast');
const { encodePng } = require('../core/png');
const { createImage } = require('../core/raster');
const { runExportInWorker } = require('../app/export-runner');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-render-profile-'));
  try {
    const store = new GuideStore(root);
    const guide = store.createGuide({ title: 'Configure [[Product]]', placeholders: { Product: 'Example' } });
    const png = encodePng(createImage(1280, 720, [40, 60, 200, 255]));
    const results = [];
    for (const count of [100, 250, 500]) {
      while (store.getGuide(guide.guideId).stepsOrder.length < count) {
        store.addStep(guide.guideId, {
          title: 'Configure [[Product]] settings',
          descriptionHtml: '<p>Open <b>Settings</b> for [[Product]], then save the configuration.</p>'.repeat(8),
          textBlocks: [{ id: 'text', title: 'Check access', descriptionHtml: '<p>Use an administrator account.</p>' }],
          codeBlocks: [{ id: 'code', language: 'sh', code: 'example --configure' }],
          tableBlocks: [{ id: 'table', rows: [['Setting', 'Value'], ['Product', '[[Product]]']] }],
          annotations: [{ id: 'mark', type: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.5 }],
        }, png, { width: 1280, height: 720 });
      }
      buildRenderAst(store, guide.guideId); // warm caches
      for (const maxSteps of [0, 3]) {
        const samples = [], stalls = [];
        for (let run = 0; run < 15; run++) {
          const began = performance.now();
          const heartbeat = new Promise(resolve => setTimeout(() => resolve(performance.now() - began), 0));
          const ast = buildRenderAst(store, guide.guideId, { maxSteps });
          samples.push(performance.now() - began);
          stalls.push(await heartbeat);
          if (ast.steps.length !== (maxSteps || count)) throw new Error('Incorrect AST step count');
        }
        samples.sort((a, b) => a - b);
        results.push({ steps: count, maxSteps, medianMs: +samples[7].toFixed(2), p95Ms: +samples[14].toFixed(2),
          maxHeartbeatDelayMs: +Math.max(...stalls).toFixed(2) });
      }
      const workerTimes = [], heartbeatDelays = [];
      for (let run = 0; run < 5; run++) {
        let lastBeat = performance.now();
        const heartbeat = setInterval(() => {
          const now = performance.now(); heartbeatDelays.push(Math.max(0, now - lastBeat - 5)); lastBeat = now;
        }, 5);
        const began = performance.now();
        try { await runExportInWorker({ dataDir: store.root, guideId: guide.guideId, task: 'quality' }); }
        finally { clearInterval(heartbeat); }
        workerTimes.push(performance.now() - began);
      }
      workerTimes.sort((a, b) => a - b);
      results.push({ steps: count, task: 'quality-worker', medianTotalMs: +workerTimes[2].toFixed(2),
        maxHeartbeatDelayMs: +Math.max(...heartbeatDelays).toFixed(2), runs: 5 });
    }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: os.cpus()[0].model,
      runs: 15, thresholdMs: 50, results }, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
