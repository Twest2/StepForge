'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  zoomShortcutFromInputEvent,
  zoomShortcutFromKeyboardEvent,
} = require('../../app/shortcut-utils');

test('zoom shortcut helper recognizes zoom in, out, and fit across event shapes', () => {
  assert.equal(zoomShortcutFromKeyboardEvent({ ctrlKey: true, key: '=', code: 'Equal' }), 'in');
  assert.equal(zoomShortcutFromKeyboardEvent({ ctrlKey: true, key: '+', code: 'NumpadAdd' }), 'in');
  assert.equal(zoomShortcutFromKeyboardEvent({ ctrlKey: true, key: 'Plus', code: 'Equal' }), 'in');
  assert.equal(zoomShortcutFromKeyboardEvent({ ctrlKey: true, key: '-', code: 'Minus' }), 'out');
  assert.equal(zoomShortcutFromKeyboardEvent({ metaKey: true, key: '0', code: 'Digit0' }), 'fit');
  assert.equal(zoomShortcutFromKeyboardEvent({ ctrlKey: true, key: '=', code: 'Equal', shiftKey: true }), 'in');
});

test('zoom shortcut helper recognizes Electron before-input-event payloads', () => {
  assert.equal(zoomShortcutFromInputEvent({ control: true, key: '=', code: 'Equal' }), 'in');
  assert.equal(zoomShortcutFromInputEvent({ control: true, key: '=', code: 'Equal', shift: true }), 'in');
  assert.equal(zoomShortcutFromInputEvent({ control: true, key: 'Plus', code: 'Equal', shift: true }), 'in');
  assert.equal(zoomShortcutFromInputEvent({ control: true, key: '-', code: 'Minus' }), 'out');
  assert.equal(zoomShortcutFromInputEvent({ meta: true, key: '0', code: 'Digit0' }), 'fit');
});
