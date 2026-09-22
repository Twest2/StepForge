'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function indicator() {
  const context = { window: {}, document: { addEventListener() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  const hidden = new Set(['hidden']);
  app.cloudStatus = {
    classList: { toggle(name, on) { if (on) hidden.add(name); else hidden.delete(name); } },
    setAttribute(name, value) { this[name] = value; },
  };
  return { render: (status) => { app.renderCloudStatus(status); return { visible: !hidden.has('hidden'), label: app.cloudStatus.textContent }; } };
}

test('the Drive indicator stays out of the top bar unless the user is signed in with sync on', () => {
  const { render } = indicator();
  assert.equal(render({ connected: false, enabled: false, phase: 'off' }).visible, false);
  // Sync was left on but the sign-in is gone: still signed out, so no indicator.
  assert.equal(render({ connected: false, enabled: true, phase: 'disconnected', error: 'Sign in to Google Drive in Settings.' }).visible, false);
  assert.equal(render({ connected: true, enabled: false, phase: 'off' }).visible, false);
  assert.deepEqual(render({ connected: true, enabled: true, phase: 'synced' }), { visible: true, label: 'Drive: synced' });
  assert.deepEqual(render({ connected: true, enabled: true, phase: 'error', message: 'Quota exceeded' }), { visible: true, label: 'Drive: needs attention' });
});
