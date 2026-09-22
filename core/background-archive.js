'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { zipSync } = require('./zip');
const { atomicWriteFileSync } = require('./util');

if (!isMainThread && workerData?.archiveJob) {
  const entries = workerData.entries.map((entry) => ({
    ...entry,
    data: typeof entry.data === 'string' ? entry.data : Buffer.from(entry.data),
  }));
  const bytes = zipSync(entries);
  if (workerData.destination) {
    atomicWriteFileSync(workerData.destination, bytes);
    parentPort.postMessage(null);
  } else {
    parentPort.postMessage(bytes);
  }
}

// One archive at a time limits CPU/disk contention. Input bytes are captured
// by the caller before yielding so later edits cannot mix archive revisions.
let tail = Promise.resolve();
function writeArchive(entries, destination) {
  const job = tail.then(() => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { archiveJob: true, entries, destination },
    });
    let complete = false;
    let result;
    worker.once('message', (value) => { complete = true; result = value; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && complete) resolve(result == null ? undefined : Buffer.from(result));
      else reject(new Error(`Archive worker exited without completing (code ${code})`));
    });
  }));
  tail = job.catch(() => {});
  return job;
}

async function drainArchives() {
  let pending;
  do { pending = tail; await pending; } while (pending !== tail);
}
module.exports = { writeArchive, encodeArchive: (entries) => writeArchive(entries), drainArchives };
