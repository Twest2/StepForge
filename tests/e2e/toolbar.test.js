'use strict';

// The annotation toolbar's tooltips name each tool's key, and pressing that
// key (a real key press) picks that tool.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./lib/fixtures');
const { openLibrary, openGuideCard, eventually } = require('./lib/flows');

test('each tool tooltip shows its key, and pressing that key picks the tool', () => withApp('toolbar-keys', {}, async (app) => {
  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
  await app.waitForVisible('canvas[aria-label="Screenshot editor"]');
  const buttons = await app.evaluate(`[...document.querySelectorAll('.canvas-toolbar [data-tool]')]
    .map((b) => ({ tool: b.dataset.tool, name: b.getAttribute('aria-label'), title: b.getAttribute('title') }))`);
  assert.equal(buttons.length, 15);
  const pressed = (tool) => app.evaluate(`document.querySelector('.canvas-toolbar [data-tool="${tool}"]').getAttribute('aria-pressed') === 'true'`);
  const keys = new Set();
  for (const { tool, name, title } of buttons) {
    const match = /^(.+) \(([A-Z])\)$/.exec(title);
    assert.ok(match, `"${title}" is "Name (Key)"`);
    assert.equal(match[1], name);
    keys.add(match[2]);
    await app.key(match[2].toLowerCase());
    await eventually(() => pressed(tool), `${match[2]} picks ${tool}`);
    for (const other of buttons.filter((b) => b.tool !== tool)) assert.equal(await pressed(other.tool), false, `${other.tool} is not picked too`);
    await app.key('Escape');
    await eventually(async () => !(await pressed(tool)), `Escape puts ${tool} down`);
  }
  assert.equal(keys.size, buttons.length, 'every tool has its own key');
}));
