'use strict';

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

module.exports = { HookShots };
