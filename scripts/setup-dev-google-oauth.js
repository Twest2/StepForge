#!/usr/bin/env node
'use strict';

/*
 * Lets a development build sign in to Google Drive. Writes the StepForge OAuth
 * client to google-oauth.local.json at the repository root, which is gitignored
 * and outside app/, so it is never committed or packaged.
 *
 *   npm run setup:google-dev                  copy from the installed Linux release
 *   npm run setup:google-dev -- --from FILE   copy from another google-oauth-config.json
 *   STEPFORGE_GOOGLE_CLIENT_ID=… STEPFORGE_GOOGLE_CLIENT_SECRET=… npm run setup:google-dev
 *   npm run setup:google-dev -- --remove      delete the local file
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCAL_FILE = path.join(ROOT_DIR, 'google-oauth.local.json');
const INSTALLED_CONFIGS = ['/opt/stepforge/app/google-oauth-config.json'];
const CLIENT_ID = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;

// `git check-ignore` exits 0 when ignored and 1 when not. Anything else (git
// missing, not a repository, "dubious ownership") is an error, not a "no".
function isGitIgnored(file, cwd = ROOT_DIR) {
  const result = spawnSync('git', ['check-ignore', '-q', file], { cwd, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const reason = (result.error?.message || result.stderr || '').trim().split('\n')[0];
  throw new Error(`Could not check with git whether ${file} is ignored${reason ? `: ${reason}` : ''}.`);
}

function findSource({ from, env = process.env, installed = INSTALLED_CONFIGS } = {}) {
  if (from) return { ...JSON.parse(fs.readFileSync(from, 'utf8')), origin: from };
  if (env.STEPFORGE_GOOGLE_CLIENT_ID) {
    return { clientId: env.STEPFORGE_GOOGLE_CLIENT_ID, clientSecret: env.STEPFORGE_GOOGLE_CLIENT_SECRET, origin: 'environment variables' };
  }
  for (const file of installed) {
    if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), origin: file };
  }
  return null;
}

function setupDevGoogleOAuth({ from, env, installed, file = LOCAL_FILE, ignored = isGitIgnored } = {}) {
  if (!ignored(path.basename(file), path.dirname(file))) {
    throw new Error(`${path.basename(file)} is not gitignored. Refusing to write Google credentials where they could be committed.`);
  }
  const source = findSource({ from, env, installed });
  if (!source) {
    throw new Error('No StepForge Google client found. Install a StepForge release, pass --from <google-oauth-config.json>, '
      + 'or set STEPFORGE_GOOGLE_CLIENT_ID and STEPFORGE_GOOGLE_CLIENT_SECRET.');
  }
  const clientId = String(source.clientId || '').trim();
  const clientSecret = String(source.clientSecret || '').trim();
  if (!CLIENT_ID.test(clientId) || !clientSecret) {
    throw new Error(`${source.origin} does not contain a Google Desktop OAuth client ID and secret.`);
  }
  fs.writeFileSync(file, JSON.stringify({ clientId, clientSecret }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { clientId, origin: source.origin, file };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--remove')) {
      fs.rmSync(LOCAL_FILE, { force: true });
      console.log('Removed google-oauth.local.json. Development builds can no longer sign in to Google Drive.');
    } else {
      const fromIndex = args.indexOf('--from');
      const result = setupDevGoogleOAuth({ from: fromIndex >= 0 ? args[fromIndex + 1] : undefined });
      console.log(`Wrote ${path.relative(ROOT_DIR, result.file)} (gitignored) from ${result.origin}.`);
      console.log(`Client: ${result.clientId.slice(0, 6)}…${result.clientId.slice(-27)}`);
      console.log('');
      console.log('Development builds now offer "Sign in with Google". To keep your real library and');
      console.log('Drive history safe while testing, run the dev build against its own data folder:');
      console.log('');
      console.log('  STEPFORGE_DATA_DIR="$HOME/.local/share/stepforge-dev" npm start');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { setupDevGoogleOAuth, findSource, isGitIgnored };
