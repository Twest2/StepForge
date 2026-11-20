'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * "Saved." is for an explicit Save (the Save buttons, Ctrl+S). The flushes
 * before a dialog, publishing or leaving the editor save quietly.
 */
function editor(linkedResult = null) {
  const context = { ...rendererI18n(), window: { stepforge: {} }, document: { activeElement: null }, clearNode() {}, el() {}, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const ed = Object.create(context.window.GuideEditor.prototype);
  const toasts = [];
  Object.assign(ed, {
    guide: linkedResult ? { linkedSource: { path: '/team.sfgz' } } : {},
    onToast: (text) => toasts.push(text),
    stepMap: new Map(), flushGuide: async () => {},
    runLinkedSave: async () => linkedResult,
  });
  return { ed, toasts };
}

test('an implicit flush saves without a "Saved." toast; an explicit Save shows it', async () => {
  const { ed, toasts } = editor();
  await ed.saveAll();
  assert.deepEqual(toasts, []);
  await ed.saveAll({ announce: true });
  assert.deepEqual(toasts, ['Saved.']);
});

test('a linked guide: quiet flushes still report merges and a locked archive', async () => {
  let { ed, toasts } = editor({ saved: true, merged: false });
  await ed.saveAll();
  assert.deepEqual(toasts, []);
  await ed.saveAll({ announce: true });
  assert.deepEqual(toasts, ['Saved and synced to linked archive.']);

  ({ ed, toasts } = editor({ saved: true, merged: true, conflicts: 0 }));
  await ed.saveAll();
  assert.match(toasts[0], /Merged changes from another session/);

  ({ ed, toasts } = editor({ saved: false }));
  await ed.saveAll();
  assert.match(toasts[0], /locked by another session/);
});
