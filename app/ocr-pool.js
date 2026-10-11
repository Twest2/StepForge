'use strict';

const os = require('node:os');

/*
 * Several text-recognition workers reading screenshots side by side. Each
 * worker reads one image at a time on its own thread, so a guide's
 * screenshots are read about as many times faster as there are workers.
 *
 * A worker is started only when there is more to read than the running ones
 * can take, and one at a time. Each holds a few hundred MB while it reads a
 * large screenshot, so they all stop once reading has been idle a while.
 */

const IDLE_MS = 30000;

// About one per processor core (half the hardware threads), at most 8, and
// at most one per 2 GB of memory.
function defaultSize() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2), Math.floor(os.totalmem() / 2 ** 31)));
}

class OcrPool {
  /** `start()` resolves with a ready tesseract.js worker. */
  constructor({ start, size = defaultSize(), idleMs = IDLE_MS }) {
    Object.assign(this, { start, size, idleMs });
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.starting = false;
    this.timer = null;
  }

  /** Run `job(worker)` on the next free worker. */
  run(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  pump() {
    clearTimeout(this.timer);
    while (this.queue.length && this.idle.length) {
      const worker = this.idle.pop();
      const { job, resolve, reject } = this.queue.shift();
      Promise.resolve().then(() => job(worker)).then(resolve, reject).finally(() => {
        if (this.workers.includes(worker)) this.idle.push(worker);
        this.pump();
      });
    }
    if (this.queue.length && !this.starting && this.workers.length < this.size) this.grow();
    if (!this.queue.length && this.workers.length && this.idle.length === this.workers.length) {
      this.timer = setTimeout(() => this.stop(), this.idleMs);
      this.timer.unref?.();
    }
  }

  async grow() {
    this.starting = true;
    try {
      const worker = await this.start();
      this.workers.push(worker);
      this.idle.push(worker);
    } catch (err) {
      // With workers running, carry on with those; with none, nothing can be read.
      if (this.workers.length) this.size = this.workers.length;
      else for (const { reject } of this.queue.splice(0)) reject(err);
    } finally {
      this.starting = false;
      this.pump();
    }
  }

  /** Stop every worker. Reading again starts new ones. */
  async stop() {
    clearTimeout(this.timer);
    const workers = this.workers.splice(0);
    this.idle = [];
    await Promise.all(workers.map((worker) => Promise.resolve().then(() => worker.terminate()).catch(() => {})));
  }
}

module.exports = { OcrPool, defaultSize, IDLE_MS };
