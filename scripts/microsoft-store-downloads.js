#!/usr/bin/env node
'use strict';

// Writes the README's Microsoft Store downloads badge: a shields.io endpoint
// file with StepForge's total Store acquisitions. Microsoft publishes no
// public count, so this reads Partner Center's analytics API with the Entra
// app the release uses (MICROSOFT_STORE_TENANT_ID, MICROSOFT_STORE_CLIENT_ID,
// MICROSOFT_STORE_CLIENT_SECRET). The sort-download-badges workflow runs it
// daily and keeps the file on the badges branch.
//
//   node scripts/microsoft-store-downloads.js <output.json>

const fs = require('node:fs');
const path = require('node:path');

const { readProductId } = require('./publish-microsoft-store');

const BADGE_BRANCH = 'badges';
const BADGE_FILE = 'microsoft-store-downloads.json';
const LABEL = 'Microsoft Store downloads';
const RESOURCE = 'https://manage.devcenter.microsoft.com';
const ACQUISITIONS_URL = `${RESOURCE}/v1.0/my/analytics/appacquisitions`;
// Before StepForge was in the Store, so the range covers every acquisition.
const FIRST_DAY = '2026-01-01';

const CREDENTIALS = ['MICROSOFT_STORE_TENANT_ID', 'MICROSOFT_STORE_CLIENT_ID', 'MICROSOFT_STORE_CLIENT_SECRET'];

function readCredentials(env = process.env) {
  const missing = CREDENTIALS.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Set ${missing.join(', ')} to read Microsoft Store downloads.`);
  const [tenantId, clientId, clientSecret] = CREDENTIALS.map((name) => env[name].trim());
  return { tenantId, clientId, clientSecret };
}

async function getAccessToken({ tenantId, clientId, clientSecret }, fetchImpl = fetch) {
  const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, resource: RESOURCE }).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Partner Center sign-in failed: HTTP ${response.status}${body.error ? ` ${body.error}` : ''}`);
  }
  return body.access_token;
}

// The analytics API answers with "Value" and "@nextLink"; read them without case.
function prop(object, name) {
  const key = object && Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

/** Every Store acquisition of the app, summed over monthly rows. */
async function totalAcquisitions({ token, productId, today = new Date(), fetchImpl = fetch }) {
  const params = new URLSearchParams({
    applicationId: productId,
    startDate: FIRST_DAY,
    endDate: today.toISOString().slice(0, 10),
    aggregationLevel: 'month',
    top: '10000',
  });
  let url = `${ACQUISITIONS_URL}?${params}`;
  let total = 0;
  for (let page = 0; url; page += 1) {
    if (page >= 100) throw new Error('Partner Center kept returning more acquisition pages.');
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Reading Microsoft Store acquisitions failed: HTTP ${response.status}`);
    const body = await response.json();
    for (const row of prop(body, 'Value') || []) {
      const quantity = prop(row, 'acquisitionQuantity');
      if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`Unexpected acquisition row: ${JSON.stringify(row)}`);
      total += quantity;
    }
    const next = prop(body, '@nextLink');
    url = next ? new URL(next, url).toString() : null;
  }
  return total;
}

/** The shields.io endpoint badge (https://shields.io/badges/endpoint-badge). */
function badgeJson(count) {
  return { schemaVersion: 1, label: LABEL, message: String(count), color: 'blue' };
}

async function writeBadge(output, { env = process.env, fetchImpl = fetch, today, identityFile } = {}) {
  const credentials = readCredentials(env);
  const productId = readProductId(identityFile);
  const token = await getAccessToken(credentials, fetchImpl);
  const count = await totalAcquisitions({ token, productId, today, fetchImpl });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(badgeJson(count))}\n`);
  return count;
}

if (require.main === module) {
  const output = process.argv[2];
  if (!output) {
    console.error('Usage: node scripts/microsoft-store-downloads.js <output.json>');
    process.exitCode = 2;
  } else {
    writeBadge(path.resolve(output)).then(
      (count) => console.log(`${LABEL}: ${count}`),
      (err) => {
        console.error(err.message || err);
        process.exitCode = 1;
      },
    );
  }
}

module.exports = {
  BADGE_BRANCH,
  BADGE_FILE,
  LABEL,
  FIRST_DAY,
  readCredentials,
  getAccessToken,
  totalAcquisitions,
  badgeJson,
  writeBadge,
};
