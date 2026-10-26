'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { diffWords, diffLines, diffTable, movedIds, mergedOrder, textOf, diffGuides } = require('../../core/guide-diff');
const { GuideStore } = require('../../core/store');
const { zipDirSync } = require('../../core/zip');
const { createSnapshot, compareSnapshot, snapshotFile, snapshotsDir } = require('../../core/snapshots');
const { createGuide, createStep } = require('../../core/schema');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

// A different valid 1x1 PNG (blue), so the screenshot's hash changes.
const BLUE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('word diff keeps both texts and joins neighbouring replacements', () => {
  const parts = diffWords('Click the red Save button now.', 'Click the blue Submit button.');
  assert.deepEqual(parts, [
    { op: 'eq', text: 'Click the ' },
    { op: 'del', text: 'red Save' },
    { op: 'add', text: 'blue Submit' },
    { op: 'eq', text: ' button' },
    { op: 'del', text: ' now' },
    { op: 'eq', text: '.' },
  ]);
  assert.deepEqual(diffWords('same', 'same'), [{ op: 'eq', text: 'same' }]);
  assert.deepEqual(diffWords('', 'new text'), [{ op: 'add', text: 'new text' }]);
  assert.deepEqual(diffWords('old text', ''), [{ op: 'del', text: 'old text' }]);
});

test('word diff always spells out the old and the new text', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ['open', 'the', 'menu', 'click', 'Save', ',', '.', 'don’t', 'it\'s', 'ünïcode', '42', '\n', '  '];
  const sentence = () => Array.from({ length: rand(30) }, () => words[rand(words.length)]).join(rand(2) ? ' ' : '');
  for (let i = 0; i < 300; i++) {
    const before = sentence();
    const after = rand(3) ? sentence() : `${before} extra`;
    const parts = diffWords(before, after);
    assert.equal(textOf(parts, 'del'), before);
    assert.equal(textOf(parts, 'add'), after);
  }
});

test('texts too different to diff come back as one removal and one addition', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(' ');
  const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(' ');
  const parts = diffWords(before, after);
  assert.equal(textOf(parts, 'del'), before);
  assert.equal(textOf(parts, 'add'), after);
});

test('line diff marks removed and added lines, with word highlights on replaced lines', () => {
  const lines = diffLines('npm install\nnpm run build\nnpm test', 'npm ci\nnpm run build\nnpm test\nnpm run lint');
  assert.deepEqual(lines.map((line) => [line.op, line.text]), [
    ['del', 'npm install'], ['add', 'npm ci'], ['eq', 'npm run build'], ['eq', 'npm test'], ['add', 'npm run lint'],
  ]);
  assert.deepEqual(lines[0].parts, [{ op: 'eq', text: 'npm ' }, { op: 'del', text: 'install' }]);
  assert.deepEqual(lines[1].parts, [{ op: 'eq', text: 'npm ' }, { op: 'add', text: 'ci' }]);
  assert.equal(lines[4].parts, undefined);
  const uneven = diffLines('tail --since 10m', 'tail --since 30m\ncache flush');
  assert.deepEqual(uneven.map((line) => [line.op, Boolean(line.parts)]), [['del', true], ['add', true], ['add', false]]);
  assert.deepEqual(uneven[1].parts.at(-1), { op: 'add', text: '30m' });
  assert.deepEqual(diffLines('', ''), []);
  assert.deepEqual(diffLines('a\r\nb', 'a\nb').map((line) => line.op), ['eq', 'eq']);
});

test('table diff pairs changed rows cell by cell, and flags a change of columns', () => {
  const table = diffTable([['Name', 'Port'], ['web', '80'], ['db', '5432']], [['Name', 'Port'], ['web', '443'], ['cache', '6379'], ['db', '5432']]);
  assert.equal(table.structure, false);
  assert.deepEqual(table.rows.map((row) => row.op), ['eq', 'change', 'add', 'eq']);
  assert.deepEqual(table.rows[1].cells[1], [{ op: 'del', text: '80' }, { op: 'add', text: '443' }]);
  assert.deepEqual(table.rows[1].cells[0], [{ op: 'eq', text: 'web' }]);

  const reshaped = diffTable([['a', 'b']], [['a', 'b', 'c']]);
  assert.equal(reshaped.structure, true);
  assert.deepEqual(reshaped.after, [['a', 'b', 'c']]);
  assert.deepEqual(diffTable([], [['x']]).rows.map((row) => row.op), ['add']);
});

