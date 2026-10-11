'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidOutline, repairOutline, subtreeOf, moveSubtree, moveSubtreeBy,
} = require('../../core/step-outline');

/** Build [order, parentOf] from 'A a1>A a2>A B' style tokens: "id>parent". */
function outline(spec) {
  const order = [];
  const parentOf = new Map();
  for (const token of spec.split(' ')) {
    const [id, parent] = token.split('>');
    order.push(id);
    parentOf.set(id, parent || null);
  }
  return { order, parentOf };
}
const show = (result) => result && result.order.map((id) => (result.parentOf.get(id) ? `${id}>${result.parentOf.get(id)}` : id)).join(' ');

test('repairOutline leaves a valid outline alone and flattens a broken one', () => {
  const good = outline('A a1>A a2>A B');
  assert.deepEqual([...repairOutline(good.order, good.parentOf)], [...good.parentOf]);
  // a1 names B, which is below it; b2 names a step that is not above it.
  const broken = outline('A a1>B B b1>B b2>zzz');
  const fixed = repairOutline(broken.order, broken.parentOf);
  assert.equal(fixed.get('a1'), null);
  assert.equal(fixed.get('b1'), 'B');
  assert.equal(fixed.get('b2'), null);
  assert.ok(isValidOutline(broken.order, fixed));
});

test('subtreeOf returns a step and its descendants in order', () => {
  const { order, parentOf } = outline('A a1>A a11>a1 a2>A B');
  assert.deepEqual(subtreeOf(order, parentOf, 'A'), ['A', 'a1', 'a11', 'a2']);
  assert.deepEqual(subtreeOf(order, parentOf, 'a1'), ['a1', 'a11']);
  assert.deepEqual(subtreeOf(order, parentOf, 'B'), ['B']);
});

test('moveSubtree carries the whole subtree down past the next top-level step', () => {
  const { order, parentOf } = outline('A a1>A a2>A B C');
  const moved = moveSubtree(order, parentOf, 'A', 4, 0);
  assert.equal(show(moved), 'B A a1>A a2>A C');
  assert.ok(isValidOutline(moved.order, moved.parentOf));
});

test('moveSubtree can drop on the same spot to change only the depth', () => {
  const { order, parentOf } = outline('A B C');
  assert.equal(show(moveSubtree(order, parentOf, 'B', 1, 1)), 'A B>A C');
  assert.equal(show(moveSubtree(order, parentOf, 'B', 1, 0)), 'A B C');
  // Dropping a substep at the same spot with depth 0 pulls it out to the top level.
  const nested = outline('A B>A C');
  assert.equal(show(moveSubtree(nested.order, nested.parentOf, 'B', 1, 0)), 'A B C');
});

test('moveSubtree refuses a gap inside the moved subtree', () => {
  const { order, parentOf } = outline('A a1>A a2>A B');
  assert.equal(moveSubtree(order, parentOf, 'A', 1), null);
  assert.equal(moveSubtree(order, parentOf, 'A', 2), null);
  assert.ok(moveSubtree(order, parentOf, 'A', 3), 'right after the block is just a no-op move');
  assert.ok(moveSubtree(order, parentOf, 'A', 4));
  assert.equal(moveSubtree(order, parentOf, 'nope', 0), null);
  assert.equal(moveSubtree(order, parentOf, 'A', 99), null);
});

test('moveSubtree picks the parent closest to the depth hint', () => {
  const { order, parentOf } = outline('A a1>A a11>a1 B C');
  // After a11 the allowed parents are none, A and a1 (depths 0, 1, 2).
  assert.equal(show(moveSubtree(order, parentOf, 'C', 3, 0)), 'A a1>A a11>a1 C B');
  assert.equal(show(moveSubtree(order, parentOf, 'C', 3, 1)), 'A a1>A a11>a1 C>A B');
  assert.equal(show(moveSubtree(order, parentOf, 'C', 3, 2)), 'A a1>A a11>a1 C>a1 B');
  assert.equal(show(moveSubtree(order, parentOf, 'C', 3, 9)), 'A a1>A a11>a1 C>a11 B');
  // At the very top there is nothing to nest under.
  assert.equal(show(moveSubtree(order, parentOf, 'C', 0, 3)), 'C A a1>A a11>a1 B');
});

test('moveSubtree keeps a step\'s parent when the new spot allows it', () => {
  const { order, parentOf } = outline('A a1>A a2>A a3>A B');
  const moved = moveSubtree(order, parentOf, 'a1', 4);
  assert.equal(show(moved), 'A a2>A a3>A a1>A B');
});

