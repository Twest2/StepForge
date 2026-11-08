'use strict';
const { htmlToMarkdown } = require('../exporters/htmlmd');
const { markdownHtml } = require('./placeholder-markdown');

/** Stored description HTML as the Markdown a person or agent edits. */
function descriptionToMarkdown(html) {
  // htmlToMarkdown rewrites step links as export anchors; keep them step links.
  const source = String(html || '').replace(/<a\b([^>]*\bdata-step-id="[^"]*"[^>]*)>[\s\S]*?<\/a>/g, '<a$1>Step</a>');
  return htmlToMarkdown(source).replace(/\]\(#step-([^)\s]+)\)/g, '](step:$1)').trim();
}

/**
 * Markdown typed for a description, as sanitized HTML. Plain text keeps its
 * line breaks, and a blank line starts a new paragraph.
 */
function descriptionFromMarkdown(markdown) {
  const text = String(markdown || '').replace(/[ \t]+$/gm, '').trim();
  return text ? markdownHtml(text) : '';
}

module.exports = { descriptionToMarkdown, descriptionFromMarkdown };
