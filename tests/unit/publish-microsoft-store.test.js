'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const {
  findStorePackage,
  uploadName,
  readProductId,
  reconfigureArgs,
  isAlreadySubmitted,
  retirePreviousPackages,
  publishToStore,
} = require('../../scripts/publish-microsoft-store');

/**
 * Submitting a release's Store package to Partner Center
 * (scripts/publish-microsoft-store.js). msstore is replaced by a stand-in
 * that records each command and answers "submission get" like the CLI does.
 */

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const ENV = {
  MICROSOFT_STORE_TENANT_ID: 'tenant-guid',
  MICROSOFT_STORE_SELLER_ID: '12345678',
  MICROSOFT_STORE_CLIENT_ID: 'client-guid',
  MICROSOFT_STORE_CLIENT_SECRET: 'client~secret',
};

// The live submission after the first release, which was uploaded by hand.
const published = () => ({
  Id: '1152921505700000001',
  Status: 'Published',
  Pricing: { PriceId: 'Free' },
  ApplicationPackages: [
    { FileName: 'StepForge 1.5.3 Microsoft Store.appx', FileStatus: 'Uploaded', Id: '1', Version: '1.5.300.0', Architecture: 'X64' },
  ],
});

async function withPackage(name, fn) {
  const dir = makeTmpDir('store-submit');
  try {
    fs.writeFileSync(path.join(dir, name), 'appx bytes');
    return await fn(dir);
  } finally {
    rmrf(dir);
  }
}

/** A stand-in for msstore. `afterPublish` is the draft "msstore publish --noCommit" leaves. */
function fakeMsstore({ current = published(), afterPublish } = {}) {
  const calls = [];
  let submission = current;
  const run = (args) => {
    const call = { args };
    calls.push(call);
    if (args[0] === 'publish') {
      call.uploaded = fs.readFileSync(args[1], 'utf8');
      submission = afterPublish ?? {
        ...published(),
        Id: '1152921505700000002',
        Status: 'PendingCommit',
        ApplicationPackages: [...published().ApplicationPackages, { FileName: path.basename(args[1]), FileStatus: 'PendingUpload' }],
      };
    }
    if (args[0] === 'submission' && args[1] === 'get') return JSON.stringify(submission);
    if (args[0] === 'submission' && args[1] === 'update') call.payload = JSON.parse(fs.readFileSync(args[4], 'utf8'));
    return '';
  };
  return { run, calls, commands: () => calls.map((c) => c.args.slice(0, c.args[0] === 'submission' ? 2 : 1).join(' ')) };
}

test('the Store package is found by the name the Store build gives it', async () => {
  await withPackage('StepForge 1.6.0 Microsoft Store.appx', (dir) => {
    assert.deepEqual(findStorePackage(dir), { file: path.join(dir, 'StepForge 1.6.0 Microsoft Store.appx'), buildVersion: '1.6.0', version: '1.6.0.0' });
  });
  await withPackage('StepForge 1.5.3.1 Microsoft Store.appx', (dir) => assert.equal(findStorePackage(dir).version, '1.5.301.0'));
  await withPackage('StepForge Setup 1.6.0.exe', (dir) => assert.throws(() => findStorePackage(dir), /exactly one Microsoft Store \.appx/));
  await withPackage('Other 1.6.0.appx', (dir) => assert.throws(() => findStorePackage(dir), /Unexpected Microsoft Store package name/));
  await withPackage('StepForge 1.6.0 Microsoft Store.appx', (dir) => {
    fs.writeFileSync(path.join(dir, 'StepForge 1.5.3 Microsoft Store.appx'), '');
    assert.throws(() => findStorePackage(dir), /found 2/);
  });
  assert.throws(() => findStorePackage(path.join(root, 'no-such-folder')), /found 0/);
  // package-windows-store.js names it so.
  assert.match(read('scripts/package-windows-store.js'), /artifactName: '\$\{productName\} \$\{buildVersion\} Microsoft Store\.\$\{ext\}'/);
});

test('the package is uploaded as .msix, the only extension the CLI takes', () => {
  assert.equal(uploadName('1.6.0.0'), 'StepForge_1.6.0.0_x64.msix');
});

