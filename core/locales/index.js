'use strict';

// Every interface translation, for the main process. The renderer loads the
// same files with script tags (app/renderer/index.html).
module.exports = {
  fr: require('./fr'),
  es: require('./es'),
  ru: require('./ru'),
  'zh-CN': require('./zh-CN'),
  ja: require('./ja'),
};
