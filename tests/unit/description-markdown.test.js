'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { descriptionToMarkdown, descriptionFromMarkdown } = require('../../core/description-markdown');
const { htmlToMarkdown } = require('../../exporters/htmlmd');

const roundTrip = (markdown) => {
  const html = descriptionFromMarkdown(markdown);
  return { html, again: descriptionFromMarkdown(descriptionToMarkdown(html)) };
};

test('guide descriptions turn Markdown into formatting', () => {
  const html = descriptionFromMarkdown('**Bold**, *italic* and `npm test`\n\n- One\n- Two\n\n1. First\n\n[Docs](https://example.com)');
  assert.equal(html,
    '<p><strong>Bold</strong>, <em>italic</em> and <code>npm test</code></p>'
    + '<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>'
    + '<p><a href="https://example.com">Docs</a></p>');
});

test('plain text keeps its line breaks, and a blank line starts a new paragraph', () => {
  assert.equal(descriptionFromMarkdown('  Line one  \nline two\n\n\n\nNew paragraph\n'),
    '<p>Line one<br>line two</p><p>New paragraph</p>');
  assert.equal(descriptionFromMarkdown('Price is 5 * 3 * 2'), '<p>Price is 5 * 3 * 2</p>');
  assert.equal(descriptionFromMarkdown('   \n'), '');
});

test('raw HTML in a description stays text', () => {
  const html = descriptionFromMarkdown('<script>alert(1)</script> & <b>not bold</b>');
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;not bold&lt;/b&gt;</p>');
  assert.equal(descriptionToMarkdown(html), '<script>alert(1)</script> & <b>not bold</b>');
});

test('opening and saving a description without changes keeps its formatting', () => {
  for (const markdown of [
    '**Bold** and *italic* with `<b>code</b>`\n\n- One\n- **Two**\n\n1. First\n2. Second',
    '[Docs](https://example.com/a?b=1&c=2) and [step 2](step:abc123)',
    '```\nnpm install\n<x> &amp;\n```',
    'Use [[Product]] here\n\n[[Footer]]',
    '- <b>x</b> &amp;lt;',
  ]) {
    const { html, again } = roundTrip(markdown);
    assert.equal(again, html, markdown);
  }
  assert.equal(descriptionToMarkdown('<p>See <a href="step:abc123">step 2</a>.</p>'), 'See [step 2](step:abc123).');
});

test('Markdown exports keep escaped text and code inside descriptions', () => {
  assert.equal(htmlToMarkdown('<p>Run <code>&lt;div&gt;</code></p><pre><code>a &lt;b&gt; &amp;amp;</code></pre>'),
    'Run `<div>`\n\n```\na <b> &amp;\n```');
  assert.equal(htmlToMarkdown('<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>'), '- <b>x</b>');
});
