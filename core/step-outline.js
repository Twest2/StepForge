'use strict';

/**
 * The step outline: which steps are substeps of which. Order never changes
 * here. A valid outline reads top to bottom like a numbered list: each step's
 * parent is the step right above it or one of that step's parents, so
 * numbering (1, 1.1, 1.1.1, 2 …) always follows the order on screen.
 */

(function attachStepOutline(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // The editor (a sandboxed renderer without require) loads this file with a script tag.
  if (root) {
    root.StepForgeOutline = api;
  }
})(typeof window !== 'undefined' ? window : null, () => {
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

  /**
   * A copy of `parentOf` where every step whose parent is not on the chain of
   * the step above it (or is not in `order` at all) is moved to the top level.
   * Fixes a guide whose outline was broken by an old move; a valid outline
   * comes back unchanged.
   */
  function repairOutline(order, parentOf) {
    const next = new Map(parentOf);
    for (let i = 0; i < order.length; i++) {
      const parent = next.get(order[i]) || null;
      if (!parent) { next.set(order[i], null); continue; }
      let candidate = i > 0 ? order[i - 1] : null;
      while (candidate && candidate !== parent) candidate = next.get(candidate) || null;
      if (!candidate) next.set(order[i], null);
    }
    return next;
  }

  /** `stepId` followed by its descendants, in `order`. A subtree is contiguous in a valid outline. */
  function subtreeOf(order, parentOf, stepId) {
    const members = new Set([stepId]);
    for (const id of order) {
      if (members.has(parentOf.get(id))) members.add(id);
    }
    return order.filter((id) => members.has(id));
  }

  /**
   * Move `stepId` and all its substeps, as one block, to the gap before
   * `order[gapIndex]` (0 = the very top, order.length = the very end; the
   * gap is counted in the order as it is now). The block's own nesting is
   * kept; only the moved step's parent changes, to one that leaves the whole
   * outline valid. Of the parents the new position allows (the step above the
   * gap, its parents, or none), the one whose depth is closest to `depthHint`
   * wins (default: the step's current depth), preferring its current parent,
   * then the shallower. A guide that is already broken is repaired first.
   *
   * Returns { order, parentOf } (parentOf covers every step), or null when
   * the gap is inside the moved block (or the step or gap is unknown).
   */
  function moveSubtree(order, parentOf, stepId, gapIndex, depthHint = null) {
    const index = order.indexOf(stepId);
    if (index < 0 || !Number.isInteger(gapIndex) || gapIndex < 0 || gapIndex > order.length) return null;
    const base = repairOutline(order, parentOf);
    const block = subtreeOf(order, base, stepId);
    const blockSet = new Set(block);
    const lastIndex = Math.max(...block.map((id) => order.indexOf(id)));
    if (gapIndex > index && gapIndex <= lastIndex) return null;

    const insertAt = gapIndex - order.slice(0, gapIndex).filter((id) => blockSet.has(id)).length;
    const rest = order.filter((id) => !blockSet.has(id));
    const moved = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];

    const oldParent = base.get(stepId) || null;
    const target = Number.isFinite(depthHint) ? depthHint : depthOf(base, stepId);
    const above = insertAt > 0 ? rest[insertAt - 1] : null;
    const candidates = [null];
    for (let p = above; p; p = base.get(p) || null) candidates.push(p);

    let best = null;
    for (const parentId of candidates) {
      const next = new Map(base);
      next.set(stepId, parentId);
      if (!isValidOutline(moved, next)) continue;
      const depth = parentId ? depthOf(base, parentId) + 1 : 0;
      // Closest depth first, then the current parent, then the shallower: packed so a smaller number wins.
      const score = Math.abs(depth - target) * 1e6 + (parentId === oldParent ? 0 : 1e3) + depth;
      if (!best || score < best.score) best = { order: moved, parentOf: next, score };
    }
    return best && { order: best.order, parentOf: best.parentOf };
  }

  /**
   * Move `stepId` (with its substeps) past the neighbouring step's whole
   * subtree: up (delta -1) or down (+1). The step keeps its depth where it
   * can. Returns what moveSubtree returns, or null at the top or bottom.
   */
  function moveSubtreeBy(order, parentOf, stepId, delta) {
    const base = repairOutline(order, parentOf);
    const index = order.indexOf(stepId);
    if (index < 0) return null;
    const block = subtreeOf(order, base, stepId);
    const depth = depthOf(base, stepId);
    let gap;
    if (delta < 0) {
      if (index === 0) return null;
      // Walk up from the step above to the start of the sibling subtree (or the parent) it belongs to.
      const parent = base.get(stepId) || null;
      let cur = order[index - 1];
      while (cur && cur !== parent && (base.get(cur) || null) !== parent) cur = base.get(cur) || null;
      gap = order.indexOf(cur);
    } else {
      const end = index + block.length;
      if (end >= order.length) return null;
      const nextDepth = depthOf(base, order[end]);
      gap = end + 1;
      while (gap < order.length && depthOf(base, order[gap]) > nextDepth) gap += 1;
    }
    return moveSubtree(order, parentOf, stepId, gap, depth);
  }

  return { isValidOutline, withParent, parentMap, planSubsteps, depthOf, repairOutline, subtreeOf, moveSubtree, moveSubtreeBy };
});
