'use strict';

const { exportText } = require('../core/export-text');

function anchorFor(stepOrNumber) {
  const number = typeof stepOrNumber === 'string'
    ? stepOrNumber
    : stepOrNumber && stepOrNumber.number;
  return `step-${String(number || '').replace(/\./g, '-')}`;
}

function tocEntries(ast, { maxDepth = Infinity } = {}) {
  const { t } = exportText(ast);
  return (ast.steps || []).map((step) => ({
    step,
    anchor: anchorFor(step),
    number: step.number,
    title: step.title || t('Untitled step'),
    depth: Math.min(Number.isFinite(step.depth) ? step.depth : 0, maxDepth),
  }));
}

/**
 * The guide's details for a cover or header, in the export's language:
 * [{ value, line }] where `line` is "Last verified: 2026-11-09" and `value`
 * just "2026-11-09". Dates stay YYYY-MM-DD in every language.
 */
function guideMetaItems(ast) {
  const { t } = exportText(ast);
  const meta = ast?.guide?.metadata || {};
  return [
    meta.author && { value: meta.author, line: t('Author: {name}', { name: meta.author }) },
    meta.coAuthors && { value: meta.coAuthors, line: t('Co-authors: {names}', { names: meta.coAuthors }) },
    meta.organization && { value: meta.organization, line: t('Organization: {name}', { name: meta.organization }) },
    meta.guideVersion && { value: meta.guideVersion, line: t('Guide version: {version}', { version: meta.guideVersion }) },
    meta.softwareVersion && { value: meta.softwareVersion, line: t('Software version: {version}', { version: meta.softwareVersion }) },
    meta.lastVerified && { value: meta.lastVerified, line: t('Last verified: {date}', { date: meta.lastVerified }) },
    meta.reviewAgainOn && { value: meta.reviewAgainOn, line: t('Review again on: {date}', { date: meta.reviewAgainOn }) },
  ].filter(Boolean);
}

function guideMetaLines(ast) {
  return guideMetaItems(ast).map((item) => item.line);
}

/** "3 steps", in the export's language. */
function stepCount(ast, count = ast?.steps?.length || 0) {
  const { tn } = exportText(ast);
  return tn(count, '{count} step', '{count} steps');
}

function guideSummary(ast) {
  const count = ast?.steps?.length || 0;
  const date = String(ast?.generatedAt || '').slice(0, 10);
  const { tn } = exportText(ast);
  return tn(count, '{count} step · generated {date}', '{count} steps · generated {date}', { date });
}

module.exports = {
  anchorFor,
  tocEntries,
  guideMetaItems,
  guideMetaLines,
  stepCount,
  guideSummary,
};
