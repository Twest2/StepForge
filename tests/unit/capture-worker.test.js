'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('capture worker requests the selected desktop source, not a plain camera stream', async () => {
  const scriptPath = path.join(__dirname, '../../app/renderer/capture-worker.js');
  const script = fs.readFileSync(scriptPath, 'utf8');

  const mediaCalls = [];
  const messages = [];
  let onCommand = null;
  let resolveStreamReady;
  const streamReady = new Promise((resolve) => {
    resolveStreamReady = resolve;
  });

  const context = {
    console: {
      error() {},
      log() {},
      warn() {},
    },
    captureWorkerBridge: {
      onCommand(fn) {
        onCommand = fn;
      },
      send(msg) {
        messages.push(msg);
        if (msg.type === 'stream-ready') resolveStreamReady();
      },
    },
    StepForgeClickFrames: {
      FrameRing: class {
        constructor() {
          this._frames = [];
        }

        push(frame) {
          this._frames.push(frame);
        }

        frames() {
          return [...this._frames];
        }

        latest() {
          return this._frames[this._frames.length - 1] || null;
        }

        clear() {
          this._frames = [];
        }
      },
      selectFrameForClick() {
        return null;
      },
    },
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          mediaCalls.push(constraints);
          return {
            getTracks() {
              return [{ stop() {} }];
            },
          };
        },
        async getDisplayMedia() {
          throw new Error('unexpected getDisplayMedia call');
        },
      },
    },
    document: {
      createElement(tag) {
        assert.equal(tag, 'video');
        return {
          muted: false,
          srcObject: null,
          readyState: 2,
          play: async () => {},
          videoWidth: 1920,
          videoHeight: 1080,
        };
      },
    },
    createImageBitmap: async () => ({ width: 1920, height: 1080, close() {} }),
    setInterval: () => 1,
    clearInterval: () => {},
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { drawImage() {} };
      }

      async convertToBlob() {
        return {
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
        };
      }
    },
  };

  vm.createContext(context);
  vm.runInContext(script, context, { filename: scriptPath });

  assert.equal(typeof onCommand, 'function', 'worker should register a command handler');

  onCommand({
    type: 'start-stream',
    displayId: 7,
    sourceId: 'screen:1:0',
    display: {
      bounds: { width: 1920, height: 1080 },
      scaleFactor: 1,
    },
    sampleMs: 50,
  });
  await streamReady;

  assert.equal(mediaCalls.length, 1);
  const constraints = JSON.parse(JSON.stringify(mediaCalls[0]));
  assert.deepEqual(constraints, {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: 'screen:1:0',
        minWidth: 1920,
        maxWidth: 1920,
        minHeight: 1080,
        maxHeight: 1080,
      },
    },
  });
  assert.ok(messages.some((msg) => msg.type === 'stream-ready'));
});
