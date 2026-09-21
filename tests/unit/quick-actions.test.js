'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function palette(commands) {
  const nodes = [];
  const context = {
    window: {}, setTimeout: () => {}, debounce: fn => fn,
    clearNode: node => { node.children = []; },
    openModal: () => ({ close() {} }),
    el(selector, attrs = {}, ...children) {
      const node = { selector, ...attrs, children, handlers: {},
        append(child) { this.children.push(child); },
        addEventListener(name, fn) { this.handlers[name] = fn; },
        classList: { toggle() {} },
      };
      nodes.push(node);
      return node;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8'), context);
  const result = context.window.StepForgeDialogs.showQuickActions({ commands });
  return { result, input: nodes.find(n => n.type === 'search'), rows: nodes.find(n => n.selector === 'div.qa-results') };
}

test('hover preserves quick-action click targets and executes the selected command once', async () => {
  let calls = 0;
  const p = palette([{ label: 'Settings', action: () => calls++ }]);
  const row = p.rows.children[0];
  row.onMouseenter();
  assert.equal(p.rows.children[0], row, 'hover must not detach the click target');
  row.onClick();
  await p.result;
  assert.equal(calls, 1);
});

test('arrow navigation preserves rows and Enter executes the highlighted command', async () => {
  const calls = [];
  const p = palette(['New guide', 'Import archive'].map(label => ({ label, action: () => calls.push(label) })));
  const row = p.rows.children[1];
  p.input.handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(p.rows.children[1], row);
  p.input.handlers.keydown({ key: 'Enter', preventDefault() {} });
  await p.result;
  assert.deepEqual(calls, ['Import archive']);
});
