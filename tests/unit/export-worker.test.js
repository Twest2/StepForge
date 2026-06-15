'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runExportInWorker } = require('../../app/export-runner');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

test('export helper process produces the same result as an in-process export', async (t) => {
  const root = makeTmpDir('exportworker');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));

  const expected = runExport('json', buildRenderAst(store, guide.guideId), path.join(root, 'inproc'));

  const result = await runExportInWorker({
    dataDir: store.root,
    guideId: guide.guideId,
    format: 'json',
    options: {},
    outDir: path.join(root, 'worker'),
    globals: {},
  });

  assert.equal(result.imageCount, expected.imageCount);
  assert.ok(fs.existsSync(result.file));
  const fromWorker = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  const fromInProcess = JSON.parse(fs.readFileSync(expected.file, 'utf8'));
  // Each build stamps its own generatedAt; everything else must match exactly.
  delete fromWorker.generatedAt;
  delete fromInProcess.generatedAt;
  assert.deepEqual(fromWorker, fromInProcess);
});

test('export helper process rejects on an unknown format', async (t) => {
  const root = makeTmpDir('exportworkerbadfmt');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));

  await assert.rejects(
    runExportInWorker({
      dataDir: store.root,
      guideId: guide.guideId,
      format: 'exe',
      options: {},
      outDir: path.join(root, 'out'),
      globals: {},
    }),
    /unknown export format/,
  );
});

test('export helper process rejects on an unknown guide id', async (t) => {
  const root = makeTmpDir('exportworkerbadguide');
  t.after(() => rmrf(root));
  const { store } = buildFixtureGuide(path.join(root, 'data'));

  await assert.rejects(
    runExportInWorker({
      dataDir: store.root,
      guideId: 'guide_does_not_exist',
      format: 'json',
      options: {},
      outDir: path.join(root, 'out'),
      globals: {},
    }),
  );
});
