'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { GuideStore } = require('../../core/store');
const { SearchIndex } = require('../../core/search');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function buildLibrary(root) {
  const store = new GuideStore(root);
  const index = new SearchIndex(store.indexDir);

  const vpn = store.createGuide({
    title: 'Install the VPN client',
    descriptionHtml: '<p>Corporate network access</p>',
    placeholders: { Department: 'Infrastructure' },
  });
  store.addStep(vpn.guideId, { title: 'Download installer from portal' }, TINY_PNG, { width: 1, height: 1 });
  store.addStep(vpn.guideId, {
    kind: 'content',
    title: 'Configure split tunneling',
    descriptionHtml: '<p>Set the <b>gateway</b> to vpn.example.com</p>',
    codeBlocks: [{ id: 'cb1', language: 'bash', code: 'sudo systemctl restart openvpn' }],
  });

  const pw = store.createGuide({ title: 'Reset user password' });
  store.addStep(pw.guideId, {
    title: 'Open admin console',
    textBlocks: [{ title: 'Permissions', descriptionHtml: '<p>Requires the helpdesk role</p>', level: 'warn' }],
  });

  index.indexGuide(store.getGuide(vpn.guideId), store.listSteps(vpn.guideId));
  index.indexGuide(store.getGuide(pw.guideId), store.listSteps(pw.guideId));
  return { store, index, vpn, pw };
}

test('full-text search finds guides and deep-links steps by body content', (t) => {
  const root = makeTmpDir('search');
  t.after(() => rmrf(root));
  const { index, vpn, pw } = buildLibrary(root);

  // Body text inside a code block is searchable and points at the step.
  const codeHits = index.search('openvpn');
  assert.equal(codeHits.length, 1);
  assert.equal(codeHits[0].guideId, vpn.guideId);
  assert.ok(codeHits[0].stepId, 'code block hit should deep-link to its step');
  assert.ok(codeHits[0].snippet.includes('systemctl restart openvpn'));

  // Text block content is searchable too.
  const tbHits = index.search('helpdesk');
  assert.equal(tbHits.length, 1);
  assert.equal(tbHits[0].guideId, pw.guideId);

  // Placeholder values are indexed at guide level.
  const phHits = index.search('Infrastructure');
  assert.ok(phHits.some((h) => h.guideId === vpn.guideId && h.stepId === null));
});

test('multi-token AND queries and prefix matching on the last token', (t) => {
  const root = makeTmpDir('search2');
  t.after(() => rmrf(root));
  const { index, vpn } = buildLibrary(root);

  // Both tokens must match the same document.
  assert.equal(index.search('split tunneling').length, 1);
  assert.equal(index.search('split helpdesk').length, 0);

  // Search-as-you-type: trailing token matches as a prefix.
  const typed = index.search('tunn');
  assert.equal(typed.length, 1);
  assert.equal(typed[0].guideId, vpn.guideId);

  // Title hits outrank body hits.
  const ranked = index.search('vpn');
  assert.equal(ranked[0].title, 'Install the VPN client');
});

test('index survives reload from disk and removal works', (t) => {
  const root = makeTmpDir('search3');
  t.after(() => rmrf(root));
  const { store, vpn, pw } = buildLibrary(root);

  const reloaded = new SearchIndex(store.indexDir);
  assert.ok(reloaded.search('password').some((h) => h.guideId === pw.guideId));

  reloaded.removeGuide(vpn.guideId);
  assert.equal(reloaded.search('tunneling').length, 0);
  // Removal persisted: a fresh instance agrees.
  assert.equal(new SearchIndex(store.indexDir).search('tunneling').length, 0);
});

test('re-indexing a changed guide replaces stale content', (t) => {
  const root = makeTmpDir('search4');
  t.after(() => rmrf(root));
  const { store, index, vpn } = buildLibrary(root);

  const guide = store.getGuide(vpn.guideId);
  guide.title = 'Install the ZeroTrust agent';
  store.saveGuide(guide);
  index.indexGuide(store.getGuide(vpn.guideId), store.listSteps(vpn.guideId));

  assert.equal(index.searchTitles('vpn').length, 0, 'old title must be gone');
  assert.equal(index.searchTitles('zerotrust').length, 1);

  // titles-only search excludes step-level matches.
  assert.equal(index.searchTitles('gateway').length, 0);
  assert.ok(index.search('gateway').length >= 1);
});
