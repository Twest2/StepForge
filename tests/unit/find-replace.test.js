'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMatches, applyReplacements, refusalReason, isMatchArg } = require('../../core/find-replace');
const { createStep } = require('../../core/schema');

const step = (fields) => createStep({ stepId: fields.stepId || 's1', ...fields });
const replaceAll = (steps, query, replacement, options = {}) => {
  const matches = findMatches(steps, query, { ...options, replacement });
  return { matches, ...applyReplacements(steps, matches, replacement) };
};

test('finds matches in every searched field and reports where', () => {
  const s = step({
    title: 'Open Widget',
    descriptionHtml: '<p>Click the Widget icon.</p>',
    textBlocks: [{ title: 'Widget tip', descriptionHtml: '<p>Widget!</p>' }],
    codeBlocks: [{ code: 'widget --help' }],
    tableBlocks: [{ rows: [['Name', 'Widget'], ['x', 'y']] }],
    annotations: [{ type: 'text', text: 'Widget here' }],
  });
  const kinds = findMatches([s], 'widget').map((m) => m.kind);
  assert.deepEqual(kinds, ['title', 'description', 'text-block-title', 'text-block', 'code', 'table', 'annotation']);
  const cell = findMatches([s], 'widget').find((m) => m.kind === 'table');
  assert.deepEqual(cell.path, ['tableBlocks', 0, 'rows', 0, 1]);
  assert.match(cell.where, /row 1, column 2/);
});

test('matches carry context and are numbered within their field', () => {
  const s = step({ title: 'one two one three one' });
  const matches = findMatches([s], 'one');
  assert.deepEqual(matches.map((m) => [m.index, m.start]), [[0, 0], [1, 8], [2, 18]]);
  assert.equal(matches[1].before, 'one two ');
  assert.equal(matches[1].after, ' three one');
  assert.equal(new Set(matches.map((m) => m.id)).size, 3);
});

test('case sensitivity and whole word options', () => {
  const s = step({ title: 'Cat concat cat CAT cat_x cat.' });
  assert.equal(findMatches([s], 'cat').length, 6);
  assert.equal(findMatches([s], 'cat', { caseSensitive: true }).length, 4);
  // whole word: Cat, cat, CAT, "cat." -- not concat or cat_x
  assert.equal(findMatches([s], 'cat', { wholeWord: true }).length, 4);
  assert.equal(findMatches([s], 'cat', { wholeWord: true, caseSensitive: true }).length, 2);
});

test('whole word only checks the sides that start or end with a word character', () => {
  const s = step({ title: 'Press (Ctrl) now, xCtrl) or (Ctrly' });
  assert.deepEqual(findMatches([s], '(Ctrl)', { wholeWord: true }).map((m) => m.start), [6]);
  assert.equal(findMatches([s], '(Ctrl', { wholeWord: true }).length, 1);
});

test('regex characters in the query are literal', () => {
  const s = step({ title: 'a.b a+b (a) [x] a*b' });
  assert.equal(findMatches([s], 'a.b').length, 1);
  assert.equal(findMatches([s], '(a)').length, 1);
  assert.equal(findMatches([s], '[x]').length, 1);
  assert.equal(findMatches([s], '*').length, 1);
});

test('an empty query matches nothing, and limit stops the scan', () => {
  const s = step({ title: 'a a a a' });
  assert.deepEqual(findMatches([s], ''), []);
  assert.equal(findMatches([s], 'a', { limit: 2 }).length, 2);
});

test('plain fields are replaced', () => {
  const s = step({
    title: 'Open Widget', codeBlocks: [{ code: 'widget\nwidget' }],
    annotations: [{ type: 'text', text: 'the Widget' }],
  });
  const r = replaceAll([s], 'widget', 'Gadget');
  assert.equal(r.applied, 4);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].title, 'Open Gadget');
  assert.equal(r.steps[0].codeBlocks[0].code, 'Gadget\nGadget');
  assert.equal(r.steps[0].annotations[0].text, 'the Gadget');
  assert.equal(s.title, 'Open Widget', 'the input is not modified');
  assert.deepEqual(r.before, [s], 'the originals come back for an undo record');
});

