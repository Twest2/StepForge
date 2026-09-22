'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');

function configureGoogleOAuth({
  clientId,
  clientSecret,
  file = path.join(__dirname, '..', 'app', 'google-oauth-config.json')
} = {}) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));

  const id = (clientId || existing.clientId || '').trim();
  const secret = (clientSecret || existing.clientSecret || '').trim();

  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error(
      'Release configuration is missing StepForge\'s Google Desktop OAuth client ID.'
    );
  }

  if (!secret) {
    throw new Error(
      'Release configuration is missing StepForge\'s Google Desktop OAuth client secret.'
    );
  }

  atomicWriteFileSync(
    file,
    JSON.stringify({
      clientId: id,
      clientSecret: secret
    }, null, 2) + '\n'
  );
}

if (require.main === module) {
  try {
    configureGoogleOAuth({
      clientId: process.env.STEPFORGE_GOOGLE_CLIENT_ID,
      clientSecret: process.env.STEPFORGE_GOOGLE_CLIENT_SECRET
    });

    console.log('StepForge Google sign-in configured for this build.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { configureGoogleOAuth };
