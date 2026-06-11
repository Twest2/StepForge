'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Wiring guard: every IPC channel the renderer can invoke through the
 * preload bridge must have a handler registered in the main process, and
 * renderer code must only call APIs the bridge actually exposes. This
 * compares extracted channel/identifier sets — it exercises the real
 * contract between the three layers rather than matching arbitrary text.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function invokeChannels(src) {
  return new Set([...src.matchAll(/invoke\('([^']+)'\)/g)].map((m) => m[1]));
}

function handledChannels(src) {
  return new Set([...src.matchAll(/\bh\('([^']+)'/g)].map((m) => m[1]));
}

test('every preload invoke channel has a main-process handler', () => {
  const preload = invokeChannels(read('app/preload.js'));
  const handlers = handledChannels(read('app/main.js'));
  assert.ok(preload.size >= 30, `expected a substantial API surface, got ${preload.size}`);
  const missing = [...preload].filter((ch) => !handlers.has(ch));
  assert.deepEqual(missing, [], `preload channels without handlers: ${missing.join(', ')}`);
});

test('renderer api.* usage stays within the preload surface', () => {
  // Build the exposed api shape from preload.js: top-level groups and members.
  const preloadSrc = read('app/preload.js');
  const apiBody = preloadSrc.slice(preloadSrc.indexOf('const api = {'));
  const groups = new Map();
  let currentGroup = null;
  for (const line of apiBody.split('\n')) {
    const g = /^  (\w+): \{/.exec(line);
    if (g) { currentGroup = g[1]; groups.set(currentGroup, new Set()); continue; }
    const member = /^    (\w+):/.exec(line);
    if (member && currentGroup) groups.get(currentGroup).add(member[1]);
    if (/^  \},/.test(line)) currentGroup = null;
  }
  assert.ok(groups.size >= 10, 'preload should expose multiple API groups');

  // Every api.<group>.<member>( call in renderer code must exist.
  const offenders = [];
  for (const file of ['app.js', 'editor.js', 'dialogs.js']) {
    const src = read(`app/renderer/${file}`);
    for (const m of src.matchAll(/\bapi\.(\w+)\.(\w+)\(/g)) {
      const [, group, member] = m;
      if (!groups.has(group) || !groups.get(group).has(member)) {
        offenders.push(`${file}: api.${group}.${member}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `renderer calls missing from preload: ${offenders.join(', ')}`);
});

test('renderer dialogs.* usage matches the StepForgeDialogs export', () => {
  const dialogsSrc = read('app/renderer/dialogs.js');
  const exportBlock = /window\.StepForgeDialogs = \{([\s\S]*?)\};/.exec(dialogsSrc)[1];
  const exported = new Set([...exportBlock.matchAll(/(\w+),/g)].map((m) => m[1]));

  const offenders = [];
  for (const file of ['app.js', 'editor.js']) {
    const src = read(`app/renderer/${file}`);
    for (const m of src.matchAll(/\bdialogs\.(\w+)\(/g)) {
      if (!exported.has(m[1])) offenders.push(`${file}: dialogs.${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `dialog calls missing from export: ${offenders.join(', ')}`);
});
