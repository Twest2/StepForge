'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The editor's only blue (primary) buttons: Capture in the top bar, Add in
 * the Steps pane, and Save at the bottom right. The top bar's Save is plain.
 */
const read = (file) => fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8');

test('the editor shows exactly Capture, Add and the bottom-right Save as primary buttons', () => {
  const app = read('app.js');
  const topbar = app.slice(app.indexOf("t('Library')),"), app.indexOf("t('More ▾')"));
  assert.match(topbar, /el\('button\.primary', \{\s*type: 'button',\s*title: t\('Capture a screenshot step'\)/);
  assert.match(topbar, /el\('button', \{ type: 'button', onClick: \(\) => this\.editor\.saveAll\(\) \}, t\('Save'\)\)/);
  assert.equal((topbar.match(/button\.primary/g) || []).length, 1, 'only Capture is primary in the top bar');

  const editor = read('editor.js');
  assert.match(editor, /this\.dom\.addStepBtn = el\('button\.primary'/);
  assert.match(editor, /this\.dom\.saveNowBtn = el\('button\.primary'/);
});
