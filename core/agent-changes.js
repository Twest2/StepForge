'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync, readJsonIfExists } = require('./util');

/**
 * AI agents edit guides from a separate `StepForge --mcp` process, so the app
 * can't see their writes. After each write the agent process records the guide
 * here, and the app watches this one small file to reload an open guide.
 */
const KEEP_LAST = 50;

function agentChangesFile(libraryDir) {
  return path.join(libraryDir, 'agent-changes.json');
}

function recordAgentChange(libraryDir, guideId, now = Date.now()) {
  const file = agentChangesFile(libraryDir);
  const { changes = [] } = readJsonIfExists(file, {}) || {};
  const next = [...(Array.isArray(changes) ? changes : []), { guideId, at: now }].slice(-KEEP_LAST);
  atomicWriteFileSync(file, JSON.stringify({ changes: next }));
}

/** Guide ids changed by agents after `since` (ms), and the newest change time. */
function agentChangesSince(libraryDir, since) {
  const { changes = [] } = readJsonIfExists(agentChangesFile(libraryDir), {}) || {};
  const fresh = (Array.isArray(changes) ? changes : []).filter((c) => c && c.at > since && typeof c.guideId === 'string');
  return {
    guideIds: [...new Set(fresh.map((c) => c.guideId))],
    latest: fresh.reduce((max, c) => Math.max(max, c.at), since),
  };
}

/** Modification stamp of the changes file, or 0 when it doesn't exist. */
function agentChangesStamp(libraryDir) {
  try {
    return fs.statSync(agentChangesFile(libraryDir)).mtimeMs;
  } catch {
    return 0;
  }
}

module.exports = { agentChangesFile, recordAgentChange, agentChangesSince, agentChangesStamp };
