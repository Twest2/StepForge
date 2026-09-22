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
  let onStatus;

  const context = {
    el(spec, props = {}, ...children) {
      const classes = new Set(spec.split('.').slice(1));
      const node = {
        spec,
        ...props,
        children: children.flat(),
        textContent: '',
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        },
        removeAttribute(name) { delete this[name]; },
        addEventListener(type, action) {
          this[type] = action;
        },
      };

      nodes.push(node);
      return node;
    },

    setButtonLoading() {},
  };

  const api = {
    cloud: {
      async status() {
        return current;
      },

      onStatus(callback) {
        onStatus = callback;
        return () => {};
      },

      async connect(...args) {
        passedArgs = args;
        current = {
          ...current,
          connected: true,
          email: 'test@example.com',
          enabled: true,
        };
      },

      async cancel() {},
    },
  };

  vm.createContext(context);

  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../../app/renderer/cloud.js'),
      'utf8'
    ),
    context
  );

  const result = context.makeCloudSettings(api);

  return {
    nodes,
    result,
    args: () => passedArgs,
    update: (next) => { current = next; onStatus(next); },
  };
}

test(
  'Sign in with Google connects without configuration inputs or arguments',
  async () => {
    const { nodes, result, args } = panel({
      available: true,
      connected: false,
      enabled: false,
    });

    await Promise.resolve();

    const inputs = nodes.filter((n) => n.spec === 'input');

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].type, 'checkbox');

    const connect = nodes.find((n) =>
      n.children.includes('Sign in with Google')
    );

    assert.equal(connect.disabled, false);

    await connect.onClick();

    assert.deepEqual(args(), []);
    assert.equal(inputs[0].checked, true);

    assert.ok(
      nodes.some((n) =>
        n.textContent === 'test@example.com'
      )
    );

    assert.ok(
      nodes.some((n) =>
        n.children.includes('Test connection')
      )
    );

    result.dispose();
  }
);

test(
  'unconfigured builds show an unavailable state without user credential setup',
  async () => {
    const { nodes, result } = panel({
      available: false,
      connected: false,
      enabled: false,
    });

    await Promise.resolve();

    assert.equal(
      nodes.find((n) =>
        n.children.includes('Sign in with Google')
      ).disabled,
      true
    );

    assert.ok(
      nodes.some((n) =>
        n.children.some((child) => typeof child === 'string' && child.includes('unavailable in this build'))
      )
    );

    assert.equal(
      nodes.filter(
        (n) =>
          n.spec === 'input' &&
          n.type !== 'checkbox'
      ).length,
      0
    );

    result.dispose();
  }
);

test(
  'release configuration embeds the application ID and secret and refuses missing registration',
  (t) => {
    const root = makeTmpDir('google-release');

    t.after(() => rmrf(root));

    const file = path.join(
      root,
      'google-oauth-config.json'
    );

    fs.writeFileSync(
      file,
      JSON.stringify({
        clientId: '',
        clientSecret: '',
      })
    );

    assert.throws(
      () => configureGoogleOAuth({ file }),
      /missing StepForge/
    );

    configureGoogleOAuth({
      file,
      clientId: 'official.apps.googleusercontent.com',
      clientSecret: 'test-client-secret',
    });

    assert.deepEqual(
      JSON.parse(fs.readFileSync(file)),
      {
        clientId: 'official.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
      }
    );

    // Existing stamped registration should also work.
    configureGoogleOAuth({ file });

    assert.throws(
      () =>
        configureGoogleOAuth({
          file,
          clientId: 'not-a-google-client',
          clientSecret: 'test-client-secret',
        }),
      /missing StepForge/
    );

    const saved = JSON.parse(
      fs.readFileSync(file)
    );

    assert.equal(
      saved.clientId,
      'official.apps.googleusercontent.com'
    );

    assert.equal(
      saved.clientSecret,
      'test-client-secret'
    );
  }
);

test(
  'preload exposes no credential parameters for Google sign-in',
  () => {
    let exposed;
    const calls = [];

    const context = {
      require(name) {
        assert.equal(name, 'electron');

        return {
          contextBridge: {
            exposeInMainWorld(name, api) {
              exposed = api;
            },
          },

          ipcRenderer: {
            invoke(...args) {
              calls.push(args);
            },
          },
        };
      },
    };

    vm.runInNewContext(
      fs.readFileSync(
        path.join(__dirname, '../../app/preload.js'),
        'utf8'
      ),
      context
    );

    exposed.cloud.connect({
      clientId: 'should-not-cross-ipc',
      clientSecret: 'should-not-cross-ipc',
    });

    assert.deepEqual(
      calls,
      [['cloud:connect']]
    );
  }
);


test('account avatar shows the photo, falls back on failure, and clears on disconnect', async () => {
  const initial = { available: true, connected: true, enabled: false, email: 'test@example.com',
    photoLink: 'https://lh3.googleusercontent.com/avatar' };
  const { nodes, update, result } = panel(initial);
  await Promise.resolve();
  const avatar = nodes.find((node) => node.spec === 'div.cloud-avatar');
  const [letter, photo] = avatar.children;
  assert.equal(photo.src, initial.photoLink);
  assert.equal(photo.referrerPolicy, 'no-referrer');
  assert.equal(photo.classList.contains('hidden'), false);
  assert.equal(letter.classList.contains('hidden'), true);
  photo.error();
  assert.equal(photo.classList.contains('hidden'), true);
  assert.equal(letter.classList.contains('hidden'), false);
  assert.equal(letter.textContent, 'T');
  update(initial);
  assert.equal(photo.classList.contains('hidden'), true);
  update({ ...initial, photoLink: 'https://lh3.googleusercontent.com/new-avatar' });
  assert.equal(photo.classList.contains('hidden'), false);
  update({ connected: false });
  assert.equal(photo.src, undefined);
  assert.equal(photo.classList.contains('hidden'), true);
  update({ ...initial, photoLink: '' });
  assert.equal(letter.textContent, 'T');
  assert.equal(letter.classList.contains('hidden'), false);
  result.dispose();
});
