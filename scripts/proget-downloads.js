#!/usr/bin/env node
'use strict';

// Writes the README's APT, DNF and Chocolatey download badges as shields.io
// endpoint files. Cloudflare blocks shields.io from reading the public ProGet
// host, so the sort-download-badges workflow reads the counts from the release
// upload host (PROGET_BADGE_BASE_URL) and serves them from the badges branch.
//
//   node scripts/proget-downloads.js <output-dir>

const fs = require('node:fs');
const path = require('node:path');

const { SOURCES, progetDownloads } = require('./sort-download-badges');

/** Badge file name for a label, e.g. "APT downloads" -> "apt-downloads.json". */
function badgeFile(label) {
  return `${label.toLowerCase().replace(/\s+/g, '-')}.json`;
}

// A feed that can't be read keeps its old file on the badges branch.
async function writeBadges(dir, { fetchImpl = fetch, progetBase } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const failures = [];
  for (const [label, source] of Object.entries(SOURCES)) {
    if (source.kind !== 'proget') continue;
    try {
      const count = await progetDownloads(fetchImpl, source.feed, progetBase);
      const badge = { schemaVersion: 1, label, message: String(count), color: 'blue' };
      fs.writeFileSync(path.join(dir, badgeFile(label)), `${JSON.stringify(badge)}\n`);
      console.log(`${label}: ${count}`);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return failures;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/proget-downloads.js <output-dir>');
    process.exitCode = 2;
  } else {
    writeBadges(path.resolve(dir), { progetBase: process.env.PROGET_BADGE_BASE_URL }).then((failures) => {
      for (const message of failures) console.log(`::warning::${message.replace(/[\r\n]+/g, ' ')} Keeping its old badge.`);
    });
  }
}

module.exports = { badgeFile, writeBadges };
