'use strict';

(function attach(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepForgePaneLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_WIDTHS = Object.freeze({ steps: 320, properties: 330 });
  const MIN_WIDTHS = Object.freeze({ steps: 220, properties: 280 });
  const DIVIDER_WIDTH = 6;
  const MIN_CANVAS_WIDTH = 320;
  const MIN_EDITOR_WIDTH = MIN_WIDTHS.steps + MIN_WIDTHS.properties + 2 * DIVIDER_WIDTH + MIN_CANVAS_WIDTH;

  // `mins` lets the editor raise a pane's minimum, e.g. so the steps pane's
  // button row never wraps in a language with longer labels.
  function normalizeWidths(value, mins = MIN_WIDTHS) {
    return Object.fromEntries(Object.keys(DEFAULT_WIDTHS).map(side => [side,
      Number.isFinite(value?.[side]) ? Math.min(10000, Math.max(mins[side], Math.round(value[side]))) : Math.max(mins[side], DEFAULT_WIDTHS[side]),
    ]));
  }

  // Side panes never grow with the window. Only a shortage constrains their
  // preferred widths; enlarging the window restores at most those preferences.
  function layoutPanes(width, preferred, mins = MIN_WIDTHS) {
    const available = Math.max(mins.steps + mins.properties + 2 * DIVIDER_WIDTH + MIN_CANVAS_WIDTH, Math.round(Number(width) || 0));
    const panes = normalizeWidths(preferred, mins);
    const budget = available - 2 * DIVIDER_WIDTH - MIN_CANVAS_WIDTH;
    if (panes.steps + panes.properties > budget) {
      const extra = budget - mins.steps - mins.properties;
      const desiredSteps = panes.steps - mins.steps;
      const desiredProperties = panes.properties - mins.properties;
      panes.steps = mins.steps + Math.floor(extra * desiredSteps / (desiredSteps + desiredProperties || 1));
      panes.properties = mins.properties + extra - (panes.steps - mins.steps);
    }
    return { ...panes, canvas: available - panes.steps - panes.properties - 2 * DIVIDER_WIDTH };
  }

  function paneBounds(side, width, otherWidth, mins = MIN_WIDTHS) {
    return { min: mins[side], max: Math.max(mins[side],
      Math.floor(width - otherWidth - 2 * DIVIDER_WIDTH - MIN_CANVAS_WIDTH)) };
  }

  function clampPaneWidth(side, requested, width, otherWidth, mins = MIN_WIDTHS) {
    const { min, max } = paneBounds(side, width, otherWidth, mins);
    return Math.max(min, Math.min(max, Math.round(requested)));
  }

  return { DEFAULT_WIDTHS, MIN_WIDTHS, DIVIDER_WIDTH, MIN_CANVAS_WIDTH, MIN_EDITOR_WIDTH,
    normalizeWidths, layoutPanes, paneBounds, clampPaneWidth };
});
