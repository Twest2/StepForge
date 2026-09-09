'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

class PortalBackend extends EventEmitter {
  constructor({ spawnProcess = spawn } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.nextId = 1;
    this.active = false;
    this.stopping = false;
    this.displays = [];
    this.offset = 0;
  }

  start(options = {}) {
    return new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.startTimer = setTimeout(() => this.fail('Screen sharing timed out. Start recording again.'), 150000);
      this.child = this.spawnProcess('/usr/bin/python3', ['-u', path.join(__dirname, 'portal_capture.py')], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      let errors = '';
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 64 * 1024 * 1024) return this.fail('Screen frame exceeded the capture memory limit.');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try { this.receive(JSON.parse(line)); }
          catch (error) { this.fail(`Invalid capture response: ${error.message}`); }
        }
      });
      this.child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-3000); });
      this.child.on('error', (error) => this.fail(error.message));
      this.child.stdin.on('error', (error) => { if (!this.stopping) this.fail(error.message); });
      this.child.on('exit', () => {
        if (!this.stopping) this.fail(errors.trim() || 'GNOME capture helper exited.');
      });
      this.send({ type: 'start', ...options });
    });
  }

  send(value) {
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  receive(msg) {
    if (msg.type === 'error') return this.fail(msg.reason);
    if (msg.type === 'ready') {
      clearTimeout(this.startTimer);
      this.displays = msg.displays;
      this.offset = msg.epochOffset;
      this.active = true;
      this.startResolve?.(true);
      this.startResolve = this.startReject = null;
    } else if (msg.type === 'armed') {
      this.armResolve?.();
      this.armResolve = null;
    } else if (msg.type === 'click' && !this.stopping) {
      this.emit('click', { ...msg, at: msg.at + this.offset });
    } else if (msg.id != null) {
      const request = this.pending.get(msg.id);
      if (!request) return;
      this.pending.delete(msg.id);
      clearTimeout(request.timer);
      if (msg.error) request.reject(new Error(msg.error));
      else request.resolve(msg);
      if (this.stopping && !this.pending.size) this.destroy();
    }
  }

  async arm() {
    if (!this.active) throw new Error('Screen sharing is not ready.');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.armResolve = null; reject(new Error('GNOME extension did not start.')); }, 5000);
      this.armResolve = () => { clearTimeout(timer); resolve(); };
      this.send({ type: 'arm' });
    });
  }

  request(type, args = {}) {
    if (!this.active || this.stopping) return Promise.reject(new Error('No active GNOME screen stream.'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Capture is busy encoding earlier clicks.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('GNOME capture request timed out.'));
        if (this.stopping && !this.pending.size) this.destroy();
      }, type === 'region' ? 125000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type, id, ...args });
    });
  }

  isActive() { return this.active && !this.stopping; }

  async frameForClick({ clickPos = null, clickAt = Date.now(), strict = true, leadMs = 0 } = {}) {
    const msg = await this.request('frame', { point: clickPos, at: clickAt - this.offset, strict, lead: leadMs });
    return { mode: 'fullscreen', png: Buffer.from(msg.png, 'base64'),
      size: { width: msg.width, height: msg.height }, display: msg.display,
      startedAt: msg.at + this.offset, capturedAt: msg.at + this.offset, source: 'gnome-portal' };
  }

  fail(reason) {
    if (this.stopping) return;
    this.startReject?.(new Error(reason));
    this.startReject = this.startResolve = null;
    this.emit('failure', reason);
    this.stop({ immediate: true });
  }

  stop({ immediate = false } = {}) {
    this.stopping = true;
    this.active = false;
    clearTimeout(this.startTimer);
    this.startReject?.(new Error('Recording cancelled.'));
    this.startReject = this.startResolve = null;
    this.send({ type: 'disarm' });
    if (immediate || !this.pending.size) this.destroy();
  }

  destroy() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('GNOME capture stopped.'));
    }
    this.pending.clear();
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
}

module.exports = { PortalBackend };
