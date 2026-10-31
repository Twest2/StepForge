#!/usr/bin/env node
'use strict';

// Submits a release's Microsoft Store package to Partner Center for
// certification with the Microsoft Store Developer CLI (msstore), which the
// release workflow installs. Once the package passes, the Store publishes it
// and updates StepForge on users' PCs. Certification usually takes a few hours
// and sometimes up to three days.
//
//   node scripts/publish-microsoft-store.js <folder with the .appx>
//
// Signs in to Partner Center as a Microsoft Entra ID app that has the Manager
// role there, from MICROSOFT_STORE_TENANT_ID, MICROSOFT_STORE_SELLER_ID,
// MICROSOFT_STORE_CLIENT_ID and MICROSOFT_STORE_CLIENT_SECRET. Dependency-free,
// so the workflow job doesn't install the packaging tools.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { storeVersion } = require('./store-version');

const IDENTITY_FILE = path.join(__dirname, '..', 'packaging', 'windows', 'store', 'identity.json');

const CREDENTIALS = [
  ['MICROSOFT_STORE_TENANT_ID', '--tenantId'],
  ['MICROSOFT_STORE_SELLER_ID', '--sellerId'],
  ['MICROSOFT_STORE_CLIENT_ID', '--clientId'],
  ['MICROSOFT_STORE_CLIENT_SECRET', '--clientSecret'],
];

// A submission with one of these statuses has been committed and is on its
// way to, or already in, the Store. Anything else (a draft, or a failed or
// canceled submission) can be replaced.
const SUBMITTED = new Set(['CommitStarted', 'PreProcessing', 'Certification', 'Release', 'PendingPublication', 'Publishing', 'Published']);

/** The build's Store package: its path, StepForge version and Store version. */
function findStorePackage(dir) {
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.appx')) : [];
  if (found.length !== 1) throw new Error(`Expected exactly one Microsoft Store .appx in ${dir}, found ${found.length}.`);
  // Named by package-windows-store.js: "StepForge <buildVersion> Microsoft Store.appx".
  const match = /^StepForge (\d+(?:\.\d+){0,3}) Microsoft Store\.appx$/.exec(found[0]);
  if (!match) throw new Error(`Unexpected Microsoft Store package name: ${found[0]}`);
  return { file: path.join(dir, found[0]), buildVersion: match[1], version: storeVersion(match[1]) };
}

/**
 * The name the package is uploaded as. The CLI only takes .msix files, which
 * are the same format as .appx, and only replaces an earlier package that has
 * the same extension.
 */
function uploadName(version) {
  return `StepForge_${version}_x64.msix`;
}

/** The Store ID from identity.json, which Settings → About uses too. */
function readProductId(file = IDENTITY_FILE) {
  const productId = String(JSON.parse(fs.readFileSync(file, 'utf8')).productId || '').trim();
  if (!/^[0-9A-Z]{12}$/.test(productId)) {
    throw new Error('packaging/windows/store/identity.json has no Store ID (productId); copy it from Partner Center → Product identity.');
  }
  return productId;
}

/** The msstore reconfigure arguments, or what to set up in the repository. */
function reconfigureArgs(env = process.env) {
  const missing = CREDENTIALS.map(([name]) => name).filter((name) => !String(env[name] || '').trim());
  if (missing.length) {
    throw new Error(`Set ${missing.join(', ')} to submit to the Microsoft Store: the client secret as a repository secret and the IDs as repository variables, from the Entra ID app that has the Manager role in Partner Center.`);
  }
  return ['reconfigure', ...CREDENTIALS.flatMap(([name, flag]) => [flag, env[name].trim()])];
}

// The CLI writes PascalCase names but reads any case, as the Partner Center
// API does, so look names up without case.
function prop(object, name) {
  const key = object && Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

function setProp(object, name, value) {
  const key = Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase()) || name;
  object[key] = value;
}

function packagesOf(submission) {
  const packages = prop(submission, 'ApplicationPackages');
  return Array.isArray(packages) ? packages : [];
}

/**
 * Whether this Store version is already committed: a rerun of a release
 * whose submission is in certification or live has nothing left to do.
 */
