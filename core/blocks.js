'use strict';

const BLOCK_KIND_ORDER = { text: 0, code: 1, table: 2 };

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  for (const key of ['code', 'text', 'body', 'value', 'content']) {
    const value = block[key];
    if (value != null && value !== '') return String(value);
  }
  return '';
}

function orderedBlocks(step) {
  const blocks = [];
  for (const tb of step.textBlocks || []) {
    blocks.push({ kind: 'text', ...tb });
  }
  for (const cb of step.codeBlocks || []) {
    blocks.push({ kind: 'code', ...cb, code: blockText(cb) });
  }
  for (const tbl of step.tableBlocks || []) {
    blocks.push({ kind: 'table', ...tbl });
  }
  return blocks.sort((a, b) => (
    (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0)
    || (BLOCK_KIND_ORDER[a.kind] - BLOCK_KIND_ORDER[b.kind])
    || String(a.id || '').localeCompare(String(b.id || ''))
  ));
}

function nextBlockOrder(step) {
  return orderedBlocks(step).reduce((max, block) => Math.max(max, Number.isFinite(block.order) ? block.order : 0), 0) + 1;
}

module.exports = {
  BLOCK_KIND_ORDER,
  blockText,
  orderedBlocks,
  nextBlockOrder,
};
