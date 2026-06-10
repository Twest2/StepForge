'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nowIso, readJsonIfExists } = require('./util');

/**
 * Advisory sidecar lock files for shared .sfgz guides on network folders.
 * For `guide.sfgz` the lock is `guide.lock-sfgz` next to it. This is a
 * coordination mechanism, not a security boundary (see SECURITY.md).
 */

const STALE_AFTER_MS = 1000 * 60 * 60 * 8; // 8h: treat crashed holders as stale

function lockPathFor(archivePath) {
  const dir = path.dirname(archivePath);
  const base = path.basename(archivePath);
  const stem = base.endsWith('.sfgz') ? base.slice(0, -'.sfgz'.length) : base;
  return path.join(dir, `${stem}.lock-sfgz`);
}

function currentHolder() {
  return { host: os.hostname(), user: os.userInfo().username, pid: process.pid };
}

function readLock(archivePath) {
  return readJsonIfExists(lockPathFor(archivePath), null);
}

function sameHolder(a, b) {
  return a && b && a.host === b.host && a.user === b.user && a.pid === b.pid;
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
  const existing = readLock(archivePath);
  const me = currentHolder();
  if (existing && !sameHolder(existing, me) && !isStale(existing) && !force) {
    return { acquired: false, conflict: existing };
  }
  const lock = { ...me, acquiredAt: nowIso() };
  fs.writeFileSync(file, JSON.stringify(lock, null, 2));
  return { acquired: true, lock };
}

/** Release only if we are the holder (or force). */
function releaseLock(archivePath, { force = false } = {}) {
  const file = lockPathFor(archivePath);
  const existing = readLock(archivePath);
  if (!existing) return true;
  if (!force && !sameHolder(existing, currentHolder())) return false;
  fs.rmSync(file, { force: true });
  return true;
}

module.exports = { lockPathFor, readLock, acquireLock, releaseLock, isStale, STALE_AFTER_MS };
