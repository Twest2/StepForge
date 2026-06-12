'use strict';

/**
 * Click ↔ frame correlation logic, shared by the main process and the
 * capture-worker renderer (loaded there via a plain <script> tag, hence the
 * UMD-style export at the bottom and the total absence of dependencies).
 *
 * The model: a recorder keeps a ring buffer of timestamped frames, each with
 *   { startedAt, capturedAt }  — when the grab began and when it completed.
 * A click carries its own hook-time timestamp. Pairing the two answers
 * "what did the screen look like when the user clicked?".
 *
 * Strict mode encodes the product requirement (Folge-like recording): a step
 * must show the screen *at or before* the click, never after it. A frame
 * whose grab started after the click can already contain the click's effects
 * (menus opened, pages navigated), so strict mode rejects it outright — the
 * caller falls back to an explicit fresh shot instead of silently passing a
 * post-click frame off as the click-time screen. Balanced mode keeps the old
 * slack-window behavior for platforms where capture is too slow to keep a
 * pre-click frame buffered.
 */

const DEFAULT_FRAME_LIMIT = 6;
const DEFAULT_RETENTION_MS = 4000;
// A frame older than this is too stale to pass off as "the screen at the
// instant of the click".
const DEFAULT_MAX_AGE_MS = 600;
// Balanced mode only: a grab that began within this window after the click
// is accepted on the assumption that UI reactions render slower than this.
const DEFAULT_START_SLACK_MS = 300;

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

/**
 * Ring buffer of recent frames, bounded by both count and age. Frames are
 * raw images (potentially tens of MB each), so eviction is eager and an
 * optional onEvict hook lets callers release native resources (e.g.
 * ImageBitmap.close() in the capture worker).
 */
class FrameRing {
  constructor({ limit = DEFAULT_FRAME_LIMIT, retentionMs = DEFAULT_RETENTION_MS, now = Date.now, onEvict = null } = {}) {
    this.limit = limit;
    this.retentionMs = retentionMs;
    this.now = now;
    this.onEvict = onEvict;
    this.items = [];
  }

  push(frame) {
    if (!frame) return null;
    this.items.push(frame);
    this.prune();
    return frame;
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    while (this.items.length
      && (this.items.length > this.limit || !(this.items[0].capturedAt >= cutoff))) {
      const evicted = this.items.shift();
      if (this.onEvict) this.onEvict(evicted);
    }
  }

  frames() {
    return [...this.items];
  }

  latest() {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  clear() {
    const dropped = this.items;
    this.items = [];
    if (this.onEvict) for (const f of dropped) this.onEvict(f);
  }
}

/**
 * Whether one frame may represent one click.
 *
 * Strict mode accepts only:
 *  - a frame completed at or before the click (and not older than maxAgeMs), or
 *  - when allowInFlight is set, a frame whose grab *started* at or before the
 *    click — its pixels predate the click's effects even though encoding
 *    finished after.
 * A frame whose grab started after the click is never acceptable in strict
 * mode, no matter how close: that is exactly the "screenshot shows the menu
 * already open" failure.
 *
 * Balanced mode additionally accepts in-flight frames that started within
 * startSlackMs after the click (the legacy heuristic).
 */
function frameUsableForClick(frame, {
  clickAt,
  clickPos = null,
  mode = null,
  strict = true,
  allowInFlight = false,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  startSlackMs = DEFAULT_START_SLACK_MS,
} = {}) {
  if (!frame) return false;
  if (mode && frame.mode !== mode) return false;
  // Fast clicks can move to another monitor before a buffered frame is
  // consumed; only reuse frames from the clicked display.
  if (clickPos && frame.display && !pointInBounds(clickPos, frame.display.bounds)) return false;

  const clickTime = Number.isFinite(clickAt) ? clickAt : Date.now();
  const capturedAt = frame.capturedAt;
  const startedAt = Number.isFinite(frame.startedAt) ? frame.startedAt : capturedAt;

  const completedBeforeClick = Number.isFinite(capturedAt) && capturedAt <= clickTime;
  if (completedBeforeClick) return clickTime - capturedAt <= maxAgeMs;

  if (!allowInFlight || !Number.isFinite(startedAt)) return false;
  if (strict) return startedAt <= clickTime;
  return startedAt <= clickTime + startSlackMs;
}

function newestUsableFrame(frames, opts) {
  let best = null;
  for (const frame of frames || []) {
    if (!frameUsableForClick(frame, { ...opts, allowInFlight: false })) continue;
    if (!best || frame.capturedAt > best.capturedAt) best = frame;
  }
  return best;
}

/**
 * Best already-buffered frame for a click, in two tiers:
 *  1. with a click lead (opts.leadMs > 0): the newest frame captured at least
 *     leadMs *before* the click, so the step shows the screen the user was
 *     about to act on — clear of the click's own onset;
 *  2. failing that, the newest frame captured before the click at all.
 *
 * The two tiers matter for correctness, not just polish: the lead is a
 * *preference*, never a hard gate. If it were a gate, a click with no frame
 * old enough to satisfy the lead would fall through to the caller's fresh
 * shot — which captures the screen *after* the click. The tier-2 fallback
 * guarantees that as long as any pre-click frame exists, we use it rather
 * than shooting post-click. Buffered frames are always completed, so
 * in-flight acceptance never applies here.
 */
function selectFrameForClick(frames, opts = {}) {
  const leadMs = Math.max(0, Number(opts.leadMs) || 0);
  const clickAt = Number.isFinite(opts.clickAt) ? opts.clickAt : Date.now();
  if (leadMs > 0) {
    // Widen the staleness budget by the lead so a frame that was fresh
    // enough for the real click is still fresh enough for the lead target.
    const maxAgeMs = (opts.maxAgeMs == null ? DEFAULT_MAX_AGE_MS : opts.maxAgeMs) + leadMs;
    const led = newestUsableFrame(frames, { ...opts, clickAt: clickAt - leadMs, maxAgeMs });
    if (led) return led;
  }
  return newestUsableFrame(frames, { ...opts, clickAt });
}

const api = {
  FrameRing,
  frameUsableForClick,
  selectFrameForClick,
  pointInBounds,
  DEFAULT_FRAME_LIMIT,
  DEFAULT_RETENTION_MS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_START_SLACK_MS,
};

/* eslint-disable no-undef */
if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else if (typeof self !== 'undefined') {
  self.StepForgeClickFrames = api;
} else if (typeof window !== 'undefined') {
  window.StepForgeClickFrames = api;
}
