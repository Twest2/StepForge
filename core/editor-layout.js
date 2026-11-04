'use strict';

(function attach(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepForgePaneLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_WIDTHS = Object.freeze({ steps: 320, properties: 330 });
  const MIN_WIDTHS = Object.freeze({ steps: 220, properties: 280 });
  const DIVIDER_WIDTH = 6;
  const MIN_CANVAS_WIDTH = 64;
  const MIN_EDITOR_WIDTH = MIN_WIDTHS.steps + MIN_WIDTHS.properties + 2 * DIVIDER_WIDTH + MIN_CANVAS_WIDTH;

  function normalizeWidths(value) {
    return Object.fromEntries(Object.keys(DEFAULT_WIDTHS).map(side => [side,
      Number.isFinite(value?.[side]) ? Math.min(10000, Math.max(MIN_WIDTHS[side], Math.round(value[side]))) : DEFAULT_WIDTHS[side],
    ]));
  }

  // Side panes never grow with the window. Only a shortage constrains their
  // preferred widths; enlarging the window restores at most those preferences.
  function layoutPanes(width, preferred) {
    const available = Math.max(MIN_EDITOR_WIDTH, Math.round(Number(width) || 0));
    const panes = normalizeWidths(preferred);
    const budget = available - 2 * DIVIDER_WIDTH - MIN_CANVAS_WIDTH;
    if (panes.steps + panes.properties > budget) {
      const extra = budget - MIN_WIDTHS.steps - MIN_WIDTHS.properties;
      const desiredSteps = panes.steps - MIN_WIDTHS.steps;
      const desiredProperties = panes.properties - MIN_WIDTHS.properties;
      panes.steps = MIN_WIDTHS.steps + Math.floor(extra * desiredSteps / (desiredSteps + desiredProperties || 1));
      panes.properties = MIN_WIDTHS.properties + extra - (panes.steps - MIN_WIDTHS.steps);
    }
    return { ...panes, canvas: available - panes.steps - panes.properties - 2 * DIVIDER_WIDTH };
  }

  function paneBounds(side, width, otherWidth) {
    return { min: MIN_WIDTHS[side], max: Math.max(MIN_WIDTHS[side],
      Math.floor(width - otherWidth - 2 * DIVIDER_WIDTH - MIN_CANVAS_WIDTH)) };
  }

  function clampPaneWidth(side, requested, width, otherWidth) {
    const { min, max } = paneBounds(side, width, otherWidth);
    return Math.max(min, Math.min(max, Math.round(requested)));
  }

  return { DEFAULT_WIDTHS, MIN_WIDTHS, DIVIDER_WIDTH, MIN_CANVAS_WIDTH, MIN_EDITOR_WIDTH,
    normalizeWidths, layoutPanes, paneBounds, clampPaneWidth };
});
