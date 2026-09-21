'use strict';

// The public Desktop OAuth application ID belongs to StepForge, not its users.
// Stamp it into every platform's package before building a release.
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');

function configureGoogleOAuth({ clientId, file = path.join(__dirname, '..', 'app', 'google-oauth-config.json') } = {}) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = (clientId || existing.clientId || '').trim();
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(value)) {
    throw new Error('Release configuration is missing StepForge\'s Google Desktop OAuth client ID. Set the STEPFORGE_GOOGLE_CLIENT_ID repository variable before packaging.');
  }
  atomicWriteFileSync(file, JSON.stringify({ clientId: value }, null, 2) + '\n');
}

if (require.main === module) {
  try {
    configureGoogleOAuth({ clientId: process.env.STEPFORGE_GOOGLE_CLIENT_ID });
    console.log('StepForge Google sign-in configured for this build.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { configureGoogleOAuth };
