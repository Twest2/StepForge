'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonIfExists, writeJsonSync } = require('./util');

class LibraryLocation {
  constructor({ file, defaultPath, override = null }) {
    Object.assign(this, { file, defaultPath: path.resolve(defaultPath), override });
    this.state = readJsonIfExists(file, {});
  }
  status() {
    return { current: this.override || this.state.current || this.defaultPath, defaultPath: this.defaultPath,
      pending: this.state.pending?.target || null, locked: Boolean(this.override), error: this.error || null,
      backup: this.state.backup || null };
  }
  validate(source, target) {
    fs.mkdirSync(target, { recursive: true });
    const from = fs.realpathSync(source), to = fs.realpathSync(target);
    const nested = (a, b) => { const rel = path.relative(a, b); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
    if (nested(from, to) || nested(to, from)) throw new Error('Choose a separate folder outside the current library.');
    if (fs.readdirSync(to).length) throw new Error('Choose an empty folder. Existing files will not be overwritten.');
    fs.accessSync(to, fs.constants.W_OK);
    return { source: from, target: to };
  }
  schedule(target) {
    if (this.override) throw new Error('STEPFORGE_DATA_DIR controls this session. Remove that override before changing storage.');
    const pending = this.validate(this.status().current, path.resolve(target));
    this.state = { ...this.state, current: pending.source, pending };
    writeJsonSync(this.file, this.state);
    return this.status();
  }
  cancel() { delete this.state.pending; writeJsonSync(this.file, this.state); return this.status(); }
  manifest(root) {
    const files = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        const relative = path.join(prefix, entry.name), full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error('The library contains symbolic links. Move it manually to preserve their targets.');
        if (entry.isDirectory()) { files.push([relative, 'directory']); walk(full, relative); }
        else if (entry.isFile()) files.push([relative, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
        else throw new Error('The library contains an unsupported file type.');
      }
    };
    walk(root); return JSON.stringify(files);
  }
  // Called only at startup, before store/sync/capture are created. Until the
  // verified destination is committed, the old library stays authoritative.
  applyPending() {
    if (this.override || !this.state.pending) return this.status().current;
    let staging;
    try {
      const { source, target } = this.validate(this.state.pending.source, this.state.pending.target);
      const before = this.manifest(source);
      staging = fs.mkdtempSync(path.join(path.dirname(target), '.stepforge-move-'));
      fs.cpSync(source, staging, { recursive: true, force: false, errorOnExist: true });
      if (before !== this.manifest(staging) || before !== this.manifest(source)) throw new Error('Library verification failed; the original is unchanged.');
      fs.rmdirSync(target); fs.renameSync(staging, target); staging = null;
      const previous = this.state;
      this.state = { current: target, backup: source };
      try { writeJsonSync(this.file, this.state); }
      catch (error) { this.state = previous; throw error; }
      // Keep one clearly named backup after the verified move; never purge data.
      const backup = `${source}.before-move-${Date.now()}`;
      try { fs.renameSync(source, backup); this.state.backup = backup; writeJsonSync(this.file, this.state); }
      catch { /* The original remains as a backup if renaming is unavailable. */ }
      return target;
    } catch (error) {
      this.error = `The library was not moved: ${error.message}`;
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      return this.status().current;
    }
  }
}
module.exports = { LibraryLocation };