test('moved ids are the ones out of the common order; removed ids keep their place', () => {
  assert.deepEqual([...movedIds(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd'])], ['b']);
  assert.deepEqual([...movedIds(['a', 'b', 'c'], ['x', 'a', 'b', 'c'])], []);
  assert.deepEqual([...movedIds(['a', 'b', 'c'], ['a', 'c'])], []);
  assert.deepEqual(mergedOrder(['x', 'a', 'y', 'b', 'z'], ['a', 'n', 'b']), ['x', 'a', 'y', 'n', 'b', 'z']);
});

function side(guideFields, steps, files = {}) {
  return {
    guide: { ...createGuide(guideFields), stepsOrder: steps.map((step) => step.stepId) },
    steps,
    fileSha: (name) => files[name] || null,
  };
}

test('guide diff reports added, deleted, changed, moved and unchanged steps in reading order', () => {
  const image = { originalPath: 'original.png', workingPath: 'original.png', size: { width: 10, height: 10 } };
  const before = side({ title: 'VPN', metadata: { author: 'Sam' }, placeholders: { Company: 'Acme' } }, [
    createStep({ stepId: 's1', title: 'Open settings', image }),
    createStep({ stepId: 's2', title: 'Old step', descriptionHtml: '<p>Remove me</p>' }),
    createStep({ stepId: 's3', title: 'Same', status: 'todo' }),
    createStep({ stepId: 's4', title: 'Moves', descriptionHtml: '<p>Hello <b>world</b></p>' }),
    createStep({ stepId: 's5', title: 'Last' }),
  ], { 'steps/s1/original.png': 'aaa' });
  const after = side({ title: 'VPN setup', metadata: { author: 'Sam' }, placeholders: { Company: 'Acme Inc', Team: 'IT' } }, [
    createStep({ stepId: 's4', title: 'Moves', descriptionHtml: '<p>Hello <i>world</i></p>' }),
    createStep({ stepId: 's1', title: 'Open the settings', image, annotations: [{ id: 'a1', type: 'arrow' }] }),
    createStep({ stepId: 's3', title: 'Same', status: 'done', revision: 9, captureMetadata: { app: 'x' } }),
    createStep({ stepId: 'new', title: 'Brand new', descriptionHtml: '<p>Fresh</p>' }),
    createStep({ stepId: 's5', title: 'Last' }),
  ], { 'steps/s1/original.png': 'aaa' });
  const diff = diffGuides(before, after);

  assert.deepEqual(diff.steps.map((step) => [step.stepId, step.status, step.moved]), [
    ['s4', 'changed', true],
    ['s1', 'changed', false],
    ['s2', 'deleted', false],
    ['s3', 'unchanged', false],
    ['new', 'added', false],
    ['s5', 'unchanged', false],
  ]);
  assert.deepEqual(diff.summary, { added: 1, deleted: 1, changed: 2, moved: 1, unchanged: 2 });
  assert.equal(diff.identical, false);

  const [moved, edited, deleted, , added] = diff.steps;
  assert.deepEqual(moved.number, { before: '4', after: '1' });
  assert.deepEqual(moved.changes, [{ type: 'formatting', label: 'Description' }]);
  assert.deepEqual(edited.changes.map((c) => c.type), ['text', 'image']);
  assert.deepEqual(edited.changes[0].parts, [{ op: 'eq', text: 'Open ' }, { op: 'add', text: 'the ' }, { op: 'eq', text: 'settings' }]);
  assert.deepEqual(edited.changes[1].reasons, ['annotations']);
  assert.equal(edited.changes[1].before.file, 'steps/s1/original.png');
  assert.equal(edited.changes[1].after.annotations[0].type, 'arrow');
  assert.equal(edited.changes[1].before.sha, undefined, 'hashes stay in the main process');
  assert.deepEqual(deleted.changes.map((c) => c.parts), [[{ op: 'del', text: 'Old step' }], [{ op: 'del', text: 'Remove me' }]]);
  assert.deepEqual(added.changes.map((c) => c.parts), [[{ op: 'add', text: 'Brand new' }], [{ op: 'add', text: 'Fresh' }]]);

  assert.deepEqual(diff.guide.map((c) => c.label), ['Guide title', 'Placeholder [[Company]]', 'Placeholder [[Team]]']);
  assert.deepEqual(diff.guide[2], { type: 'field', label: 'Placeholder [[Team]]', before: null, after: 'IT' });
});

test('step fields, screenshots and blocks are compared; identical guides say so', () => {
  const image = (file) => ({ originalPath: 'original.png', workingPath: file, size: { width: 4, height: 4 } });
  const before = side({}, [createStep({
    stepId: 's1', title: 'T', hidden: false, image: image('original.png'),
    textBlocks: [{ id: 'tb1', title: 'Note', descriptionHtml: '<p>Use VPN</p>', level: 'info', order: 1 }],
    codeBlocks: [{ id: 'cb1', language: 'bash', code: 'ls\npwd', order: 2 }, { id: 'cb2', code: 'gone', order: 3 }],
    tableBlocks: [{ id: 't1', rows: [['a']], order: 4 }],
  })], { 'steps/s1/original.png': 'old' });
  const after = side({}, [createStep({
    stepId: 's1', title: 'T', hidden: true, image: image('working.png'),
    textBlocks: [{ id: 'tb1', title: 'Note', descriptionHtml: '<p>Use the VPN</p>', level: 'warn', order: 1 }],
    codeBlocks: [{ id: 'cb1', language: 'bash', code: 'ls -la\npwd', order: 2 }],
    tableBlocks: [{ id: 't1', rows: [['a']], order: 0 }],
  })], { 'steps/s1/original.png': 'old', 'steps/s1/working.png': 'new' });
  const [step] = diffGuides(before, after).steps;
  const byLabel = Object.fromEntries(step.changes.map((c) => [c.label, c]));
  assert.deepEqual(byLabel.Hidden, { type: 'field', label: 'Hidden', before: 'No', after: 'Yes' });
  assert.deepEqual(byLabel.Screenshot.reasons, ['screenshot']);
  const blocks = step.changes.filter((c) => c.type === 'block');
  assert.deepEqual(blocks.map((b) => [b.id, b.status, b.moved]), [
    ['t1', 'unchanged', true], ['tb1', 'changed', false], ['cb1', 'changed', false], ['cb2', 'deleted', false],
  ]);
  const text = blocks[1];
  assert.deepEqual(text.level, { type: 'field', label: 'Style', before: 'Info', after: 'Warning' });
  assert.deepEqual(text.description.parts, [{ op: 'eq', text: 'Use ' }, { op: 'add', text: 'the ' }, { op: 'eq', text: 'VPN' }]);
  assert.deepEqual(blocks[2].lines.map((line) => line.op), ['del', 'add', 'eq']);
  assert.deepEqual(blocks[3].lines, [{ op: 'del', text: 'gone' }]);

  const copy = side({}, [createStep({ stepId: 's1', title: 'T' })]);
  const diff = diffGuides(copy, side({}, [createStep({ stepId: 's1', title: 'T' })]));
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.summary, { added: 0, deleted: 0, changed: 0, moved: 0, unchanged: 1 });
});

test('a substep moved under another parent counts as moved', () => {
  const before = side({}, [createStep({ stepId: 'a' }), createStep({ stepId: 'b' }), createStep({ stepId: 'c' })]);
  const after = side({}, [createStep({ stepId: 'a' }), createStep({ stepId: 'b' }), createStep({ stepId: 'c', parentStepId: 'b' })]);
  const diff = diffGuides(before, after);
  assert.deepEqual(diff.steps.map((s) => [s.stepId, s.moved, s.depth, s.number.after]), [['a', false, 0, '1'], ['b', false, 0, '2'], ['c', true, 1, '2.1']]);
});

function makeGuide(store) {
  const guide = store.createGuide({ title: 'Install VPN', descriptionHtml: '<p>Company VPN setup</p>' });
  const s1 = store.addStep(guide.guideId, { title: 'Download installer' }, TINY_PNG, { width: 1, height: 1 });
  const s2 = store.addStep(guide.guideId, { kind: 'content', title: 'Notes', descriptionHtml: '<p>VPN notes</p>' });
  return { guideId: guide.guideId, s1, s2 };
}

test('compareSnapshot compares a saved snapshot with the guide now, and serves both sides\' screenshots', (t) => {
  const dir = makeTmpDir('compare');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const { guideId, s1, s2 } = makeGuide(store);
  const name = createSnapshot(store, guideId, { label: 'manual' });

  assert.equal(compareSnapshot(store, guideId, name).identical, true);

  store.saveStep(guideId, { ...store.getStep(guideId, s1.stepId), title: 'Download the installer' });
  store.setWorkingImage(guideId, s1.stepId, BLUE_PNG, { width: 1, height: 1 });
  store.deleteStep(guideId, s2.stepId);
  const s3 = store.addStep(guideId, { kind: 'content', title: 'Connect' });

  const diff = compareSnapshot(store, guideId, name);
  assert.deepEqual(diff.steps.map((step) => [step.stepId, step.status]), [
    [s1.stepId, 'changed'], [s2.stepId, 'deleted'], [s3.stepId, 'added'],
  ]);
  const shot = diff.steps[0].changes.find((c) => c.type === 'image');
  assert.deepEqual(shot.reasons, ['screenshot']);
  assert.deepEqual(snapshotFile(store, guideId, name, shot.before.file), TINY_PNG);
  assert.deepEqual(fs.readFileSync(path.join(store.guideDir(guideId), shot.after.file)), BLUE_PNG);
  assert.equal(snapshotFile(store, guideId, name, 'steps/nope/original.png'), null);
  assert.throws(() => compareSnapshot(store, guideId, 'missing.snapshot'), /snapshot not found/);
});

test('old zip snapshots can be compared too', (t) => {
  const dir = makeTmpDir('compare-zip');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const { guideId, s1 } = makeGuide(store);
  const guideDir = store.guideDir(guideId);
  fs.mkdirSync(snapshotsDir(store, guideId), { recursive: true });
  const name = '2026-01-01T00-00-00-000Z-old.zip';
  fs.writeFileSync(path.join(snapshotsDir(store, guideId), name), zipDirSync(guideDir, { filter: (rel) => !rel.startsWith('history') }));

  store.saveStep(guideId, { ...store.getStep(guideId, s1.stepId), title: 'Renamed' });
  const diff = compareSnapshot(store, guideId, name);
  assert.equal(diff.summary.changed, 1);
  assert.deepEqual(snapshotFile(store, guideId, name, `steps/${s1.stepId}/original.png`), TINY_PNG);
});
