'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Screenshots the Windows click hook takes at each button-down (SHOT lines),
 * paired with their CLICK by the hook's timestamp. A shot that no click takes
 * in time (a debounced press, a click StepForge ignored) is discarded, and so
 * is anything still held when recording stops.
 */
class HookShots {
  constructor({ discard = () => {}, keepMs = 5000 } = {}) {
    this.discard = discard;
    this.keepMs = keepMs;
    this.ready = new Map();
    this.waiting = new Map();
  }

  /** The hook's result for the click at `at`: a shot, or null when it could not take one. */
  deliver(at, shot) {
    const waiter = this.waiting.get(at);
    if (waiter) {
      this.waiting.delete(at);
      clearTimeout(waiter.timer);
      waiter.resolve(shot);
      return;
    }
    if (!shot) return;
    const old = this.ready.get(at);
    if (old) {
      clearTimeout(old.timer);
      this.discard(old.shot);
    }
    const timer = setTimeout(() => {
      this.ready.delete(at);
      this.discard(shot);
    }, this.keepMs);
    if (timer.unref) timer.unref();
    this.ready.set(at, { shot, timer });
  }

  /** The shot for the click at `at`, or null if it failed or did not arrive within `waitMs`. */
  take(at, waitMs) {
    const entry = this.ready.get(at);
    if (entry) {
      this.ready.delete(at);
      clearTimeout(entry.timer);
      return Promise.resolve(entry.shot);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(at);
        resolve(null);
      }, waitMs);
      this.waiting.set(at, { resolve, timer });
    });
  }

  clear() {
    for (const { shot, timer } of this.ready.values()) {
      clearTimeout(timer);
      this.discard(shot);
    }
    for (const { resolve, timer } of this.waiting.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.ready.clear();
    this.waiting.clear();
  }
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // someone else's process
  }
}

/** Remove the screenshot folders (`stepforge-shots-<pid>`) that crashed or killed runs left in `tmp`. */
function clearStaleShotDirs(tmp, isRunning = pidRunning) {
  let names;
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^stepforge-shots-(\d+)$/.exec(name);
    if (!match || isRunning(Number(match[1]))) continue;
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
    } catch {
      // A file still held open; tried again at the next recording.
    }
  }
}

module.exports = { HookShots, clearStaleShotDirs };
