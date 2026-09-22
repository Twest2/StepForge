'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { zipSync } = require('./zip');
const { atomicWriteFileSync } = require('./util');

if (!isMainThread && workerData?.archiveJob) {
  const entries = workerData.entries.map((entry) => ({
    ...entry,
    data: typeof entry.data === 'string' ? entry.data : Buffer.from(entry.data),
  }));
  atomicWriteFileSync(workerData.destination, zipSync(entries));
  parentPort.postMessage(true);
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
    worker.once('message', () => { complete = true; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && complete) resolve();
      else reject(new Error(`Archive worker exited without completing (code ${code})`));
    });
  }));
  tail = job.catch(() => {});
  return job;
}

module.exports = { writeArchive };
