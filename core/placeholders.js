'use strict';

const { htmlToText } = require('./util');

/**
 * Placeholders are [[Name]] tokens usable in titles, descriptions, text
 * blocks, and export cover pages. Resolution precedence (highest wins):
 * guide placeholders > global placeholders > system placeholders.
 * Unknown tokens are left untouched so typos are visible in output.
 */

const TOKEN_RE = /\[\[([A-Za-z0-9_ .-]+)\]\]/g;

function systemPlaceholders(guide, { now = new Date(), stepCount = null } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return {
    Guide_Title: guide ? guide.title : '',
    Guide_Description: guide ? htmlToText(guide.descriptionHtml) : '',
    Date: date,
    Time: time,
    DateTime: `${date} ${time}`,
    Year: String(now.getFullYear()),
    Step_Count: stepCount == null ? '' : String(stepCount),
    App_Name: 'StepForge',
  };
}

/** Build the effective name->value map for a guide. */
function resolveScopes({ guide = null, globals = {}, system = {} } = {}) {
  return { ...system, ...globals, ...(guide && guide.placeholders ? guide.placeholders : {}) };
}

function expandPlaceholders(text, values) {
  if (!text) return text == null ? '' : text;
  return String(text).replace(TOKEN_RE, (whole, name) => {
    const key = name.trim();
    return Object.prototype.hasOwnProperty.call(values, key) && values[key] != null
      ? String(values[key])
      : whole;
  });
}

/** List distinct placeholder names used in a string. */
function listPlaceholders(text) {
  const names = new Set();
  if (text) {
    for (const m of String(text).matchAll(TOKEN_RE)) names.add(m[1].trim());
  }
  return [...names];
}

/** Collect every placeholder name used anywhere in a guide + its steps. */
function collectGuidePlaceholders(guide, steps) {
  const names = new Set();
  const add = (text) => listPlaceholders(text).forEach((n) => names.add(n));
  add(guide.title);
  add(guide.descriptionHtml);
  for (const step of steps) {
    add(step.title);
    add(step.descriptionHtml);
    for (const tb of step.textBlocks || []) {
      add(tb.title);
      add(tb.descriptionHtml);
    }
    for (const ann of step.annotations || []) add(ann.text);
  }
  return [...names].sort();
}

module.exports = {
  TOKEN_RE,
  systemPlaceholders,
  resolveScopes,
  expandPlaceholders,
  listPlaceholders,
  collectGuidePlaceholders,
};
