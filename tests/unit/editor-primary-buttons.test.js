'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The editor's only blue (primary) buttons: Start recording (with its ▾ menu)
 * in the top bar, Add in the Steps pane, and Save at the bottom right. The
 * top bar's Save is plain.
 */
const read = (file) => fs.readFileSync(path.join(__dirname, '../../app/renderer', file), 'utf8');

test('the editor shows exactly Start recording, Add and the bottom-right Save as primary buttons', () => {
  const app = read('app.js');
  const topbar = app.slice(app.indexOf("t('Library')),"), app.indexOf("t('More ▾')"));
  assert.match(topbar, /el\('span\.split-button', \{\},\s*this\.recordButton = el\('button\.primary'/);
  assert.match(topbar, /el\('button', \{ type: 'button', onClick: \(\) => this\.editor\.saveAll\(\) \}, t\('Save'\)\)/);
  const split = topbar.slice(topbar.indexOf("el('span.split-button'"), topbar.indexOf("t('Save')"));
  assert.equal((topbar.match(/button\.primary/g) || []).length, 2, 'only Start recording and its ▾ are primary in the top bar');
  assert.equal((split.match(/button\.primary/g) || []).length, 2, 'both are the one split button');

  const editor = read('editor.js');
  assert.match(editor, /this\.dom\.addStepBtn = el\('button\.primary'/);
  assert.match(editor, /this\.dom\.saveNowBtn = el\('button\.primary'/);
});
