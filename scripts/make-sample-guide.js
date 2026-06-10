#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { GuideStore } = require('../core/store');
const raster = require('../core/raster');
const { encodePng } = require('../core/png');
const { buildRenderAst } = require('../core/renderast');
const { exportGuideArchive } = require('../core/archive');
const { runExport } = require('../exporters');
const { writeJsonSync, slugify } = require('../core/util');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.join(ROOT_DIR, 'examples');

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) out.root = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function drawChrome(img, { accent, title, subtitle, sidebarLabel, bodyLabel }) {
  const W = img.width;
  const H = img.height;
  raster.fillRect(img, 0, 0, W, H, [245, 247, 250, 255]);
  raster.fillRect(img, 0, 0, W, 68, accent);
  raster.fillRect(img, 28, 94, 270, H - 138, [255, 255, 255, 255]);
  raster.fillRect(img, 326, 94, W - 354, H - 138, [255, 255, 255, 255]);
  raster.fillRect(img, 48, 118, 212, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 48, 152, 212, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 48, 186, 212, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 362, 148, 220, 152, [230, 237, 245, 255]);
  raster.fillRect(img, 608, 148, 276, 40, [235, 241, 248, 255]);
  raster.fillRect(img, 608, 202, 276, 40, [235, 241, 248, 255]);
  raster.fillRect(img, 608, 256, 276, 40, [235, 241, 248, 255]);
  raster.drawText(img, 28, 20, title, 26, [255, 255, 255, 255]);
  raster.drawText(img, 28, 44, subtitle, 12, [214, 226, 240, 255]);
  raster.drawText(img, 48, 102, sidebarLabel, 12, [78, 90, 105, 255]);
  raster.drawText(img, 356, 102, bodyLabel, 12, [78, 90, 105, 255]);
}

function makeShotOne() {
  const img = raster.createImage(1280, 760, [245, 247, 250, 255]);
  drawChrome(img, {
    accent: [0, 104, 255, 255],
    title: 'Reset password',
    subtitle: 'Users > Security > Reset',
    sidebarLabel: 'Users',
    bodyLabel: 'Admin Portal',
  });
  raster.fillRect(img, 392, 156, 176, 36, [0, 104, 255, 255]);
  raster.drawTextCentered(img, 480, 175, 'Open Users', 16, [255, 255, 255, 255]);
  raster.fillRect(img, 644, 160, 160, 20, [255, 255, 255, 255]);
  raster.fillRect(img, 644, 196, 240, 20, [255, 255, 255, 255]);
  raster.fillRect(img, 644, 232, 220, 20, [255, 255, 255, 255]);
  raster.drawText(img, 360, 336, '1. Open the Users list and confirm the target account is visible.', 12, [48, 59, 71, 255]);
  raster.drawText(img, 360, 360, 'The highlight shows the next action target.', 12, [96, 108, 121, 255]);
  return img;
}

function makeShotTwo() {
  const img = raster.createImage(1280, 760, [245, 247, 250, 255]);
  drawChrome(img, {
    accent: [20, 115, 90, 255],
    title: 'Security settings',
    subtitle: '2-factor authentication and resets',
    sidebarLabel: 'Security',
    bodyLabel: 'Account settings',
  });
  raster.fillRect(img, 366, 160, 252, 56, [20, 115, 90, 255]);
  raster.drawTextCentered(img, 492, 180, 'Enable 2FA', 18, [255, 255, 255, 255]);
  raster.fillRect(img, 648, 160, 250, 22, [233, 238, 244, 255]);
  raster.fillRect(img, 648, 196, 250, 22, [233, 238, 244, 255]);
  raster.fillRect(img, 648, 232, 250, 22, [233, 238, 244, 255]);
  raster.drawText(img, 360, 336, '2. Enable the reset policy and save the change.', 12, [48, 59, 71, 255]);
  raster.drawText(img, 360, 360, 'The annotation number points at the primary action.', 12, [96, 108, 121, 255]);
  return img;
}

function makeShotThree() {
  const img = raster.createImage(1280, 760, [245, 247, 250, 255]);
  drawChrome(img, {
    accent: [36, 50, 78, 255],
    title: 'Confirmation',
    subtitle: 'Review before closing the workflow',
    sidebarLabel: 'Review',
    bodyLabel: 'Change summary',
  });
  raster.fillRect(img, 366, 150, 472, 210, [255, 255, 255, 255]);
  raster.fillRect(img, 396, 182, 120, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 396, 220, 316, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 396, 256, 356, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 396, 292, 270, 18, [232, 237, 243, 255]);
  raster.fillRect(img, 778, 298, 36, 36, [36, 50, 78, 255]);
  raster.drawText(img, 396, 406, '3. Confirm the summary, then close the dialog.', 12, [48, 59, 71, 255]);
  raster.drawText(img, 396, 430, 'A blur redacts the account number in the sample export.', 12, [96, 108, 121, 255]);
  return img;
}