test('unchanged steps are not returned', () => {
  const a = step({ stepId: 'a', title: 'Widget' });
  const b = step({ stepId: 'b', title: 'Other' });
  const r = replaceAll([a, b], 'Widget', 'Gadget');
  assert.deepEqual(r.steps.map((x) => x.stepId), ['a']);
});

test('only the ticked matches are replaced', () => {
  const s = step({ title: 'x x x' });
  const matches = findMatches([s], 'x');
  const r = applyReplacements([s], [matches[0], matches[2]], 'y');
  assert.equal(r.steps[0].title, 'y x y');
  assert.equal(r.applied, 2);
});

test('replacing with an empty string deletes the match', () => {
  const s = step({ title: 'Please click the button' });
  assert.equal(replaceAll([s], 'Please ', '').steps[0].title, 'click the button');
});

test('HTML: only text nodes are matched, never tags or attributes', () => {
  const s = step({ descriptionHtml: '<p class="x">a</p><a href="https://example.com/b">b link</a> <b>p</b>' });
  assert.equal(findMatches([s], 'href').length, 0);
  assert.equal(findMatches([s], 'example').length, 0);
  assert.equal(findMatches([s], 'p').length, 1); // the <b>p</b> text, not <p> or <a>
  const r = replaceAll([s], 'b', 'Z');
  assert.equal(r.steps[0].descriptionHtml, '<p>a</p><a href="https://example.com/b">Z link</a> <b>p</b>');
});

test('HTML: replaced text is escaped, so it cannot inject markup', () => {
  const s = step({ descriptionHtml: '<p>Hello world</p>' });
  const r = replaceAll([s], 'world', '<script>alert(1)</script> & "q"');
  assert.equal(r.steps[0].descriptionHtml, '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt; &amp; "q"</p>');
});

test('HTML: entities are matched as the characters they stand for and untouched text keeps its entities', () => {
  const s = step({ descriptionHtml: '<p>R&amp;D &lt;Widget&gt; &nbsp;and&copy; Widget</p>' });
  assert.equal(findMatches([s], 'R&D').length, 1);
  assert.equal(findMatches([s], '<Widget>').length, 1);
  const r = replaceAll([s], 'Widget', 'Gadget');
  assert.equal(r.steps[0].descriptionHtml, '<p>R&amp;D &lt;Gadget&gt; &nbsp;and&copy; Gadget</p>');
  const rd = replaceAll([s], 'R&D', 'R&D team');
  assert.equal(rd.steps[0].descriptionHtml, '<p>R&amp;D team &lt;Widget&gt; &nbsp;and&copy; Widget</p>');
});

test('HTML: several matches in one text node and across nodes', () => {
  const s = step({ descriptionHtml: '<p>foo and foo</p><ul><li>foo</li><li><b>bar</b> foo</li></ul>' });
  const r = replaceAll([s], 'foo', 'quux');
  assert.equal(r.applied, 4);
  assert.equal(r.steps[0].descriptionHtml, '<p>quux and quux</p><ul><li>quux</li><li><b>bar</b> quux</li></ul>');
});

test('HTML: a phrase split by formatting is not matched across the tags', () => {
  const s = step({ descriptionHtml: '<p>Open <b>Set</b>tings</p>' });
  assert.equal(findMatches([s], 'Settings').length, 0);
  assert.equal(findMatches([s], 'Open').length, 1);
});

test('HTML: the result goes back through the sanitizer', () => {
  // A stored field with markup the sanitizer would strip is cleaned when it is rewritten.
  const s = step({ descriptionHtml: '<p>hello</p>' });
  s.descriptionHtml = '<p onclick="x()">hello</p><script>bad()</script>';
  const r = replaceAll([s], 'hello', 'bye');
  assert.equal(r.steps[0].descriptionHtml, '<p>bye</p>');
});

test('HTML: text block bodies are edited the same way', () => {
  const s = step({ textBlocks: [{ title: 'T', descriptionHtml: '<p>The <i>old</i> name is old.</p>' }] });
  const r = replaceAll([s], 'old', 'new');
  assert.equal(r.steps[0].textBlocks[0].descriptionHtml, '<p>The <i>new</i> name is new.</p>');
});

