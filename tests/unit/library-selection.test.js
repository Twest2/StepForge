'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function library(guides) {
  const context = { window: {}, document: { addEventListener() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  app.state = { folderFilter: 'all', selectMode: false, selectedGuides: new Set(), selectedTrash: new Set(), library: { guides, guideFolders: {} } };
  const renders = [];
  app.renderLibrary = () => renders.push('library');
  app.renderGuideGrid = () => renders.push('grid');
  app.renderBulkBar = () => {};
  return { app, renders, selected: () => [...app.state.selectedGuides].sort() };
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