test('the Store ID comes from identity.json', () => {
  assert.match(readProductId(), /^9[0-9A-Z]{11}$/);
  const dir = makeTmpDir('store-identity');
  try {
    const file = path.join(dir, 'identity.json');
    fs.writeFileSync(file, JSON.stringify({ productId: '' }));
    assert.throws(() => readProductId(file), /no Store ID/);
  } finally {
    rmrf(dir);
  }
});

test('signing in needs all four Partner Center credentials and says which are missing', () => {
  assert.deepEqual(reconfigureArgs(ENV), [
    'reconfigure', '--tenantId', 'tenant-guid', '--sellerId', '12345678', '--clientId', 'client-guid', '--clientSecret', 'client~secret',
  ]);
  assert.throws(() => reconfigureArgs({ ...ENV, MICROSOFT_STORE_CLIENT_SECRET: '' }), (err) => {
    assert.match(err.message, /^Set MICROSOFT_STORE_CLIENT_SECRET to submit/);
    return true;
  });
  assert.throws(() => reconfigureArgs({}), /MICROSOFT_STORE_TENANT_ID, MICROSOFT_STORE_SELLER_ID, MICROSOFT_STORE_CLIENT_ID, MICROSOFT_STORE_CLIENT_SECRET/);
});

test('a release replaces the live package and commits the submission', async () => {
  await withPackage('StepForge 1.6.0 Microsoft Store.appx', async (dir) => {
    const store = fakeMsstore();
    const result = await publishToStore({ dir, env: ENV, run: store.run, log: () => {} });

    assert.deepEqual(result, { submitted: true, version: '1.6.0.0' });
    assert.deepEqual(store.commands(), ['reconfigure', 'submission get', 'publish', 'submission get', 'submission update', 'submission publish', 'submission poll']);
    const productId = readProductId();
    const publish = store.calls[2];
    assert.equal(path.basename(publish.args[1]), 'StepForge_1.6.0.0_x64.msix');
    assert.equal(publish.uploaded, 'appx bytes', 'the .appx is uploaded unchanged');
    assert.deepEqual(publish.args.slice(2), ['--appId', productId, '--noCommit']);
    assert.deepEqual(store.calls[4].args.slice(2, 4), [productId, '--payload']);
    assert.deepEqual(store.calls[4].payload.ApplicationPackages.map((p) => [p.FileName, p.FileStatus]), [
      ['StepForge 1.5.3 Microsoft Store.appx', 'PendingDelete'],
      ['StepForge_1.6.0.0_x64.msix', 'PendingUpload'],
    ]);
    // The rest of the submission goes back as the CLI gave it.
    assert.deepEqual(store.calls[4].payload.Pricing, { PriceId: 'Free' });
    assert.ok(!fs.existsSync(publish.args[1]), 'the renamed copy is cleaned up');
  });
});

test('a rerun leaves a version that is in certification or live alone', async () => {
  for (const Status of ['Certification', 'Published']) {
    await withPackage('StepForge 1.5.3 Microsoft Store.appx', async (dir) => {
      const store = fakeMsstore({ current: { ...published(), Status } });
      const result = await publishToStore({ dir, env: ENV, run: store.run, log: () => {} });
      assert.deepEqual(result, { submitted: false, version: '1.5.300.0' });
      assert.deepEqual(store.commands(), ['reconfigure', 'submission get']);
    });
  }
});

test('a failed or uncommitted submission of the same version is submitted again', () => {
  for (const Status of ['PendingCommit', 'CommitFailed', 'CertificationFailed', 'PreProcessingFailed', 'Canceled']) {
    assert.equal(isAlreadySubmitted({ ...published(), Status }, '1.5.300.0'), false, Status);
  }
  assert.equal(isAlreadySubmitted(published(), '1.6.0.0'), false, 'a newer version');
  // The CLI writes PascalCase, the Partner Center API camelCase.
  assert.equal(isAlreadySubmitted({ status: 'Certification', applicationPackages: [{ version: '1.6.0.0', fileStatus: 'Uploaded' }] }, '1.6.0.0'), true);
});

