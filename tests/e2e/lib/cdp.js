'use strict';

// Minimal Chrome DevTools Protocol client built on the Node 22 global
// WebSocket. Only what the e2e driver needs: send a command, wait for its
// reply, evaluate an expression in the page, and collect events.

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
  }

  async connect(timeoutMs = 10000) {
    this.ws = new WebSocket(this.url);
    await withTimeout(
      new Promise((resolve, reject) => {
        this.ws.addEventListener('open', resolve, { once: true });
        this.ws.addEventListener('error', () => reject(new Error(`CDP socket failed: ${this.url}`)), { once: true });
      }),
      timeoutMs,
      `CDP connect to ${this.url}`
    );
    this.ws.addEventListener('message', (message) => this.onMessage(message.data));
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  onMessage(raw) {
    const message = JSON.parse(String(raw));
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result || {});
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers) for (const handler of handlers) handler(message.params || {});
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return withTimeout(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    }), 15000, method).finally(() => this.pending.delete(id));
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { CdpClient, withTimeout };
