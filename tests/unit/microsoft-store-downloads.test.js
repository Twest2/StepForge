'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { readProductId } = require('../../scripts/publish-microsoft-store');
const {
  BADGE_BRANCH,
  BADGE_FILE,
  FIRST_DAY,
  readCredentials,
  getAccessToken,
  totalAcquisitions,
  badgeJson,
  writeBadge,
} = require('../../scripts/microsoft-store-downloads');

/**
 * The README's Microsoft Store downloads badge
 * (scripts/microsoft-store-downloads.js and the sort-download-badges
 * workflow). Partner Center is replaced by a stand-in fetch.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ENV = {
  MICROSOFT_STORE_TENANT_ID: 'tenant-guid',
  MICROSOFT_STORE_CLIENT_ID: 'client-guid',
  MICROSOFT_STORE_CLIENT_SECRET: 'client~secret',
};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Answers the token request, then the given acquisition pages in order. */
function partnerCenter(pages) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: 'tok', token_type: 'Bearer' });
    return json(200, pages.shift());
  };
  return { fetchImpl, requests };
}

test('signing in uses the client-credentials grant for the Partner Center API', async () => {
  const { fetchImpl, requests } = partnerCenter([]);
  assert.equal(await getAccessToken(readCredentials(ENV), fetchImpl), 'tok');
  const [{ url, options }] = requests;
  assert.equal(url, 'https://login.microsoftonline.com/tenant-guid/oauth2/token');
  assert.equal(options.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
    grant_type: 'client_credentials',
    client_id: 'client-guid',
    client_secret: 'client~secret',
    resource: 'https://manage.devcenter.microsoft.com',
  });
});

test('a refused sign-in reports the status and error code, never the secret', async () => {
  const fetchImpl = async () => json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret.' });
  await assert.rejects(getAccessToken(readCredentials(ENV), fetchImpl), (err) => {
    assert.equal(err.message, 'Partner Center sign-in failed: HTTP 401 invalid_client');
    return true;
  });
  assert.throws(() => readCredentials({ ...ENV, MICROSOFT_STORE_CLIENT_SECRET: ' ' }), /^Error: Set MICROSOFT_STORE_CLIENT_SECRET to read/);
});

test('every acquisition since before launch is added up, across pages', async () => {
  const { fetchImpl, requests } = partnerCenter([
    { Value: [{ date: '2026-10-01', acquisitionQuantity: 12 }, { date: '2026-11-01', acquisitionQuantity: 3 }], '@nextLink': 'appacquisitions?applicationId=9NDH81CF1HGV&skip=2', TotalCount: 3 },
    { value: [{ date: '2026-12-01', acquisitionQuantity: 4 }], TotalCount: 3 },
  ]);
  const total = await totalAcquisitions({ token: 'tok', productId: '9NDH81CF1HGV', today: new Date('2026-12-15T10:00:00Z'), fetchImpl });
  assert.equal(total, 19);

  const first = new URL(requests[0].url);
  assert.equal(first.origin + first.pathname, 'https://manage.devcenter.microsoft.com/v1.0/my/analytics/appacquisitions');
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    applicationId: '9NDH81CF1HGV', startDate: FIRST_DAY, endDate: '2026-12-15', aggregationLevel: 'month', top: '10000',
  });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer tok');
  // A relative next link continues from the same endpoint.
  assert.equal(requests[1].url, 'https://manage.devcenter.microsoft.com/v1.0/my/analytics/appacquisitions?applicationId=9NDH81CF1HGV&skip=2');
  assert.ok(FIRST_DAY < '2026-10-01', 'the range starts before StepForge was in the Store');
});

test('an app without acquisitions counts zero; a bad row or failed page aborts', async () => {
  assert.equal(await totalAcquisitions({ token: 't', productId: 'X', fetchImpl: partnerCenter([{ Value: [] }]).fetchImpl }), 0);
  await assert.rejects(
    totalAcquisitions({ token: 't', productId: 'X', fetchImpl: partnerCenter([{ Value: [{ acquisitionQuantity: 'many' }] }]).fetchImpl }),
    /Unexpected acquisition row/,
  );
  await assert.rejects(totalAcquisitions({ token: 't', productId: 'X', fetchImpl: async () => json(403, {}) }), /HTTP 403/);
});

test('the badge file is a shields.io endpoint badge for the Store ID in identity.json', async () => {
  assert.deepEqual(badgeJson(42), { schemaVersion: 1, label: 'Microsoft Store downloads', message: '42', color: 'blue' });
  const dir = makeTmpDir('store-downloads');
  try {
    const { fetchImpl, requests } = partnerCenter([{ Value: [{ acquisitionQuantity: 8 }] }]);
    const output = path.join(dir, 'badges', BADGE_FILE);
    assert.equal(await writeBadge(output, { env: ENV, fetchImpl }), 8);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), badgeJson(8));
    assert.equal(new URL(requests[1].url).searchParams.get('applicationId'), readProductId());
  } finally {
    rmrf(dir);
  }
});

test('the README badge reads the file the workflow keeps on the badges branch', () => {
  const readme = read('README.md');
  const img = /<img alt="Microsoft Store downloads" src="([^"]+)">/.exec(readme);
  assert.ok(img, 'the README has the badge');
  const src = new URL(img[1].replace(/&amp;/g, '&'));
  assert.equal(src.origin + src.pathname, 'https://img.shields.io/endpoint');
  assert.equal(src.searchParams.get('url'), `https://raw.githubusercontent.com/Twest2/StepForge/${BADGE_BRANCH}/${BADGE_FILE}`);
});

test('the daily workflow refreshes the count, rebuilds the branch, then sorts', () => {
  const workflow = read('.github/workflows/sort-download-badges.yml');
  const store = workflow.split('\n  microsoft-store:\n')[1].split('\n  sort:\n')[0];
  const sort = workflow.split('\n  sort:\n')[1];
  for (const name of ['TENANT_ID', 'CLIENT_ID']) {
    assert.match(store, new RegExp(`MICROSOFT_STORE_${name}: \\$\\{\\{ vars\\.MICROSOFT_STORE_${name} \\}\\}\\n`));
  }
  assert.match(store, /MICROSOFT_STORE_CLIENT_SECRET: \$\{\{ secrets\.MICROSOFT_STORE_CLIENT_SECRET \}\}\n/);
  assert.match(store, new RegExp(`node scripts/microsoft-store-downloads\\.js "\\$RUNNER_TEMP/badges/${BADGE_FILE.replace('.', '\\.')}"`));
  // One parentless commit, force-pushed: the branch never grows and comes back if deleted.
  assert.match(store, /git commit-tree "\$tree" -m /);
  assert.doesNotMatch(store, /commit-tree [^\n]*-p /);
  assert.match(store, new RegExp(`git push --force origin "\\$commit:refs/heads/${BADGE_BRANCH}"`));
  assert.match(store, new RegExp(`git fetch --quiet --depth=1 origin refs/heads/${BADGE_BRANCH}`));
  assert.match(sort, /needs: microsoft-store\n/);
  assert.match(sort, /if: \$\{\{ !cancelled\(\) \}\}\n/);
  assert.match(workflow, /schedule:\n\s+- cron: /);
  assert.match(workflow, /workflow_dispatch:/);
});
