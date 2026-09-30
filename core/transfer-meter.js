'use strict';

// Rate is averaged over this trailing window so it follows speed changes
// without jumping around on every chunk.
const RATE_WINDOW_MS = 3000;

/**
 * Measures one Drive transfer for the sync status: bytes moved, total bytes
 * and a smoothed rate. Updates are throttled so a fast link does not flood IPC.
 */
class TransferMeter {
  constructor({ direction, name, total, onUpdate, now = Date.now, intervalMs = 250 }) {
    Object.assign(this, { direction, name: String(name || ''), onUpdate, now, intervalMs });
    this.total = Math.max(0, Number(total) || 0);
    this.loaded = 0;
    this.samples = [{ at: now(), loaded: 0 }];
    this.reportedAt = -Infinity;
  }

  // `loaded` is absolute for the current attempt, so a retried request that
  // starts over from zero is reported honestly instead of double counted.
  update(loaded) {
    const at = this.now();
    this.loaded = Math.max(0, Number(loaded) || 0);
    if (this.loaded > this.total) this.total = this.loaded;
    if (this.loaded < this.samples.at(-1).loaded) this.samples = [];
    this.samples.push({ at, loaded: this.loaded });
    while (this.samples.length > 2 && at - this.samples[1].at >= RATE_WINDOW_MS) this.samples.shift();
    if (at - this.reportedAt >= this.intervalMs || (this.total && this.loaded === this.total)) this.report(at);
  }

  report(at = this.now()) {
    this.reportedAt = at;
    this.onUpdate(this.snapshot(at));
  }

  snapshot(at = this.now()) {
    const first = this.samples[0];
    const seconds = (at - first.at) / 1000;
    const bytesPerSecond = seconds > 0 ? Math.round((this.loaded - first.loaded) / seconds) : 0;
    return { direction: this.direction, name: this.name, loaded: this.loaded, total: this.total, bytesPerSecond };
  }
}

// Streams a request body in slices so an upload can report how much of it
// has been handed to the network. Called once per attempt, so a retry restarts at 0.
const PROGRESS_SLICE = 256 * 1024;
function progressBody(data, onProgress) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= data.length) { controller.close(); return; }
      const slice = data.subarray(sent, sent + PROGRESS_SLICE);
      sent += slice.length;
      controller.enqueue(slice);
      onProgress(sent);
    },
  });
}

module.exports = { TransferMeter, RATE_WINDOW_MS, progressBody };
