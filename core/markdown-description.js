'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('markdown-it'));
  else root.StepForgeMarkdown = factory(root.markdownit);
})(typeof window === 'object' ? window : globalThis, function (MarkdownIt) {
  const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
  const originalValidate = md.validateLink.bind(md);
  md.validateLink = url => /^step:[a-zA-Z0-9_-]+$/.test(url) || originalValidate(url);
  // Embedded remote resources would make opening an offline guide contact a
  // third party. Keep image syntax useful as an explicit link instead.
  md.renderer.rules.image = (tokens, i) => {
    const token = tokens[i], src = token.attrGet('src') || '', alt = token.content || 'Image';
    return `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(alt)}</a>`;
  };
  function render(source) { return md.render(String(source || '').slice(0, 2000000)); }
  return { render };
});
