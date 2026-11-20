'use strict';

// Library cards draw their thumbnails a few at a time, not one by one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

test('cards coming into view draw up to four thumbnails at once, and a failed one does not hold up the rest', async () => {
  let reveal = null;
  let running = 0;
  let most = 0;
  const pending = [];
  const context = vm.createContext({
    ...rendererI18n(),
    navigator: { hardwareConcurrency: 16 },
    IntersectionObserver: class { constructor(callback) { reveal = callback; } observe() {} unobserve() {} },
    window: {
      stepforge: {
        library: {
          // Each request waits until the test lets it finish.
          thumbnail: ({ guideId }) => new Promise((resolve) => {
            running += 1;
            most = Math.max(most, running);
            pending.push(() => { running -= 1; resolve(guideId === 'g1' ? null : { dataUrl: `data:image/webp;base64,${guideId}` }); });
          }),
        },
      },
    },
    document: { addEventListener() {} },
    el: (selector, attrs = {}) => ({ selector, ...attrs, isConnected: true, remove() { this.removed = true; } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8').replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  const cards = Array.from({ length: 10 }, (_, i) => app.cardThumbnail(`g${i}`, 'v1'));
  reveal(cards.map((target) => ({ target, isIntersecting: true })));
  await new Promise(setImmediate);
  assert.equal(running, 4, 'four start straight away');
  while (pending.length) {
    pending.shift()();
    await new Promise(setImmediate);
  }
  assert.equal(most, 4, 'never more than four at once');
  assert.equal(cards[1].removed, true, 'the card whose screenshot failed shows no picture');
  assert.deepEqual(cards.filter((c) => c.src).map((c) => c.src.slice(-2)), ['g0', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'].map((id) => id.slice(-2)));
});
