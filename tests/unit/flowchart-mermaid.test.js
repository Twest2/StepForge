'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toMermaid, fromMermaid } = require('../../core/flowchart-mermaid');

const SAMPLE = `flowchart TD
  A([Start]) --> B[Open the site]
  B --> C{Have an account?}
  C -->|Yes| D(Sign in)
  C -- No --> E[/Create account/]
  E -.-> D
  D ==> F[(Database)] & G@{ shape: doc, label: "Report" }
  G --- H((Done)); H <--> A
  %% a comment
  classDef x fill:#f00
  style A fill:#0f0
`;

test('Mermaid flowchart text becomes a laid-out flowchart', () => {
  const g = fromMermaid(SAMPLE, null);
  assert.deepEqual(g.nodes.map((n) => [n.shape, n.label]), [
    ['terminal', 'Start'], ['rectangle', 'Open the site'], ['decision', 'Have an account?'], ['process', 'Sign in'],
    ['parallelogram', 'Create account'], ['cylinder', 'Database'], ['document', 'Report'], ['circle', 'Done'],
  ]);
  assert.deepEqual(g.edges.map((e) => [e.label, e.style || 'arrow']), [
    ['', 'arrow'], ['', 'arrow'], ['Yes', 'arrow'], ['No', 'arrow'], ['', 'dashed'], ['', 'arrow'], ['', 'arrow'], ['', 'line'], ['', 'double'],
  ]);
  assert.ok(g.nodes[1].y > g.nodes[0].y, 'laid out top to bottom');
});

test('editing the Mermaid keeps what Mermaid does not say about existing shapes', () => {
  const g = fromMermaid('flowchart TD\n A[Start] --> B[Sign in]\n B --> C[(DB)]', null);
  Object.assign(g.nodes[0], { x: 900, fill: '#ff0000', stepId: 'step-1' });
  g.nodes[2].shape = 'cube'; // Mermaid has no cube; it is written as a rectangle
  const { text, ids } = toMermaid(g);
  assert.match(text, /n3@\{ shape: rect, label: "DB" \}/);
  const next = fromMermaid(text.replace('"Start"', '"Begin"') + '  n2 -->|Maybe| Z[New one]\n', g, ids);
  assert.deepEqual([next.nodes[0].label, next.nodes[0].x, next.nodes[0].fill, next.nodes[0].stepId], ['Begin', 900, '#ff0000', 'step-1']);
  assert.equal(next.nodes[2].shape, 'cube');
  const added = next.nodes.at(-1);
  assert.equal(added.label, 'New one');
  assert.ok(added.y > next.nodes[1].y, 'a new node goes under the node that leads to it');
  assert.equal(next.edges.at(-1).label, 'Maybe');
});

test('Mermaid it cannot read names the line', () => {
  assert.throws(() => fromMermaid('flowchart TD\n  A --> B\n  A --> \n', null), /Line 3/);
  assert.throws(() => fromMermaid('flowchart TD\n  A[Start] ??? B\n', null), /Line 2/);
});

test('Mermaid text is cut into colored pieces that join back to the text', () => {
  const { tokens } = require('../../core/flowchart-mermaid');
  const text = 'flowchart TD\n  A([Start]) --> B[Open the site] %% note\n  C -->|Yes| D{"Ask?"}\n  n6@{ shape: cloud, label: "Internet" }';
  const pieces = tokens(text);
  assert.equal(pieces.map((p) => p.text).join(''), text);
  const kinds = (kind) => pieces.filter((p) => p.kind === kind).map((p) => p.text);
  assert.deepEqual(kinds('keyword'), ['flowchart']);
  assert.deepEqual(kinds('direction'), ['TD']);
  assert.deepEqual(kinds('arrow'), ['-->', '-->']);
  assert.deepEqual(kinds('comment'), ['%% note']);
  assert.deepEqual(kinds('label'), ['|Yes|']);
  assert.ok(kinds('string').includes('Open the site') && kinds('string').includes('"Internet"') && kinds('string').includes('cloud'));
  assert.deepEqual(kinds('node'), ['A', 'B', 'C', 'D', 'n6']);
});