test('moveSubtree nests a step dropped in front of a substep when top level would orphan it', () => {
  // B at the top level between A and a1 would leave a1 under B, so B becomes A's substep.
  const { order, parentOf } = outline('A a1>A B');
  const moved = moveSubtree(order, parentOf, 'B', 1, 0);
  assert.equal(show(moved), 'A B>A a1>A');
  assert.ok(isValidOutline(moved.order, moved.parentOf));
});

test('moveSubtree repairs an already broken outline as it goes', () => {
  const { order, parentOf } = outline('A B a1>A C');
  const moved = moveSubtree(order, parentOf, 'C', 0, 0);
  assert.equal(show(moved), 'C A B a1');
  assert.ok(isValidOutline(moved.order, moved.parentOf));
});

test('moveSubtreeBy moves past the whole neighbouring subtree', () => {
  const { order, parentOf } = outline('A a1>A B b1>B C');
  assert.equal(show(moveSubtreeBy(order, parentOf, 'A', 1)), 'B b1>B A a1>A C');
  assert.equal(show(moveSubtreeBy(order, parentOf, 'C', -1)), 'A a1>A C B b1>B');
  assert.equal(show(moveSubtreeBy(order, parentOf, 'B', -1)), 'B b1>B A a1>A C');
  assert.equal(moveSubtreeBy(order, parentOf, 'A', -1), null);
  assert.equal(moveSubtreeBy(order, parentOf, 'C', 1), null);
});

test('moveSubtreeBy swaps siblings and keeps the parent', () => {
  const { order, parentOf } = outline('A a1>A a11>a1 a2>A B');
  assert.equal(show(moveSubtreeBy(order, parentOf, 'a1', 1)), 'A a2>A a1>A a11>a1 B');
  assert.equal(show(moveSubtreeBy(order, parentOf, 'a2', -1)), 'A a2>A a1>A a11>a1 B');
});

test('moveSubtreeBy: the bug case, Alt+Down on a parent no longer strands its substep', () => {
  const { order, parentOf } = outline('A a1>A B');
  const down = moveSubtreeBy(order, parentOf, 'A', 1);
  assert.equal(show(down), 'B A a1>A');
  assert.ok(isValidOutline(down.order, down.parentOf));
});

test('moveSubtreeBy lets the last substep step out of its parent past the next step', () => {
  const { order, parentOf } = outline('A a1>A B');
  const down = moveSubtreeBy(order, parentOf, 'a1', 1);
  assert.equal(show(down), 'A B a1>B');
  assert.ok(isValidOutline(down.order, down.parentOf));
  // ... and back up: a1 steps out of B in front of it, under A again.
  assert.equal(show(moveSubtreeBy(down.order, down.parentOf, 'a1', -1)), 'A a1>A B');
});

test('moveSubtreeBy never produces an invalid outline from any start', () => {
  const start = outline('A a1>A a11>a1 a2>A B b1>B C c1>C c11>c1');
  for (const id of start.order) {
    for (const delta of [-1, 1]) {
      let state = start;
      for (let n = 0; n < 12; n++) {
        const next = moveSubtreeBy(state.order, state.parentOf, id, delta);
        if (!next) break;
        assert.ok(isValidOutline(next.order, next.parentOf), `${id} ${delta} -> ${show(next)}`);
        assert.equal(next.order.length, start.order.length);
        // The step's own substeps always travel with it.
        const block = subtreeOf(next.order, next.parentOf, id);
        const was = subtreeOf(start.order, start.parentOf, id);
        assert.deepEqual([...block].sort(), [...was].sort());
        const at = next.order.indexOf(id);
        assert.deepEqual(next.order.slice(at, at + block.length), block);
        state = next;
      }
    }
  }
});

test('moveSubtreeBy: the last substep moving down becomes the next step\'s first substep, and Alt+Up undoes it', () => {
  const start = outline('A a1>A B b1>B C');
  const down = moveSubtreeBy(start.order, start.parentOf, 'a1', 1);
  assert.equal(show(down), 'A B a1>B b1>B C');
  assert.equal(show(moveSubtreeBy(down.order, down.parentOf, 'a1', -1)), 'A a1>A B b1>B C');
  // Two levels deep it lands under the next step at the closest level it can.
  const deep = outline('A a1>A a11>a1 a2>A a21>a2');
  assert.equal(show(moveSubtreeBy(deep.order, deep.parentOf, 'a11', 1)), 'A a1>A a2>A a11>a2 a21>a2');
});