test('only the new upload is left in the submission', () => {
  const draft = {
    Status: 'PendingCommit',
    ApplicationPackages: [
      { FileName: 'StepForge 1.5.3 Microsoft Store.appx', FileStatus: 'Uploaded' },
      { FileName: 'StepForge_1.5.301.0_x64.msix', FileStatus: 'PendingDelete' },
      { FileName: 'StepForge_1.5.302.0_x64.msix', FileStatus: 'PendingUpload' },
      { FileName: 'StepForge_1.6.0.0_x64.msix', FileStatus: 'PendingUpload' },
    ],
  };
  assert.deepEqual(retirePreviousPackages(draft, 'StepForge_1.6.0.0_x64.msix'), ['StepForge 1.5.3 Microsoft Store.appx']);
  assert.deepEqual(draft.ApplicationPackages.map((p) => [p.FileName, p.FileStatus]), [
    ['StepForge 1.5.3 Microsoft Store.appx', 'PendingDelete'],
    ['StepForge_1.5.301.0_x64.msix', 'PendingDelete'],
    ['StepForge_1.6.0.0_x64.msix', 'PendingUpload'],
  ]);

  const camel = { applicationPackages: [{ fileName: 'old.appx', fileStatus: 'Uploaded' }, { fileName: 'new.msix', fileStatus: 'PendingUpload' }] };
  retirePreviousPackages(camel, 'new.msix');
  assert.deepEqual(camel, { applicationPackages: [{ fileName: 'old.appx', fileStatus: 'PendingDelete' }, { fileName: 'new.msix', fileStatus: 'PendingUpload' }] });

  assert.throws(() => retirePreviousPackages(published(), 'StepForge_1.6.0.0_x64.msix'), /no StepForge_1\.6\.0\.0_x64\.msix waiting/);
});

test('the submission stops before committing when the upload is missing from the draft', async () => {
  await withPackage('StepForge 1.6.0 Microsoft Store.appx', async (dir) => {
    const store = fakeMsstore({ afterPublish: { ...published(), Status: 'PendingCommit' } });
    await assert.rejects(publishToStore({ dir, env: ENV, run: store.run, log: () => {} }), /no StepForge_1\.6\.0\.0_x64\.msix waiting/);
    assert.ok(!store.commands().includes('submission publish'));
  });
});

test('missing credentials fail before msstore runs', async () => {
  await withPackage('StepForge 1.6.0 Microsoft Store.appx', async (dir) => {
    const store = fakeMsstore();
    await assert.rejects(publishToStore({ dir, env: {}, run: store.run, log: () => {} }), /^Error: Set MICROSOFT_STORE_TENANT_ID/);
    assert.equal(store.calls.length, 0);
  });
});

test('stable releases submit the Store package from its build artifact', () => {
  const workflow = read('.github/workflows/release.yml');
  const job = workflow.slice(workflow.indexOf('  publish-microsoft-store:'));
  assert.ok(workflow.includes('  publish-microsoft-store:'));
  assert.match(job, /needs: release\n/);
  assert.match(job, /if: inputs\.prerelease == false\n/);
  assert.match(job, /runs-on: windows-latest\n/);
  assert.match(job, /name: microsoft-store-package\n\s+path: dist\/microsoft-store\n/);
  assert.match(job, /uses: microsoft\/microsoft-store-apppublisher@v1\.\d+\n\s+with:\n\s+version: v0\.4\.\d+\n/);
  for (const name of ['TENANT_ID', 'SELLER_ID', 'CLIENT_ID']) {
    assert.match(job, new RegExp(`MICROSOFT_STORE_${name}: \\$\\{\\{ vars\\.MICROSOFT_STORE_${name} \\}\\}\\n`));
  }
  assert.match(job, /MICROSOFT_STORE_CLIENT_SECRET: \$\{\{ secrets\.MICROSOFT_STORE_CLIENT_SECRET \}\}\n/);
  assert.match(job, /run: node scripts\/publish-microsoft-store\.js dist\/microsoft-store\n/);
  // The job doesn't install dependencies, so the script mustn't need them.
  assert.doesNotMatch(job, /npm ci/);
  for (const file of ['scripts/publish-microsoft-store.js', 'scripts/store-version.js']) {
    for (const [, dep] of read(file).matchAll(/require\('([^']+)'\)/g)) {
      assert.ok(dep.startsWith('node:') || dep.startsWith('./'), `${file} requires ${dep}`);
    }
  }
});
