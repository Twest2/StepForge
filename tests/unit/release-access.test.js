'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkReleaseAccess } = require('../../scripts/check-release-access');

const ownerRun = { GITHUB_REPOSITORY_OWNER: 'Twest2', GITHUB_ACTOR: 'Twest2', GITHUB_TRIGGERING_ACTOR: 'Twest2' };

test('the owner can dispatch and rerun a release, with case-insensitive GitHub logins', () => {
  assert.doesNotThrow(() => checkReleaseAccess(ownerRun));
  assert.doesNotThrow(() => checkReleaseAccess({ ...ownerRun, GITHUB_ACTOR: 'twest2' }));
});

test('another actor cannot dispatch or rerun a release, even when the other actor is the owner', () => {
  assert.throws(() => checkReleaseAccess({ ...ownerRun, GITHUB_ACTOR: 'someone-else' }), /Only the repository owner/);
  assert.throws(() => checkReleaseAccess({ ...ownerRun, GITHUB_TRIGGERING_ACTOR: 'someone-else' }), /Only the repository owner/);
  for (const key of Object.keys(ownerRun)) {
    assert.throws(() => checkReleaseAccess({ ...ownerRun, [key]: '' }), /Only the repository owner/);
  }
});

test('every release build requires authorization and only the publisher receives write access', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /run: node scripts\/check-release-access\.js/);
  for (const job of ['build-windows', 'build-linux', 'build-fedora']) {
    assert.ok(workflow.includes(`  ${job}:\n    needs: authorize-release\n`));
  }
  assert.match(workflow, /  release:\n    permissions:\n      contents: write/);
  assert.equal((workflow.match(/run: node scripts\/check-release-access\.js/g) || []).length, 8, 'every job rechecks the rerun actor');
});
