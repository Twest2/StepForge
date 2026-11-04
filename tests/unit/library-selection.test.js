'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

function library(guides) {
  const context = { ...rendererI18n(), window: {}, document: { addEventListener() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { folderFilter: 'all', selectMode: false, selectedGuides: new Set(), selectedTrash: new Set(), library: { guides, guideFolders: {} } };
  const renders = [];
  app.renderLibrary = () => renders.push('library');
  app.renderGuideGrid = () => renders.push('grid');
  app.renderBulkBar = () => {};
  return { app, renders, document: context.document, selected: () => [...app.state.selectedGuides].sort() };
}
const guides = ['a', 'b', 'c', 'd', 'e'].map((guideId) => ({ guideId, title: guideId }));

test('a first selection gesture enters select mode; later ones toggle guides', () => {
  const { app, renders, selected } = library(guides);
  app.selectGuideFromClick('b', { ctrlKey: true });
  assert.equal(app.state.selectMode, true);
  assert.deepEqual(renders, ['library']);
  app.selectGuideFromClick('d', {});
  app.selectGuideFromClick('b', {});
  assert.deepEqual(selected(), ['d']);
  assert.deepEqual(renders, ['library', 'grid', 'grid']);
});

test('Shift-click selects the range from the last guide clicked, in either direction', () => {
  const { app, selected } = library(guides);
  app.selectGuideFromClick('b', {}, { toggle: true });
  app.selectGuideFromClick('d', { shiftKey: true });
  assert.deepEqual(selected(), ['b', 'c', 'd']);
  app.selectGuideFromClick('a', { shiftKey: true });
  assert.deepEqual(selected(), ['a', 'b', 'c', 'd']);
});

test('select all and leaving select mode cover only guides in the current view', () => {
  const { app, selected } = library([...guides, { guideId: 'x', favorite: true }]);
  app.state.folderFilter = 'favorites';
  app.state.selectMode = true;
  app.selectAllGuides();
  assert.deepEqual(selected(), ['x']);
  app.toggleSelectMode();
  assert.equal(app.state.selectMode, false);
  assert.deepEqual(selected(), []);
});

test('keyboard context commands use the focused control position and do not intercept normal activation', () => {
  const { app } = library(guides);let opened = 0, prevented = 0, stopped = 0;
  const button = { getBoundingClientRect: () => ({ left: 30, bottom: 90 }) };
  const event = { key: 'F10', shiftKey: true, target: { closest: () => button }, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  app.libraryContextKey(event, point => { opened++;assert.equal(point.clientX, 30);assert.equal(point.clientY, 90);assert.equal(point.currentTarget, button); });
  app.libraryContextKey({ ...event, key: 'Enter', shiftKey: false }, () => assert.fail('Enter opened context actions'));
  assert.equal(opened, 1);assert.equal(prevented, 1);assert.equal(stopped, 1);
});

test('library rerenders restore the logical selection control without stealing focus from another field', () => {
  const { app, document } = library(guides);document.body = {};
  const control = key => ({ dataset: { libraryFocus: key }, focus() { document.activeElement = this; } });
  const selected = control('select:a'), filter = control('filter:all');
  app.libraryHost = { querySelectorAll: () => [selected, filter] };document.activeElement = document.body;
  app.restoreLibraryFocus('open:a');assert.equal(document.activeElement, selected);
  const search = { isConnected: true };document.activeElement = search;app.restoreLibraryFocus('open:a');assert.equal(document.activeElement, search);
  selected.disabled = true;document.activeElement = document.body;app.restoreLibraryFocus('select:a');assert.equal(document.activeElement, filter);
});
