'use strict';

function anchorFor(stepOrNumber) {
  const number = typeof stepOrNumber === 'string'
    ? stepOrNumber
    : stepOrNumber && stepOrNumber.number;
  return `step-${String(number || '').replace(/\./g, '-')}`;
}

function tocEntries(ast, { maxDepth = Infinity } = {}) {
  return (ast.steps || []).map((step) => ({
    step,
    anchor: anchorFor(step),
    number: step.number,
    title: step.title || 'Untitled step',
    depth: Math.min(Number.isFinite(step.depth) ? step.depth : 0, maxDepth),
  }));
}

function guideMetaLines(ast) {
  const meta = ast?.guide?.metadata || {};
  return [
    meta.author && `Author: ${meta.author}`,
    meta.coAuthors && `Co-authors: ${meta.coAuthors}`,
    meta.organization && `Organization: ${meta.organization}`,
  ].filter(Boolean);
}

function guideSummary(ast) {
  const count = ast?.steps?.length || 0;
  const generated = String(ast?.generatedAt || '').slice(0, 10);
  return `${count} step${count === 1 ? '' : 's'} · generated ${generated}`;
}

module.exports = {
  anchorFor,
  tocEntries,
  guideMetaLines,
  guideSummary,
};
