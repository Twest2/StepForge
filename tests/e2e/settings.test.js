'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, readAppSettings } = require('./lib/fixtures');
const { eventually } = require('./lib/flows');

test('saving a theme changes appearance and reopening Settings keeps the choice', () => withApp('settings-theme', {}, async (app, env) => {
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  const select = '#modal-root select';
  await app.selectOption(select, 'Dark');
  await app.clickText('Save', { scope: '#modal-root' });
  await eventually(() => readAppSettings(env.dataDir).appearance === 'dark', 'dark appearance saved');
  await app.waitForGone('.settings-nav');
  await eventually(() => app.evaluate('getComputedStyle(document.documentElement).colorScheme === "dark"'), 'dark theme applied');
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  assert.equal(await app.evaluate('document.querySelector("#modal-root select").value'), 'dark');
  await app.selectOption(select, 'Light');
  await app.clickText('Save', { scope: '#modal-root' });
  await eventually(() => readAppSettings(env.dataDir).appearance === 'light', 'light appearance saved');
  await app.waitForGone('.settings-nav');
  await eventually(async () => await app.evaluate('getComputedStyle(document.documentElement).colorScheme') === 'light', 'visible theme changed');
}));
