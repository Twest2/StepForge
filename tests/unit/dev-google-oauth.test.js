'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveOAuthConfig, LOCAL_OAUTH_FILE } = require('../../app/google-drive');
const { setupDevGoogleOAuth, isGitIgnored } = require('../../scripts/setup-dev-google-oauth');
const { makeTmpDir, rmrf } = require('./helpers');

const RELEASE = { clientId: 'release.apps.googleusercontent.com', clientSecret: 'release-secret' };
const LOCAL = { clientId: 'local.apps.googleusercontent.com', clientSecret: 'local-secret' };

function tmp(t) { const dir = makeTmpDir('dev-oauth'); t.after(() => rmrf(dir)); return dir; }

test('a stamped release client always wins over local development overrides', (t) => {
  const localFile = path.join(tmp(t), 'google-oauth.local.json');
  fs.writeFileSync(localFile, JSON.stringify(LOCAL));
  const env = { STEPFORGE_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' };
  assert.deepEqual(resolveOAuthConfig({ committed: RELEASE, env, localFile }), { ...RELEASE, source: 'release' });
});

test('development builds use environment variables, then the local file, else stay unavailable', (t) => {
  const localFile = path.join(tmp(t), 'google-oauth.local.json');
  const empty = { clientId: '', clientSecret: '' };
  assert.deepEqual(resolveOAuthConfig({ committed: empty, env: {}, localFile }), { ...empty, source: 'none' });
  fs.writeFileSync(localFile, JSON.stringify(LOCAL));
  assert.deepEqual(resolveOAuthConfig({ committed: empty, env: {}, localFile }), { ...LOCAL, source: 'local' });
  const env = { STEPFORGE_GOOGLE_CLIENT_ID: ' env.apps.googleusercontent.com ', STEPFORGE_GOOGLE_CLIENT_SECRET: 'env-secret' };
  assert.deepEqual(resolveOAuthConfig({ committed: empty, env, localFile }),
    { clientId: 'env.apps.googleusercontent.com', clientSecret: 'env-secret', source: 'environment' });
});

test('the local credential file is gitignored and outside the packaged app folder', () => {
  assert.equal(path.basename(LOCAL_OAUTH_FILE), 'google-oauth.local.json');
  assert.equal(path.dirname(LOCAL_OAUTH_FILE), path.resolve(__dirname, '../..'));
  const ignored = fs.readFileSync(path.join(__dirname, '../../.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  assert.ok(ignored.includes('google-oauth.local.json'));
  assert.match(fs.readFileSync(path.join(__dirname, '../../scripts/package-windows.js'), 'utf8'), /files: \[\s*'app\/\*\*\/\*',\s*'core\/\*\*\/\*',\s*'exporters\/\*\*\/\*',\s*'package\.json',\s*\]/);
  assert.match(fs.readFileSync(path.join(__dirname, '../../packaging/linux/common/stage-runtime.sh'), 'utf8'), /for item in app core exporters package\.json package-lock\.json; do/);
});

test('the git ignore check reports ignored, not ignored, and git errors distinctly', (t) => {
  const git = spawnSync('git', ['--version']);
  if (git.status !== 0) { t.skip('git is not installed'); return; }
  const repo = tmp(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'google-oauth.local.json\n');
  assert.equal(isGitIgnored('google-oauth.local.json', repo), true);
  assert.equal(isGitIgnored('other.json', repo), false);
  assert.throws(() => isGitIgnored('google-oauth.local.json', path.join(repo, 'missing')), /Could not check with git/);
});

test('setup copies the installed release client into a private local file', (t) => {
  const dir = tmp(t);
  const installed = path.join(dir, 'google-oauth-config.json');
  fs.writeFileSync(installed, JSON.stringify(RELEASE));
  const file = path.join(dir, 'google-oauth.local.json');
  const result = setupDevGoogleOAuth({ env: {}, installed: [installed], file, ignored: () => true });
  assert.equal(result.origin, installed);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), RELEASE);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('setup refuses unignored destinations and incomplete clients', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'google-oauth.local.json');
  const env = { STEPFORGE_GOOGLE_CLIENT_ID: LOCAL.clientId, STEPFORGE_GOOGLE_CLIENT_SECRET: LOCAL.clientSecret };
  assert.throws(() => setupDevGoogleOAuth({ env, installed: [], file, ignored: () => false }), /not gitignored/);
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => setupDevGoogleOAuth({ env: {}, installed: [], file, ignored: () => true }), /No StepForge Google client found/);
  assert.throws(() => setupDevGoogleOAuth({ env: { STEPFORGE_GOOGLE_CLIENT_ID: LOCAL.clientId }, installed: [], file, ignored: () => true }),
    /does not contain a Google Desktop OAuth client ID and secret/);
});
