'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const { CLIENT_ID_PATTERN, APP_SLUG_PATTERN } = require('../app/github-pages');

const SETUP_HINT = ' Set the STEPFORGE_GITHUB_CLIENT_ID and STEPFORGE_GITHUB_APP_SLUG repository variables'
  + ' (see docs/cloud_accounts_init_setup/GITHUB_PAGES_RELEASE.md).';

function configureGitHubApp({
  clientId,
  appSlug,
  file = path.join(__dirname, '..', 'app', 'github-app-config.json')
} = {}) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));

  const id = (clientId || existing.clientId || '').trim();
  const slug = (appSlug || existing.appSlug || '').trim();

  if (!CLIENT_ID_PATTERN.test(id)) {
    throw new Error('Release configuration is missing StepForge\'s GitHub App client ID.' + SETUP_HINT);
  }

  if (!APP_SLUG_PATTERN.test(slug)) {
    throw new Error('Release configuration is missing StepForge\'s GitHub App slug.' + SETUP_HINT);
  }

  atomicWriteFileSync(
    file,
    JSON.stringify({
      clientId: id,
      appSlug: slug
    }, null, 2) + '\n'
  );
}

if (require.main === module) {
  try {
    configureGitHubApp({
      clientId: process.env.STEPFORGE_GITHUB_CLIENT_ID,
      appSlug: process.env.STEPFORGE_GITHUB_APP_SLUG
    });

    console.log('StepForge GitHub sign-in configured for this build.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { configureGitHubApp };
