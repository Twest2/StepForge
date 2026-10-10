'use strict';

/**
 * The step outline: which steps are substeps of which. Order never changes
 * here. A valid outline reads top to bottom like a numbered list: each step's
 * parent is the step right above it or one of that step's parents, so
 * numbering (1, 1.1, 1.1.1, 2 …) always follows the order on screen.
 */

/** True when every step's parent sits on the chain of the step right above it. */
function isValidOutline(order, parentOf) {
  for (let i = 0; i < order.length; i++) {
    const parent = parentOf.get(order[i]) || null;
    if (!parent) continue;
    let candidate = i > 0 ? order[i - 1] : null;
    while (candidate && candidate !== parent) candidate = parentOf.get(candidate) || null;
    if (!candidate) return false;
  }
  return true;
}

/**
 * Set step `stepId`'s parent (or null for top level) if the outline stays
 * valid. Returns the new parent map, or null when the change would break it.
 */
function withParent(order, parentOf, stepId, parentId) {
  if (!order.includes(stepId) || (parentId && (!order.includes(parentId) || parentId === stepId))) return null;
  const next = new Map(parentOf);
  next.set(stepId, parentId || null);
  return isValidOutline(order, next) ? next : null;
}

/** Parent map for steps in guide order: stepId -> parentStepId | null. */
function parentMap(steps) {
  return new Map(steps.map((step) => [step.stepId, step.parentStepId || null]));
}

function depthOf(parentOf, stepId) {
  let depth = 0;
  for (let p = parentOf.get(stepId); p; p = parentOf.get(p)) depth += 1;
  return depth;
}

/**
 * Apply AI-suggested substeps ({ stepId, parentId }) in guide order. Only a
 * step at the top level is nested, only under a parent less than `maxDepth`
 * deep, and only when the outline stays valid; anything else is skipped.
 * Returns the steps whose parent changed.
 */
function planSubsteps(order, parentOf, suggestions, { maxDepth = Infinity } = {}) {
  let current = new Map(parentOf);
  const changed = new Map();
  const position = new Map(order.map((id, i) => [id, i]));
  const sorted = [...suggestions]
    .filter((s) => position.has(s.stepId) && position.has(s.parentId))
    .sort((a, b) => position.get(a.stepId) - position.get(b.stepId));
  for (const { stepId, parentId } of sorted) {
    if (current.get(stepId) || position.get(parentId) >= position.get(stepId)) continue;
    if (depthOf(current, parentId) >= maxDepth) continue;
    const next = withParent(order, current, stepId, parentId);
    if (!next) continue;
    current = next;
    changed.set(stepId, parentId);
  }
  return changed;
}

module.exports = { isValidOutline, withParent, parentMap, planSubsteps, depthOf };
