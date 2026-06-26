'use strict';

/**
 * Capture worker: runs in a hidden renderer window and owns all continuous
 * screen capture during a recording session.
 *
 * Per display it opens a desktop media stream (the desktopCapturer source id
 * comes from the main process) and samples it on a fixed cadence into a
 * timestamped ring buffer of ImageBitmaps. Sampling and PNG encoding happen
 * entirely in this process, so the main-process event loop — which must stay
 * responsive to deliver OS click events on time — never blocks on capture
 * work. ImageBitmaps are GPU-backed and cheap to create from a <video>
 * element, which is what lets the cadence be much tighter than the old
 * 200ms main-process desktopCapturer loop.
 *
 * On a frame request the worker applies the shared strict selection rule
 * (newest frame captured at or before the click; never one whose grab
 * started after it), encodes that single frame to PNG, and ships the bytes
 * to the main process.
 */

/* global StepForgeClickFrames, captureWorkerBridge */

(() => {
  const FALLBACK_SAMPLE_MS = 50;
  // Tight cadence means more frames per second; keep enough of them to span
  // the click-lead window plus any encode/IPC hiccup, without hoarding GPU
  // memory. 16 frames at the 50ms cadence is ~800ms of history.
  const FALLBACK_FRAME_LIMIT = 16;
  const FALLBACK_RETENTION_MS = 2000;

  const streams = new Map(); // displayId(string) -> stream state

  function send(msg) {
    try {
      captureWorkerBridge.send(msg);
      return true;
    } catch (err) {
      // Either the main process is gone or the payload didn't survive the
      // bridge; log it — a silently dropped frame-response would otherwise
      // look like a worker hang from the main process.
      console.error('capture-worker send failed:', err && err.message, 'type:', msg && msg.type);
      return false;
    }
  }

  async function startStream(cmd) {
    const key = String(cmd.displayId);
    stopStream(key);
    const display = cmd.display || {};
    const scale = display.scaleFactor || 1;
    const bounds = display.bounds || { width: 1280, height: 720 };
    const physWidth = Math.round(bounds.width * scale);
    const physHeight = Math.round(bounds.height * scale);
    const state = {
      displayId: cmd.displayId,
      media: null,
      video: null,
      timer: null,
      sampling: false,
      ring: new StepForgeClickFrames.FrameRing({
        limit: cmd.frameLimit || FALLBACK_FRAME_LIMIT,
        retentionMs: cmd.retentionMs || FALLBACK_RETENTION_MS,
        onEvict: (frame) => {
          if (frame && frame.bitmap && frame.bitmap.close) frame.bitmap.close();
        },
      }),
    };
    streams.set(key, state);
    try {
      // The chromeMediaSource constraint is Electron's bridge from a
      // desktopCapturer source id to a live media stream. The legacy
      // `mandatory` wrapper was removed in Electron 29 (Chromium 116+);
      // constraints must now be flat (no mandatory/optional nesting).
      state.media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: cmd.sourceId,
          // Sampling cadence is controlled by the setInterval timer, so the
          // actual capture rate is sampleMs-driven regardless of display
          // refresh rate. Resolution is driven by the source itself.
        },
      });
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = state.media;
      state.video = video;
      await video.play();
      const sampleMs = cmd.sampleMs || FALLBACK_SAMPLE_MS;
      state.timer = setInterval(() => sampleFrame(state), sampleMs);
      // Buffer a frame immediately so a click right after "Start recording"
      // already has something captured before it.
      await sampleFrame(state);
      send({ type: 'stream-ready', displayId: cmd.displayId });
    } catch (err) {
      stopStream(key);
      send({ type: 'stream-error', displayId: cmd.displayId, reason: String(err && err.message || err) });
    }
  }

  async function sampleFrame(state) {
    if (state.sampling || !state.video || state.video.readyState < 2) return;
    state.sampling = true;
    // startedAt/capturedAt bracket the grab so strict selection can tell
    // pre-click frames from post-click ones.
    const startedAt = Date.now();
    try {
      const bitmap = await createImageBitmap(state.video);
      state.ring.push({
        mode: 'fullscreen',
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        startedAt,
        capturedAt: Date.now(),
      });
    } catch {
      // A failed sample only means a slightly older best frame.
    } finally {
      state.sampling = false;
    }
  }

  function stopStream(key) {
    const state = streams.get(key);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    if (state.media) {
      for (const track of state.media.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    state.ring.clear();
    streams.delete(key);
  }

  async function handleFrameRequest(cmd) {
    const state = streams.get(String(cmd.displayId));
    const reply = (extra) => send({ type: 'frame-response', requestId: cmd.requestId, ...extra });
    if (!state) return reply({ ok: false, reason: 'no stream for display' });
    // One last sample: if the compositor delivered a newer video frame since
    // the previous tick, a sub-millisecond grab here can only improve (never
    // worsen) the match — its startedAt is still checked against the click.
    await sampleFrame(state);
    const frame = StepForgeClickFrames.selectFrameForClick(state.ring.frames(), {
      clickAt: cmd.clickAt,
      leadMs: cmd.leadMs || 0,
      mode: 'fullscreen',
      strict: cmd.strict !== false,
    });
    if (!frame) return reply({ ok: false, reason: 'no frame at or before the click' });
    // Stage one: confirm the selection immediately. The encode below can
    // take seconds on software-rendered hosts; without this ack the main
    // process couldn't tell a slow encode from a dead worker.
    send({
      type: 'frame-selected',
      requestId: cmd.requestId,
      startedAt: frame.startedAt,
      capturedAt: frame.capturedAt,
    });
    try {
      const canvas = new OffscreenCanvas(frame.width, frame.height);
      canvas.getContext('2d').drawImage(frame.bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const png = await blob.arrayBuffer();
      return reply({
        ok: true,
        png: new Uint8Array(png),
        width: frame.width,
        height: frame.height,
        startedAt: frame.startedAt,
        capturedAt: frame.capturedAt,
      });
    } catch (err) {
      return reply({ ok: false, reason: String(err && err.message || err) });
    }
  }

  /** Health/diagnostic snapshot of every stream. */
  function reportStats(cmd) {
    const stats = {};
    for (const [key, state] of streams) {
      stats[key] = {
        frames: state.ring.frames().length,
        latestCapturedAt: state.ring.latest() ? state.ring.latest().capturedAt : null,
        videoReadyState: state.video ? state.video.readyState : null,
        videoSize: state.video ? `${state.video.videoWidth}x${state.video.videoHeight}` : null,
        sampling: state.sampling,
      };
    }
    send({ type: 'stats', requestId: cmd && cmd.requestId, stats });
  }

  captureWorkerBridge.onCommand((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'start-stream') startStream(msg);
    else if (msg.type === 'stop-stream') stopStream(String(msg.displayId));
    else if (msg.type === 'frame-request') {
      // A request must always produce a response — an unanswered click
      // counts toward backend unhealthiness in the main process.
      handleFrameRequest(msg).catch((err) => {
        console.error('capture-worker frame-request failed:', err && err.message);
        send({ type: 'frame-response', requestId: msg.requestId, ok: false, reason: String(err && err.message || err) });
      });
    } else if (msg.type === 'stats-request') reportStats(msg);
  });
})();
