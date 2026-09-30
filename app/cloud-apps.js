'use strict';

const fs = require('node:fs');
const path = require('node:path');

// App registrations for OneDrive (a Microsoft Entra public client) and Dropbox
// (an app key). Both are public identifiers, not secrets: sign-in uses PKCE.
// Release builds get them stamped into cloud-apps-config.json; a source
// checkout can supply them through the environment or a gitignored
// cloud-apps.local.json at the repository root. See docs/cloud_accounts_init_setup/CLOUD_ACCOUNTS_RELEASE.md.
const LOCAL_FILE = path.join(__dirname, '..', 'cloud-apps.local.json');
const ONEDRIVE_CLIENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DROPBOX_KEY_PATTERN = /^[a-z0-9]{8,32}$/;

function resolveCloudApps({ committed = require('./cloud-apps-config.json'), env = process.env, localFile = LOCAL_FILE } = {}) {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(localFile, 'utf8')) || {}; } catch { /* none */ }
  // Each value comes from the first place that has it.
  const pick = (key, envName) => String(committed[key] || env[envName] || local[key] || '').trim();
  return {
    onedriveClientId: pick('onedriveClientId', 'STEPFORGE_ONEDRIVE_CLIENT_ID'),
    dropboxAppKey: pick('dropboxAppKey', 'STEPFORGE_DROPBOX_APP_KEY'),
  };
}

module.exports = { resolveCloudApps, ONEDRIVE_CLIENT_PATTERN, DROPBOX_KEY_PATTERN, LOCAL_FILE };