function isAlreadySubmitted(submission, version) {
  return SUBMITTED.has(prop(submission, 'Status'))
    && packagesOf(submission).some((pkg) => prop(pkg, 'Version') === version && prop(pkg, 'FileStatus') !== 'PendingDelete');
}

/**
 * Leaves the new upload as the submission's only package. The Store offers
 * the newest package anyway, but packages from earlier releases would pile up,
 * and the CLI only removes one with the same extension (the first release was
 * an .appx uploaded by hand).
 */
function retirePreviousPackages(submission, name) {
  const packages = packagesOf(submission);
  if (!packages.some((pkg) => prop(pkg, 'FileName') === name && prop(pkg, 'FileStatus') === 'PendingUpload')) {
    throw new Error(`The draft submission has no ${name} waiting to be committed.`);
  }
  const retired = [];
  const kept = packages.filter((pkg) => {
    if (prop(pkg, 'FileName') === name) return true;
    // Uploaded to a draft but never committed: there is nothing to delete.
    if (prop(pkg, 'FileStatus') === 'PendingUpload') return false;
    if (prop(pkg, 'FileStatus') !== 'PendingDelete') {
      setProp(pkg, 'FileStatus', 'PendingDelete');
      retired.push(prop(pkg, 'FileName'));
    }
    return true;
  });
  setProp(submission, 'ApplicationPackages', kept);
  return retired;
}

/** Runs msstore; returns its standard output when asked to capture it. */
function runMsstore(args, { capture = false } = {}) {
  const result = spawnSync('msstore', args, {
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run msstore: ${result.error.message}`);
  // reconfigure's arguments hold the client secret: name only the command.
  if (result.status !== 0) throw new Error(`msstore ${args[0]}${args[0] === 'submission' ? ` ${args[1]}` : ''} failed with exit code ${result.status}.`);
  return capture ? result.stdout : '';
}

function getSubmission(run, productId) {
  const output = run(['submission', 'get', productId], { capture: true });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`msstore submission get did not return JSON: ${output.slice(0, 200)}`);
  }
}

async function publishToStore({ dir, env = process.env, run = runMsstore, identityFile = IDENTITY_FILE, log = console.log } = {}) {
  const pkg = findStorePackage(dir);
  const productId = readProductId(identityFile);
  run(reconfigureArgs(env));

  const current = getSubmission(run, productId);
  if (isAlreadySubmitted(current, pkg.version)) {
    log(`StepForge ${pkg.buildVersion} (Store version ${pkg.version}) is already submitted: the submission is ${prop(current, 'Status')}. Nothing to do.`);
    return { submitted: false, version: pkg.version };
  }

  const name = uploadName(pkg.version);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-store-submit-'));
  try {
    const upload = path.join(workDir, name);
    fs.copyFileSync(pkg.file, upload);

    // Replaces any draft with a copy of the live submission, uploads the
    // package to it, and leaves it uncommitted so old packages can go first.
    run(['publish', upload, '--appId', productId, '--noCommit']);

    const draft = getSubmission(run, productId);
    const retired = retirePreviousPackages(draft, name);
    if (retired.length) log(`Removing the previous package${retired.length > 1 ? 's' : ''}: ${retired.join(', ')}`);
    const payload = path.join(workDir, 'submission.json');
    fs.writeFileSync(payload, JSON.stringify(draft));
    run(['submission', 'update', productId, '--payload', payload]);

    run(['submission', 'publish', productId]);
    // Waits for Partner Center to accept the submission, not for certification.
    run(['submission', 'poll', productId]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  log(`Submitted StepForge ${pkg.buildVersion} (Store version ${pkg.version}) for certification: https://partner.microsoft.com/dashboard/products/${productId}/submissions`);
  return { submitted: true, version: pkg.version };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/publish-microsoft-store.js <folder with the .appx>');
    process.exitCode = 2;
  } else {
    publishToStore({ dir: path.resolve(dir) }).catch((err) => {
      console.error(err.message || err);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  SUBMITTED,
  findStorePackage,
  uploadName,
  readProductId,
  reconfigureArgs,
  isAlreadySubmitted,
  retirePreviousPackages,
  publishToStore,
};
