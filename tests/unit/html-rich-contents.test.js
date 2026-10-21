'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { exportHtmlRich } = require('../../exporters/html');
const { makeTmpDir, rmrf } = require('./helpers');

let script = null;

/** The rich page's own script, taken from a real export. */
function richScript() {
  if (script) return script;
  const root = makeTmpDir('richtoc');
  try {
    const store = new GuideStore(path.join(root, 'data'));
    const guide = store.createGuide({ title: 'Contents test' });
    store.addStep(guide.guideId, { kind: 'empty', title: 'One' });
    store.addStep(guide.guideId, { kind: 'empty', title: 'Two' });
    const html = fs.readFileSync(exportHtmlRich(buildRenderAst(store, guide.guideId), path.join(root, 'out')).file, 'utf8');
    script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    return script;
  } finally {
    rmrf(root);
  }
}

/**
 * Run the script against a stand-in page: steps whose tops sit at `tops`
 * (page coordinates), a window `viewport` tall, and a page `pageHeight` tall.
 */
function richPage({ tops, viewport = 800, pageHeight, hash = '' }) {
  const node = () => {
    const n = { listeners: {}, classes: new Set() };
    n.addEventListener = (type, fn) => { (n.listeners[type] ||= []).push(fn); };
    n.classList = { toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)), contains: (c) => n.classes.has(c) };
    return n;
  };
  const fire = (target, type, event = {}) => (target.listeners[type] || []).forEach((fn) => fn(event));
  let scrollY = 0;
  const ids = tops.map((_, i) => `step-${i + 1}`);
  const links = ids.map((id) => Object.assign(node(), { getAttribute: () => `#${id}` }));
  const sections = ids.map((id, i) => Object.assign(node(), { id, getBoundingClientRect: () => ({ top: tops[i] - scrollY }) }));
  const doc = Object.assign(node(), {
    documentElement: { scrollHeight: pageHeight, clientWidth: 1000 },
    querySelectorAll: (sel) => ({ '.toc-list a': links, 'section.step': sections })[sel] || [],
    querySelector: () => null,
  });
  const win = Object.assign(node(), {
    document: doc,
    location: { hash },
    innerHeight: viewport,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
  });
  win.window = win;
  Object.defineProperty(win, 'scrollY', { get: () => scrollY });
  vm.runInNewContext(richScript(), win);
  return {
    active: () => links.findIndex((a) => a.classes.has('active')) + 1,
    click: (n) => fire(links[n - 1], 'click'),
    // A scroll the page makes itself, e.g. jumping to a step picked in Contents.
    scrolledTo: (y) => { scrollY = y; fire(win, 'scroll'); },
    // The reader scrolling with the mouse wheel.
    wheelTo: (y) => { fire(win, 'wheel'); scrollY = y; fire(win, 'scroll'); },
  };
}

test('rich HTML Contents: on a short guide that fits on screen, the step picked stays highlighted', () => {
  const page = richPage({ tops: [300, 450, 600], pageHeight: 800 });
  assert.equal(page.active(), 1);
  page.click(3);
  page.scrolledTo(0); // the page can't scroll, so step 3 never reaches the top
  assert.equal(page.active(), 3);
  page.click(2);
  assert.equal(page.active(), 2);
  page.wheelTo(0);
  assert.equal(page.active(), 1, 'scrolling by hand hands the highlight back to the step in view');
});

test('rich HTML Contents: scrolling highlights the step being read, and the last one at the bottom', () => {
  const tops = Array.from({ length: 15 }, (_, i) => 100 + i * 500);
  const page = richPage({ tops, pageHeight: 7600 });
  page.wheelTo(2000); // step 5's top (2100) is above the line 30% down the window
  assert.equal(page.active(), 5);
  page.wheelTo(6800); // the bottom of the page: step 15 can't reach the line
  assert.equal(page.active(), 15);
  page.click(7);
  page.scrolledTo(3000);
  assert.equal(page.active(), 7);
  page.wheelTo(3100);
  assert.equal(page.active(), 7, 'step 7 (top 3100) is now the step being read');
  page.wheelTo(0);
  assert.equal(page.active(), 1);
});

test('rich HTML Contents: a page opened at a step\'s link highlights that step', () => {
  assert.equal(richPage({ tops: [300, 450, 600], pageHeight: 800, hash: '#step-2' }).active(), 2);
});
