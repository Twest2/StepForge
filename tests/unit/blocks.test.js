'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeStep } = require('../../core/schema');
const { orderedBlocks, blockText } = require('../../core/blocks');

test('block normalization recovers legacy code fields and preserves order', () => {
  const step = normalizeStep({
    stepId: 'step-1',
    kind: 'content',
    title: 'Block test',
    textBlocks: [{ id: 'tb1', order: 2, position: 'after-description', level: 'info', title: 'Note', descriptionHtml: '<p>Text</p>' }],
    codeBlocks: [{ id: 'cb1', order: 1, language: 'bash', text: 'echo hi' }],
    tableBlocks: [{ id: 'tbl1', order: 3, rows: [['A', 'B'], ['1', '2']] }],
  });

  assert.equal(step.codeBlocks[0].code, 'echo hi');
  assert.equal(blockText(step.codeBlocks[0]), 'echo hi');
  assert.deepEqual(orderedBlocks(step).map((block) => block.kind), ['code', 'text', 'table']);
});
