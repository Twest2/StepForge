'use strict';

// Drives the real StepForge app over the Chrome DevTools Protocol.
//
// Every user action goes through Input.dispatch* so the app sees the same
// events a person would produce: mouse moves, presses and releases at real
// coordinates, and key presses. Reading state back with Runtime.evaluate is
// fine; performing an action by calling DOM click() or app functions is not.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CdpClient, withTimeout } = require('./cdp');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_BIN = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron');
const DEFAULT_TIMEOUT_MS = 15000;

// Runs in the main process. Native pickers cannot be clicked from CDP, so
// every launch stubs the shell calls that would open a file manager, browser
// or other program on the developer's desktop.
const SHELL_STUB = `(() => {
  const { shell } = process.mainModule.require('electron');
  globalThis.__stepforgeTest = globalThis.__stepforgeTest || { dialogs: [], opened: [] };
  shell.openPath = async (target) => { globalThis.__stepforgeTest.opened.push(target); return ''; };
  shell.showItemInFolder = (target) => { globalThis.__stepforgeTest.opened.push(target); };
  shell.openExternal = async (url) => { globalThis.__stepforgeTest.opened.push(url); };
  return true;
})()`;

/** Main-process script that answers native open/save dialogs from a queue the test fills in. */
function dialogStubSource(answers) {
  return `(() => {
    const { dialog } = process.mainModule.require('electron');
    const state = globalThis.__stepforgeTest || (globalThis.__stepforgeTest = { dialogs: [], opened: [] });
    const queues = ${JSON.stringify(answers)};
    const answer = (kind, options) => {
      state.dialogs.push({ kind, title: options && options.title });
      const next = (queues[kind] || []).shift();
      if (!next) return { canceled: true, filePaths: [] };
      return kind === 'open'
        ? { canceled: false, filePaths: next.filePaths || [next.filePath] }
        : { canceled: false, filePath: next.filePath };
    };
    dialog.showOpenDialog = async (...args) => answer('open', args[args.length - 1]);
    dialog.showSaveDialog = async (...args) => answer('save', args[args.length - 1]);
    return state.dialogs.length;
  })()`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function poll(fn, { timeout = DEFAULT_TIMEOUT_MS, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? ` (last error: ${lastError.message})` : '';
      throw new Error(`Timed out after ${timeout}ms waiting for ${label}${suffix}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

class AppPage {
  constructor(cdp, artifactDir) {
    this.cdp = cdp;
    this.artifactDir = artifactDir;
  }

  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Page expression failed: ${text}`);
    }
    return result.result.value;
  }

  /** Waits for a selector to be rendered and visible, returns its centre point. */
  async waitForVisible(selector, { timeout, label } = {}) {
    return poll(async () => this.centerOf(selector), {
      timeout,
      label: label || `visible element ${selector}`,
    });
  }

  async waitForGone(selector, { timeout, label } = {}) {
    return poll(async () => !(await this.isVisible(selector)), {
      timeout,
      label: label || `element ${selector} to disappear`,
    });
  }

  /** Centre point of the first visible match, or null. */
  async centerOf(selector) {
    return this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => {
          const r = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
    })()`);
  }

  async isVisible(selector) {
    return Boolean(await this.centerOf(selector));
  }

  /** Real mouse click at the centre of the first visible match. */
  async click(selector, { timeout, button = 'left', clickCount = 1 } = {}) {
    const point = await this.waitForVisible(selector, { timeout, label: `clickable ${selector}` });
    await this.clickAt(point.x, point.y, { button, clickCount });
    return point;
  }

  async clickAt(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: buttonMask(button), clickCount });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
  }

  /**
   * Real drag: press at `from`, move through intermediate points, release at `to`.
   * Points are {x, y} in viewport CSS pixels.
   */
  async drag(from, to, { steps = 12 } = {}) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** Presses a key chord, e.g. key('z', { ctrl: true }) or key('Delete'). */
  async key(name, { ctrl = false, shift = false, alt = false } = {}) {
    const info = keyInfo(name);
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Types text one character at a time as real key presses. */
  async type(text) {
    for (const ch of text) {
      if (ch === '\n') {
        await this.key('Enter');
        continue;
      }
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  }

  /** Real click on the visible element whose text (or aria-label) is exactly `text`. */
  async clickText(text, { scope = 'body', timeout } = {}) {
    const point = await poll(() => this.evaluate(`(() => {
      const wanted = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll(${JSON.stringify(`${scope} button, ${scope} [role=menuitem], ${scope} [role=menuitemradio], ${scope} [role=option], ${scope} [role=tab], ${scope} a, ${scope} summary, ${scope} label`)})];
      const el = nodes.find((node) => {
        const label = (node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
        const r = node.getBoundingClientRect();
        return label === wanted && r.width > 0 && r.height > 0 && !node.disabled;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`), { timeout: timeout || DEFAULT_TIMEOUT_MS, label: `button "${text}"` });
    await this.clickAt(point.x, point.y);
  }

  /**
   * Real click on the first visible element matching `selector` for which
   * `predicate` (a JavaScript arrow function source) returns true.
   */
  async clickWhere(selector, predicate, { timeout } = {}) {
    const point = await poll(() => this.evaluate(`(() => {
      const test = ${predicate};
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && test(node);
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`), { timeout: timeout || DEFAULT_TIMEOUT_MS, label: `${selector} matching ${predicate}` });
    await this.clickAt(point.x, point.y);
  }

  /** Replaces the value of a text field the way a person does: click, select all, type. */
  async setValue(selector, text, { timeout } = {}) {
    await this.click(selector, { timeout });
    await this.key('a', { ctrl: true });
    await this.key('Delete');
    await this.type(text);
  }

  /** Picks an option of a native <select> with the keyboard (open, step, confirm). */
  async selectOption(selector, optionLabel, { timeout } = {}) {
    const info = await poll(() => this.evaluate(`(() => {
      const select = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.getBoundingClientRect().width > 0);
      if (!select) return null;
      const options = [...select.options];
      return { current: select.selectedIndex, target: options.findIndex((o) => o.textContent.trim() === ${JSON.stringify(optionLabel)}) };
    })()`), { timeout: timeout || DEFAULT_TIMEOUT_MS, label: `select ${selector}` });
    if (info.target < 0) throw new Error(`No option "${optionLabel}" in ${selector}`);
    await this.click(selector, { timeout });
    const steps = info.target - info.current;
    for (let i = 0; i < Math.abs(steps); i++) await this.key(steps > 0 ? 'ArrowDown' : 'ArrowUp');
    await this.key('Enter');
  }

  async screenshot(file) {
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const target = path.isAbsolute(file) ? file : path.join(this.artifactDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
    return target;
  }
}

function buttonMask(button) {
  return button === 'left' ? 1 : button === 'right' ? 2 : 4;
}

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};

function keyInfo(name) {
  if (KEY_CODES[name]) return KEY_CODES[name];
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    return { key: name.toLowerCase(), code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0) };
  throw new Error(`Unknown key name: ${name}`);
}

/**
 * Starts StepForge with a throwaway data folder and user-data folder.
 *
 * Options:
 *   dataDir       library folder (STEPFORGE_DATA_DIR); must already exist or be creatable
 *   userDataDir   Electron userData folder (settings bookkeeping); isolated per run
 *   artifactDir   where failure screenshots are written
 *   env           extra environment variables for the app
 */
async function launchApp({ dataDir, userDataDir, artifactDir, env = {}, withInspector = true }) {
  const cdpPort = await freePort();
  const inspectPort = withInspector ? await freePort() : null;
  const args = [
    '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${cdpPort}`,
  ];
  if (process.env.STEPFORGE_ALLOW_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  if (inspectPort) args.push(`--inspect=${inspectPort}`);
  args.push(REPO_ROOT);

  const childEnv = { ...process.env, ...env, STEPFORGE_DATA_DIR: dataDir };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const logChunks = [];
  const child = spawn(ELECTRON_BIN, args, { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => logChunks.push(chunk));
  child.stderr.on('data', (chunk) => logChunks.push(chunk));
  let exited = false;
  let launchError;
  child.on('error', (error) => { launchError = error; exited = true; });
  child.on('exit', () => { exited = true; });

  const app = {
    child,
    cdpPort,
    inspectPort,
    log: () => Buffer.concat(logChunks).toString('utf8'),
    page: null,
    main: null,
    close: null,
  };

  const cleanup = async () => {
    if (app.main) app.main.close();
    if (app.page) app.page.cdp.close();
    if (!exited) {
      child.kill('SIGTERM');
      await poll(() => exited, { timeout: 5000, label: 'StepForge to exit' }).catch(() => child.kill('SIGKILL'));
    }
  };
  app.close = cleanup;

  try {
    const target = await poll(async () => {
      if (exited) throw launchError || new Error(`StepForge exited: ${app.log().slice(-2000)}`);
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      return list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
    }, { timeout: 30000, label: 'StepForge window' });
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    app.page = new AppPage(cdp, artifactDir);
    // Page actions are also callable on the app itself: app.click(...), app.key(...).
    for (const name of Object.getOwnPropertyNames(AppPage.prototype)) {
      if (name !== 'constructor' && !(name in app)) app[name] = (...args) => app.page[name](...args);
    }
    await poll(async () => (await app.page.evaluate('document.readyState')) === 'complete', {
      timeout: 30000,
      label: 'renderer to finish loading',
    });
    if (withInspector) {
      app.main = await connectMainProcess(inspectPort);
      await app.main.evaluate(SHELL_STUB);
      await app.main.stubDialogs({});
    }
    return app;
  } catch (error) {
    await cleanup();
    throw new Error(`${error.message}\n--- app output ---\n${app.log().slice(-4000)}`);
  }
}

/** Node inspector connection to the main process, used only to stub native dialogs. */
async function connectMainProcess(inspectPort) {
  const list = await poll(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
    return targets.length ? targets : null;
  }, { timeout: 15000, label: 'main process inspector' });
  const cdp = new CdpClient(list[0].webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  return {
    cdp,
    close: () => cdp.close(),
    /**
     * Answers the next native dialogs from queues: { open: [{ filePaths }], save: [{ filePath }] }.
     * An empty queue answers "cancelled". Returns the dialogs asked so far.
     */
    async stubDialogs(answers) {
      await this.evaluate(dialogStubSource(answers));
    },
    /** Dialog calls and shell targets recorded so far in this app run. */
    async recordedCalls() {
      return this.evaluate('globalThis.__stepforgeTest || { dialogs: [], opened: [] }');
    },
    /** Puts a PNG file on the operating system clipboard, as if copied from another app. */
    async setClipboardImage(file) {
      // Electron 44 writes images through the web Clipboard API shape: a ClipboardItem with an image/png Blob.
      const written = await this.evaluate(`(async () => {
        const { clipboard, ClipboardItem } = process.mainModule.require('electron');
        const fs = process.mainModule.require('fs');
        const blob = new Blob([fs.readFileSync(${JSON.stringify(file)})], { type: 'image/png' });
        await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        const items = await clipboard.read();
        return items.some((item) => item.types.includes('image/png'));
      })()`);
      if (written !== true) throw new Error('Clipboard did not take the image');
    },
    /** Runs an expression in the Electron main process and returns its value. */
    async evaluate(expression) {
      const result = await withTimeout(cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }), DEFAULT_TIMEOUT_MS, 'main process evaluate');
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(`Main process expression failed: ${text}`);
      }
      return result.result.value;
    },
  };
}

module.exports = { launchApp, poll, freePort, REPO_ROOT, DEFAULT_TIMEOUT_MS };