function createGuide(store) {
  const guide = store.createGuide({
    title: 'Reset a password in Admin Portal',
    descriptionHtml: '<p>Offline sample guide showing capture, annotations, rich text, and exports.</p>',
    placeholders: {
      Product: 'Admin Portal',
      Author: 'StepForge',
      Department: 'Support',
    },
    flags: {
      focusedViewDefault: true,
      hideSkippedStepsInExports: true,
    },
  });

  const steps = [
    {
      title: 'Open [[Product]] users',
      descriptionHtml: '<p>Open the users list and select the target account.</p>',
      annotations: [
        { type: 'rect', x: 0.275, y: 0.18, w: 0.19, h: 0.18, style: { stroke: '#0068ff', strokeWidth: 6, fill: 'transparent' } },
        { type: 'number', value: 1, x: 0.30, y: 0.08, w: 0.08, h: 0.12, style: { stroke: '#0068ff' } },
      ],
      textBlocks: [
        { position: 'after-description', level: 'info', title: 'Tip', descriptionHtml: '<p>Use the search box to avoid scrolling.</p>' },
      ],
      image: makeShotOne(),
    },
    {
      title: 'Enable the reset policy',
      descriptionHtml: '<p>Make sure the policy is active before continuing.</p>',
      annotations: [
        { type: 'arrow', x: 0.47, y: 0.24, w: 0.23, h: -0.04, style: { stroke: '#14a375', strokeWidth: 5 } },
        { type: 'tooltip', x: 0.53, y: 0.13, w: 0.17, h: 0.08, text: 'Primary action', style: { fill: '#111827', textColor: '#ffffff', stroke: '#111827', tail: 'bottom' } },
        { type: 'number', value: 2, x: 0.31, y: 0.08, w: 0.08, h: 0.12, style: { stroke: '#14a375' } },
      ],
      codeBlocks: [
        { id: 'cmd', language: 'bash', code: 'stepforge --capture --window --delay 300' },
      ],
      image: makeShotTwo(),
    },
    {
      title: 'Review the confirmation',
      descriptionHtml: '<p>Confirm the summary and close the modal.</p>',
      annotations: [
        { type: 'blur', x: 0.49, y: 0.32, w: 0.21, h: 0.08, radius: 12, style: { stroke: '#9ca3af', strokeWidth: 2 } },
        { type: 'highlight', x: 0.47, y: 0.24, w: 0.28, h: 0.20, style: { fill: '#ffeeb0', stroke: '#f0a500', strokeWidth: 2 } },
        { type: 'number', value: 3, x: 0.31, y: 0.08, w: 0.08, h: 0.12, style: { stroke: '#36a' } },
      ],
      tableBlocks: [
        { id: 't1', rows: [['Field', 'Value'], ['Title', 'Admin Portal'], ['Owner', 'Support']] },
      ],
      image: makeShotThree(),
    },
  ];

  steps.forEach((entry, index) => {
    const buf = encodePng(entry.image);
    store.addStep(guide.guideId, {
      title: entry.title,
      descriptionHtml: entry.descriptionHtml,
      annotations: entry.annotations,
      textBlocks: entry.textBlocks || [],
      codeBlocks: entry.codeBlocks || [],
      tableBlocks: entry.tableBlocks || [],
      focusedView: { enabled: true, zoom: 1.1, panX: 0.5, panY: 0.5 },
    }, buf, { width: entry.image.width, height: entry.image.height }, { position: index });
  });

  const substep = store.addStep(guide.guideId, {
    kind: 'empty',
    parentStepId: store.getGuide(guide.guideId).stepsOrder[1],
    title: 'Confirm permission prompt',
    descriptionHtml: '<p>Only administrators can complete this step.</p>',
    textBlocks: [{ position: 'after-description', level: 'warn', title: 'Access', descriptionHtml: '<p>Admin rights required.</p>' }],
  }, null, null, { position: 2 });

  store.addStep(guide.guideId, {
    kind: 'empty',
    title: 'Legacy note',
    hidden: true,
    descriptionHtml: '<p>This hidden step exercises filtering in exports.</p>',
  }, null, null, { position: 4 });

  store.addStep(guide.guideId, {
    kind: 'empty',
    title: 'Deprecated flow',
    skipped: true,
    descriptionHtml: '<p>This skipped step remains in the library but is excluded from exports.</p>',
  }, null, null, { position: 5 });

  return { guideId: guide.guideId, substepId: substep.stepId };
}

function exportOutputs(store, guideId, root, manifest) {
  const ast = buildRenderAst(store, guideId);
  const formats = ['json', 'markdown', 'html-simple', 'html-rich', 'pdf', 'gif', 'image-bundle', 'docx', 'pptx'];
  const outputs = {};
  for (const format of formats) {
    const outDir = path.join(root, 'sample-exports', format);
    fs.mkdirSync(outDir, { recursive: true });
    const result = runExport(format, ast, outDir, {});
    outputs[format] = path.relative(root, result.file || outDir);
  }
  const archiveFile = path.join(root, 'sample-guide.sfgz');
  exportGuideArchive(store, guideId, archiveFile);
  manifest.archive = path.relative(root, archiveFile);
  manifest.exports = outputs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/make-sample-guide.js [--root <dir>]');
    process.exit(0);
  }

  const root = args.root;
  const dataDir = path.join(root, 'sample-data');
  const exportsDir = path.join(root, 'sample-exports');
  cleanDir(root);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });

  const store = new GuideStore(dataDir);
  const { guideId, substepId } = createGuide(store);
  const manifest = {
    format: 'stepforge-sample-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    guideId,
    title: store.getGuide(guideId).title,
    dataDir: path.relative(root, dataDir),
    note: 'The sample guide is generated entirely offline from local assets.',
  };
  exportOutputs(store, guideId, root, manifest);
  manifest.substepId = substepId;
  manifest.slug = slugify(manifest.title);
  writeJsonSync(path.join(root, 'sample-manifest.json'), manifest);
  console.log(`Sample guide written to ${root}`);
}

if (require.main === module) main();
