'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, readAppSettings } = require('./lib/fixtures');
const { eventually } = require('./lib/flows');

test('a theme applies with Settings still open and is kept when reopened', () => withApp('settings-theme', {}, async (app, env) => {
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  const select = '#modal-root select';
  await app.selectOption(select, 'Dark');
  await eventually(() => readAppSettings(env.dataDir).appearance === 'dark', 'dark appearance saved');
  await eventually(() => app.evaluate('getComputedStyle(document.documentElement).colorScheme === "dark"'), 'dark theme applied');
  await app.waitForVisible('.settings-nav');
  await app.clickText('Close', { scope: '#modal-root footer' });
  await app.waitForGone('.settings-nav');
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  assert.equal(await app.evaluate('document.querySelector("#modal-root select").value'), 'dark');
  await app.selectOption(select, 'Light');
  await eventually(() => readAppSettings(env.dataDir).appearance === 'light', 'light appearance saved');
  await eventually(async () => await app.evaluate('getComputedStyle(document.documentElement).colorScheme') === 'light', 'visible theme changed');
  await app.clickText('Close (Esc)', { scope: '#modal-root header' });
  await app.waitForGone('.settings-nav');
}));

test('global placeholder edits and removal apply while Settings stays open', () => withApp('settings-placeholders', { sample: false }, async (app, env) => {
  const file = path.join(env.dataDir, 'settings', 'placeholders.json');
  const globals = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.clickText('Placeholders', { scope: '.settings-nav' });
  await app.clickText('Add placeholder', { scope: '#modal-root' });
  await app.setValue('.global-placeholder-name', 'product');
  await app.setValue('.global-placeholder-value', 'StepForge');
  await app.key('Tab');
  await eventually(() => globals().product?.text === 'StepForge', 'placeholder saved');
  await app.clickText('−', { scope: '#modal-root .placeholder-row' });
  await eventually(() => !Object.hasOwn(globals(), 'product'), 'placeholder removed');
  await app.waitForVisible('.settings-nav');
}));

test('a language change waits until the open guide is safe to reload', () => withApp('settings-language', { sample: false }, async (app, env) => {
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  const chooseFrench = () => app.evaluate(`(() => {
    const language = document.querySelector('.settings-form select:has(option[value="fr"])');
    language.value = 'fr';
    language.dispatchEvent(new Event('change'));
  })()`);
  await app.evaluate('window.stepforgeApp.flushEditorBeforeNavigation = async () => false');
  await chooseFrench();
  await eventually(async () => /Save your guide before changing the language/.test(await app.evaluate(
    "document.querySelector('.settings-save-error')?.textContent"
  )), 'language change blocked by the guide save');
  await app.waitForVisible('.settings-nav');
  assert.notEqual(readAppSettings(env.dataDir).language, 'fr');
  await app.evaluate('delete window.stepforgeApp.flushEditorBeforeNavigation');
  await chooseFrench();
  await eventually(async () => (await app.evaluate('new URL(location.href).searchParams.get("lang")')) === 'fr', 'French renderer loaded');
  assert.equal(readAppSettings(env.dataDir).language, 'fr');
}));

test('MCP access is granted and revoked from the switch while Settings is open', () => withApp('settings-mcp', { sample: false }, async (app, env) => {
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.clickText('AI', { scope: '.settings-nav' });
  const toggle = () => app.clickText('Let AI agents edit your guides', { scope: '#modal-root' });
  await toggle();
  await eventually(() => readAppSettings(env.dataDir).ai?.agents?.enabled === true, 'access enabled');
  await toggle();
  await eventually(() => readAppSettings(env.dataDir).ai?.agents?.enabled === false, 'access revoked');
  await app.waitForVisible('.settings-nav');
}));

test('a setting that fails to save keeps Settings open until the change is discarded', () => withApp('settings-write-fails', { sample: false }, async (app, env) => {
  // The settings folder can become read-only or full; make the main process refuse the write.
  await app.main.evaluate(`(() => {
    const { ipcMain } = process.mainModule.require('electron');
    ipcMain.removeHandler('settings:set');
    ipcMain.handle('settings:set', () => { throw new Error('disk full'); });
  })()`);
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  await app.selectOption('#modal-root select', 'Dark');
  await eventually(async () => /disk full/.test(await app.evaluate("document.querySelector('.settings-save-error')?.textContent")), 'save error shown');
  await app.clickText('Close', { scope: '#modal-root footer' });
  await app.clickText('Keep editing', { scope: '#modal-root' });
  await app.waitForVisible('.settings-nav');
  assert.notEqual(readAppSettings(env.dataDir).appearance, 'dark');
  await app.clickText('Close', { scope: '#modal-root footer' });
  await app.clickText('Discard', { scope: '#modal-root' });
  await app.waitForGone('.settings-nav');
}));
