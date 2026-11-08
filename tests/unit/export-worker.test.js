'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runExportInWorker } = require('../../app/export-runner');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { buildFixtureGuide } = require('./fixture-guide');
const { qualityFindings } = require('../../core/quality');
const { stepNumberMap } = require('../../core/step-outline');
const { normalizeProfile } = require('../../core/branding');
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

test('background quality checks and title expansion match the synchronous AST', async (t) => {
  const root = makeTmpDir('renderworker'); t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const globals = { Author: 'Morgan' }, reviewDays = 90;
  const ast = buildRenderAst(store, guide.guideId, { globals, reviewDays });
  const steps = store.listSteps(guide.guideId);
  const expected = qualityFindings(ast, stepNumberMap(store.getGuide(guide.guideId).stepsOrder.map(id => steps.get(id))));
  const args = { dataDir: store.root, guideId: guide.guideId, globals, reviewDays };
  assert.deepEqual(await runExportInWorker({ ...args, task: 'quality' }), expected);
  assert.equal(await runExportInWorker({ ...args, task: 'title' }), ast.guide.title);
});

test('background previews preserve step limits and full-guide placeholder counts', async (t) => {
  const root = makeTmpDir('previewworker'); t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const expected = runExport('json', buildRenderAst(store, guide.guideId, { maxSteps: 2 }), path.join(root, 'expected'));
  const result = await runExportInWorker({ dataDir: store.root, guideId: guide.guideId,
    format: 'json', maxSteps: 2, outDir: path.join(root, 'actual') });
  const actualJson = JSON.parse(fs.readFileSync(result.file));
  const expectedJson = JSON.parse(fs.readFileSync(expected.file));
  delete actualJson.generatedAt; delete expectedJson.generatedAt;
  assert.deepEqual(actualJson, expectedJson);
  assert.equal(actualJson.steps.length, 2);
});

test('background HTML previews apply the chosen brand with expanded header text', async t => {
  const root = makeTmpDir('previewbrand'); t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const branding = { profile: normalizeProfile({ name: 'Preview brand', header: { text: 'Company [[Product]]' }, colors: { primary: '#123456' } }) };
  const result = await runExportInWorker({ dataDir: store.root, guideId: guide.guideId,
    format: 'html-simple', maxSteps: 2, branding, outDir: path.join(root, 'out') });
  const html = fs.readFileSync(result.file, 'utf8');
  assert.match(html, /Company AcmeSync/);
  assert.match(html, /#123456/i);
});
