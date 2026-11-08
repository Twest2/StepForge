'use strict';

/**
 * Markdown descriptions (Description → Markdown): CommonMark with GitHub's
 * tables, strikethrough, autolinks and task lists (- [x]), single line breaks
 * kept, and inline HTML. The result still goes through core/sanitize.js, so
 * HTML is limited to what descriptions allow (no scripts, styles or embedded
 * resources).
 *
 * Image syntax becomes a link to the image: a guide never loads a remote
 * picture by itself. [Step 3](step:<stepId>) links to a step and is
 * renumbered like the rich-text Step button's links.
 *
 * Loaded by Node (core/schema.js) and by the renderer as a plain script, after
 * node_modules/markdown-it/dist/markdown-it.min.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('markdown-it'));
  else root.StepForgeMarkdown = factory(root.markdownit);
})(typeof window === 'object' ? window : globalThis, function (MarkdownIt) {
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: false });
  const validate = md.validateLink.bind(md);
  md.validateLink = (url) => /^step:[A-Za-z0-9_-]+$/.test(url) || validate(url);

  md.renderer.rules.image = (tokens, i) => {
    const token = tokens[i];
    const src = token.attrGet('src') || '';
    const alt = token.content || src;
    return `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(alt)}</a>`;
  };
  const linkOpen = md.renderer.rules.link_open || ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = tokens[i].attrGet('href') || '';
    if (href.startsWith('step:')) tokens[i].attrSet('data-step-id', href.slice(5));
    return linkOpen(tokens, i, options, env, self);
  };

  /** Markdown source as (unsanitized) HTML. */
  function render(source) {
    const text = String(source || '').slice(0, 200000);
    if (!text.trim()) return '';
    // GitHub task lists: "- [ ] to do" and "- [x] done" as boxes.
    return md.render(text).trim()
      .replace(/<li>(<p>)?\[ \] /g, '<li>$1☐ ')
      .replace(/<li>(<p>)?\[[xX]\] /g, '<li>$1☑ ');
  }

  return { render };
});
