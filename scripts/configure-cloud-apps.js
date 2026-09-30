'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const { ONEDRIVE_CLIENT_PATTERN, DROPBOX_KEY_PATTERN } = require('../app/cloud-apps');

const SETUP_HINT = ' Set the STEPFORGE_ONEDRIVE_CLIENT_ID and STEPFORGE_DROPBOX_APP_KEY repository variables'
  + ' (see docs/CLOUD_ACCOUNTS_RELEASE.md).';

// Stamps StepForge's OneDrive and Dropbox app registrations into a release
// build. Both are public identifiers; neither service needs a secret.
function configureCloudApps({
  onedriveClientId,
  dropboxAppKey,
  file = path.join(__dirname, '..', 'app', 'cloud-apps-config.json'),
} = {}) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const onedrive = (onedriveClientId || existing.onedriveClientId || '').trim();
  const dropbox = (dropboxAppKey || existing.dropboxAppKey || '').trim();

  if (!ONEDRIVE_CLIENT_PATTERN.test(onedrive)) {
    throw new Error('Release configuration is missing StepForge\'s OneDrive (Microsoft Entra) application ID.' + SETUP_HINT);
  }
  if (!DROPBOX_KEY_PATTERN.test(dropbox)) {
    throw new Error('Release configuration is missing StepForge\'s Dropbox app key.' + SETUP_HINT);
  }

  atomicWriteFileSync(file, JSON.stringify({ onedriveClientId: onedrive, dropboxAppKey: dropbox }, null, 2) + '\n');
}

if (require.main === module) {
  try {
    configureCloudApps({
      onedriveClientId: process.env.STEPFORGE_ONEDRIVE_CLIENT_ID,
      dropboxAppKey: process.env.STEPFORGE_DROPBOX_APP_KEY,
    });
    console.log('StepForge OneDrive and Dropbox sign-in configured for this build.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { configureCloudApps };
