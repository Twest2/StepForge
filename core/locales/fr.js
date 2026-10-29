'use strict';

// French interface text. Keys are the English text; core/i18n.js explains the format.
(function attachLocale(root, messages) {
  if (typeof module !== 'undefined' && module.exports) module.exports = messages;
  if (root) (root.StepForgeLocales = root.StepForgeLocales || {})['fr'] = messages;
})(typeof window !== 'undefined' ? window : null, {
});
