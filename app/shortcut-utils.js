'use strict';

(function attachShortcutUtils(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StepForgeShortcuts = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function hasZoomModifier(source) {
    return Boolean(source && (source.ctrlKey || source.metaKey || source.control || source.meta));
  }

  function zoomShortcutFromSource(source) {
    if (!hasZoomModifier(source)) return null;

    const key = String(source.key || '');
    const code = String(source.code || '');
    const shiftKey = Boolean(source.shiftKey || source.shift);

    if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'fit';

    if (
      key === '+' || key === '=' || key === 'Add' || key === 'Plus' ||
      code === 'Equal' || code === 'NumpadAdd' ||
      (key === '=' && shiftKey) || (code === 'Equal' && shiftKey)
    ) {
      return 'in';
    }

    if (
      key === '-' || key === '_' || key === 'Subtract' || key === 'Minus' ||
      code === 'Minus' || code === 'NumpadSubtract'
    ) {
      return 'out';
    }

    return null;
  }

  function zoomShortcutFromKeyboardEvent(event) {
    return zoomShortcutFromSource(event);
  }

  function zoomShortcutFromInputEvent(input) {
    return zoomShortcutFromSource(input);
  }

  return {
    zoomShortcutFromInputEvent,
    zoomShortcutFromKeyboardEvent,
  };
});