test('[[placeholder]] tokens are never listed or altered', () => {
  const s = step({
    title: 'Hi [[Company]] and Company',
    descriptionHtml: '<p>[[Company]] is Company</p>',
    codeBlocks: [{ code: 'echo [[Company]]' }],
  });
  const matches = findMatches([s], 'Company');
  assert.deepEqual(matches.map((m) => [m.kind, m.start]), [['title', 19], ['description', 15]]);
  const r = applyReplacements([s], matches, 'Acme');
  assert.equal(r.steps[0].title, 'Hi [[Company]] and Acme');
  assert.equal(r.steps[0].descriptionHtml, '<p>[[Company]] is Acme</p>');
  assert.equal(r.steps[0].codeBlocks[0].code, 'echo [[Company]]');
});

test('a query that overlaps a token only partly is skipped too', () => {
  const s = step({ title: '[[Guide_Title]] Guide' });
  assert.deepEqual(findMatches([s], '[[Guide').length, 0);
  assert.deepEqual(findMatches([s], 'Title]]').length, 0);
  assert.deepEqual(findMatches([s], '[[Guide_Title]]').length, 0);
  assert.deepEqual(findMatches([s], 'Guide').map((m) => m.start), [16]);
});

test('a replacement may itself be a placeholder token', () => {
  const s = step({ title: 'Welcome to Acme' });
  assert.equal(replaceAll([s], 'Acme', '[[Company]]').steps[0].title, 'Welcome to [[Company]]');
});

test('table cells refuse a replacement containing a pipe or a line break', () => {
  const s = step({ title: 'a b', tableBlocks: [{ rows: [['a', 'b a'], ['a', 'c']] }] });
  const pipe = replaceAll([s], 'a', 'x|y');
  assert.equal(pipe.matches.filter((m) => m.blocked).length, 3, 'only table cells are blocked');
  assert.equal(pipe.refused.length, 3);
  assert.match(pipe.refused[0].reason, /table cell/i);
  assert.equal(pipe.applied, 1);
  assert.equal(pipe.steps[0].title, 'x|y b');
  assert.deepEqual(pipe.steps[0].tableBlocks[0].rows, [['a', 'b a'], ['a', 'c']]);

  const nl = replaceAll([s], 'a', 'x\ny');
  assert.equal(nl.refused.length, 4, 'three cells and the title');
  assert.equal(nl.applied, 0);
  assert.deepEqual(nl.steps, []);
});

test('table cells are replaced when the replacement is safe', () => {
  const s = step({ tableBlocks: [{ rows: [['Widget', 'is Widget'], ['x', 'WIDGET']] }] });
  const r = replaceAll([s], 'widget', 'Gadget');
  assert.deepEqual(r.steps[0].tableBlocks[0].rows, [['Gadget', 'is Gadget'], ['x', 'Gadget']]);
  assert.equal(r.refused.length, 0);
});

test('titles refuse a line break but a code block takes one', () => {
  const s = step({ title: 'a', textBlocks: [{ title: 'a' }], codeBlocks: [{ code: 'a' }] });
  const r = replaceAll([s], 'a', 'x\ny');
  assert.equal(r.refused.length, 2);
  assert.equal(r.steps[0].codeBlocks[0].code, 'x\ny');
  assert.equal(r.steps[0].title, 'a');
  assert.equal(refusalReason({ kind: 'code' }, '|\n'), null);
  assert.equal(refusalReason({ kind: 'table' }, 'fine'), null);
});

test('findMatches marks blocked matches only when given a replacement', () => {
  const s = step({ tableBlocks: [{ rows: [['a']] }] });
  assert.equal('blocked' in findMatches([s], 'a')[0], false);
  assert.equal(findMatches([s], 'a', { replacement: 'x' })[0].blocked, null);
  assert.ok(findMatches([s], 'a', { replacement: '|' })[0].blocked);
});

