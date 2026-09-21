'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { configureGoogleOAuth } = require('../../scripts/configure-google-oauth');
const { makeTmpDir, rmrf } = require('./helpers');

function panel(initial) {
  const nodes = [];
  let current = initial;
  let passedArgs;
  const context = {
    el(spec, props = {}, ...children) {
      const node = { spec, ...props, children: children.flat(), textContent: '', classList: { add() {}, remove() {}, toggle() {} }, addEventListener(type, action) { this[type] = action; } };
      nodes.push(node); return node;
    },
    setButtonLoading() {},
  };
  const api = { cloud: {
    async status() { return current; },
    onStatus() { return () => {}; },
    async connect(...args) { passedArgs = args; current = { ...current, connected: true, email: 'test@example.com', enabled: true }; },
    async cancel() {},
  } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/cloud.js'), 'utf8'), context);
  const result = context.makeCloudSettings(api);
  return { nodes, result, args: () => passedArgs };
}

test('Sign in with Google connects without configuration inputs or arguments', async () => {
  const { nodes, result, args } = panel({ available: true, connected: false, enabled: false });
  await Promise.resolve();
  const inputs = nodes.filter((n) => n.spec === 'input');
  assert.equal(inputs.length, 1); assert.equal(inputs[0].type, 'checkbox');
  const connect = nodes.find((n) => n.children.includes('Sign in with Google'));
  assert.equal(connect.disabled, false);
  await connect.onClick();
  assert.deepEqual(args(), []);
  assert.equal(inputs[0].checked, true);
  assert.ok(nodes.some((n) => n.textContent.includes('Connected as test@example.com')));
  assert.ok(nodes.some((n) => n.children.includes('Test Google Drive connection')));
  result.dispose();
});

test('unconfigured builds show an unavailable state without user credential setup', async () => {
  const { nodes, result } = panel({ available: false, connected: false, enabled: false });
  await Promise.resolve();
  assert.equal(nodes.find((n) => n.children.includes('Sign in with Google')).disabled, true);
  assert.ok(nodes.some((n) => n.textContent.includes('unavailable in this build')));
  assert.equal(nodes.filter((n) => n.spec === 'input' && n.type !== 'checkbox').length, 0);
  result.dispose();
});

test('release configuration embeds the application ID and refuses missing registration', (t) => {
  const root = makeTmpDir('google-release'); t.after(() => rmrf(root));
  const file = path.join(root, 'google-oauth-config.json');
  fs.writeFileSync(file, JSON.stringify({ clientId: '' }));
  assert.throws(() => configureGoogleOAuth({ file }), /missing StepForge/);
  configureGoogleOAuth({ file, clientId: 'official.apps.googleusercontent.com' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { clientId: 'official.apps.googleusercontent.com' });
  configureGoogleOAuth({ file }); // Committed public registration also works.
  assert.throws(() => configureGoogleOAuth({ file, clientId: 'not-a-google-client' }), /missing StepForge/);
  assert.equal(JSON.parse(fs.readFileSync(file)).clientId, 'official.apps.googleusercontent.com');
});

test('preload exposes no credential parameters for Google sign-in', () => {
  let exposed;
  const calls = [];
  const context = { require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, api) { exposed = api; } }, ipcRenderer: { invoke(...args) { calls.push(args); } } };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/preload.js'), 'utf8'), context);
  exposed.cloud.connect({ clientId: 'should-not-cross-ipc' });
  assert.deepEqual(calls, [['cloud:connect']]);
});
