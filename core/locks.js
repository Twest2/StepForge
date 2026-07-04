'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nowIso, readJsonIfExists } = require('./util');

/**
 * Advisory sidecar lock files for shared .sfgz guides on network folders.
 * For `guide.sfgz` the lock is `guide.lock-sfgz` next to it. This is a
 * coordination mechanism, not a security boundary (see docs/SECURITY.md).
 */

const STALE_AFTER_MS = 1000 * 60 * 60 * 8; // 8h: treat crashed holders as stale

function lockPathFor(archivePath) {
  const dir = path.dirname(archivePath);
  const base = path.basename(archivePath);
  const stem = base.endsWith('.sfgz') ? base.slice(0, -'.sfgz'.length) : base;
  return path.join(dir, `${stem}.lock-sfgz`);
}

function currentProcess() {
  return { host: os.hostname(), user: os.userInfo().username, pid: process.pid };
}

function currentHolder() {
  return {
    ...currentProcess(),
    // Random per-acquisition token so two processes that happen to share
    // host+user+pid space (containers, pid reuse) still compare distinctly,
    // and so a steal can be detected by the previous holder.
    token: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

function readLock(archivePath) {
  return readJsonIfExists(lockPathFor(archivePath), null);
}

// Process identity (host+user+pid). Used to decide whether an existing lock is
// held by *this process* (safe to re-acquire) or someone else (a conflict).
function sameProcess(a, b) {
  return a && b && a.host === b.host && a.user === b.user && a.pid === b.pid;
}

// Exact-acquisition identity via the per-acquisition token. Used by release so
// a caller only removes the lock it actually took (never one a force-steal
// replaced with its own).
function sameAcquisition(existing, owner) {
  if (!existing || !owner) return false;
  if (owner.token) return existing.token === owner.token;
  return sameProcess(existing, owner);
}

function isStale(lock, now = Date.now()) {
  const t = Date.parse(lock && lock.acquiredAt);
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}

/**
 * Try to take the lock. Returns { acquired: true, lock } or
 * { acquired: false, conflict } when someone else holds a fresh lock.
 * Pass force=true to steal (after the user confirmed in the conflict dialog).
 */
function acquireLock(archivePath, { force = false } = {}) {
  const file = lockPathFor(archivePath);
  const me = currentHolder();
  const lock = { ...me, acquiredAt: nowIso() };
  const payload = JSON.stringify(lock, null, 2);

  // Fast path: exclusive create. Only one writer wins the O_CREAT|O_EXCL race,
  // so two processes can't both believe they hold the lock (the old
  // read-then-write left exactly that window open).
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' });
    return { acquired: true, lock };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // A lock already exists. We may take it over only if this process already
  // holds it, it is stale, or the caller is force-stealing (user confirmed).
  const existing = readLock(archivePath);
  if (existing && !sameProcess(existing, me) && !isStale(existing) && !force) {
    return { acquired: false, conflict: existing };
  }
  // Overwrite to claim ownership (our token now identifies the lock).
  fs.writeFileSync(file, payload);
  return { acquired: true, lock };
}

/**
 * Release only if we are the holder (or force). Pass the `lock` (or its
 * `token`) returned by acquireLock so ownership is matched by token — the
 * per-acquisition token means a fresh currentHolder() would not match.
 */
function releaseLock(archivePath, { force = false, lock = null, token = null } = {}) {
  const file = lockPathFor(archivePath);
  const existing = readLock(archivePath);
  if (!existing) return true;
  // With no explicit lock/token, fall back to process identity (the legacy
  // "release my own lock" path) rather than a fresh token that can't match.
  const owner = lock || (token ? { token } : currentProcess());
  if (!force && !sameAcquisition(existing, owner)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

module.exports = {
  lockPathFor, readLock, acquireLock, releaseLock, isStale, STALE_AFTER_MS,
  sameProcess, sameAcquisition,
};