test('stale matches are skipped instead of corrupting text', () => {
  const s = step({ title: 'Open Widget', descriptionHtml: '<p>Widget</p>' });
  const matches = findMatches([s], 'Widget');
  const edited = { ...s, title: 'Open Widget Widget', descriptionHtml: '<p>Gadget</p>' };
  const r = applyReplacements([edited], matches, 'X');
  assert.equal(r.applied, 1);
  assert.equal(r.steps[0].title, 'Open X Widget');
  assert.equal(r.steps[0].descriptionHtml, '<p>Gadget</p>');
  assert.deepEqual(r.stale, [matches[1].id]);
  // A match for a step that is gone, or for a field that is gone, is stale as well.
  const gone = applyReplacements([], matches, 'X');
  assert.equal(gone.stale.length, 2);
  const noField = applyReplacements([step({ title: 'Widget' })], [{ ...matches[0], path: ['codeBlocks', 3, 'code'] }], 'X');
  assert.equal(noField.stale.length, 1);
  assert.equal(noField.steps.length, 0);
});

test('a match that now overlaps a placeholder token is stale', () => {
  const s = step({ title: 'say hi' });
  const matches = findMatches([s], 'hi');
  const edited = { ...s, title: 'say [[hi]]' };
  assert.equal(applyReplacements([edited], matches, 'yo').applied, 0);
});

test('matches from the same call can be re-applied to a fresh copy of the steps', () => {
  const s = step({ title: 'Widget', descriptionHtml: '<p>Widget</p>' });
  const matches = findMatches([s], 'Widget');
  const json = JSON.parse(JSON.stringify(matches)); // as sent over IPC
  const r = applyReplacements([s], json, 'Gadget');
  assert.equal(r.applied, 2);
});

test('multiple steps and unicode', () => {
  const a = step({ stepId: 'a', title: 'Café menu' });
  const b = step({ stepId: 'b', descriptionHtml: '<p>CAFÉ and café</p>' });
  const r = replaceAll([a, b], 'café', 'Bar');
  assert.equal(r.steps[0].title, 'Bar menu');
  assert.equal(r.steps[1].descriptionHtml, '<p>Bar and Bar</p>');
  assert.deepEqual(findMatches([a, b], 'café').map((m) => m.stepIndex), [0, 1, 1]);
});

test('a refusal follows the field the match lands in, not the kind the caller sent back', () => {
  const s = step({ tableBlocks: [{ rows: [['a']] }] });
  const [match] = findMatches([s], 'a');
  const r = applyReplacements([s], [{ ...match, kind: 'code' }], 'x|y');
  assert.equal(r.refused.length, 1);
  assert.equal(r.applied, 0);
  assert.deepEqual(r.steps, []);
});

test('malformed matches are stale instead of throwing', () => {
  const s = step({ title: 'Widget' });
  const [match] = findMatches([s], 'Widget');
  const r = applyReplacements([s], [{ ...match, node: 'length' }, { ...match, start: '0' }], 'X');
  assert.equal(r.applied, 0);
  assert.equal(r.stale.length, 2);
});

test('isMatchArg accepts what findMatches makes and rejects other shapes', () => {
  const s = step({ title: 'Widget', descriptionHtml: '<p>Widget</p>', tableBlocks: [{ rows: [['Widget']] }] });
  const matches = findMatches([s], 'Widget', { replacement: 'x' });
  assert.equal(matches.length, 3);
  assert.ok(matches.every(isMatchArg));
  const [m] = matches;
  for (const bad of [
    null, [], 'x', { ...m, stepId: 7 }, { ...m, stepId: '' }, { ...m, path: 'title' }, { ...m, path: [] },
    { ...m, path: ['a', 'b', 'c', 'd', 'e', 'f'] }, { ...m, path: ['__proto__.x'] }, { ...m, path: [{}] },
    { ...m, path: [-1] }, { ...m, node: 'length' }, { ...m, start: 1.5 }, { ...m, start: 4, end: 2 },
    { ...m, matched: 3 }, { ...m, matched: 'x'.repeat(5000) }, { ...m, id: {} },
  ]) {
    assert.equal(isMatchArg(bad), false, JSON.stringify(bad && bad.path));
  }
});
