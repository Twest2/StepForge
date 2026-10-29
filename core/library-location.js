'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonIfExists, writeJsonSync } = require('./util');

// What StepForge keeps in a library folder. Only these move: on Windows the
// old default folder (%APPDATA%\stepforge) is also Electron's profile, whose
// browser files must stay. temp/ and the ocr/ cache are rebuilt as needed.
const LIBRARY_ENTRIES = ['settings', 'library', 'shared-links', 'cloud'];
// The old copy stays until the user removes it: another install may still
// be writing there, so its age cannot make automatic deletion safe.

const hasLibrary = (dir) => Boolean(dir) && ['library', 'settings'].some((name) => fs.existsSync(path.join(dir, name)));
const samePath = (a, b) => {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return Boolean(a && b) && norm(a) === norm(b);
};

class LibraryLocation {
  /**
   * `legacyPath` is where the library used to be by default (Windows:
   * %APPDATA%\stepforge). Until it has been moved to `defaultPath`, a library
   * there stays the current one, so nothing disappears, including for the MCP
   * server, which never moves anything.
   */
  constructor({ file, defaultPath, override = null, legacyPath = null }) {
    Object.assign(this, { file, defaultPath: path.resolve(defaultPath), override, legacyPath: legacyPath ? path.resolve(legacyPath) : null });
    this.state = readJsonIfExists(file, {});
  }
  status() {
    const legacy = this.legacyPath && !samePath(this.legacyPath, this.defaultPath) && hasLibrary(this.legacyPath) ? this.legacyPath : null;
    return { current: this.override || this.state.current || legacy || this.defaultPath, defaultPath: this.defaultPath,
      pending: this.state.pending?.target || null, locked: Boolean(this.override), error: this.error || null,
      backup: this.state.backup || null };
  }
  /**
   * Moves a library in the old default folder to the new one, automatically:
   * scheduled here, done by applyPending() at the same startup. Not when the
   * user chose a folder, or a move of their own is waiting.
   */
  scheduleMigration() {
    if (this.override || this.state.current || this.state.pending) return false;
    if (this.status().current !== this.legacyPath) return false;
    if (hasLibrary(this.defaultPath)) {
      // Another StepForge (the Microsoft Store one, say) already uses the new
      // folder. Keep using the old one rather than mix the two.
      this.error = `Your guides are still in ${this.legacyPath}, because ${this.defaultPath} already holds a StepForge library.`;
      return false;
    }
    this.state = { ...this.state, pending: { source: this.legacyPath, target: this.defaultPath, automatic: true } };
    return true;
  }
  validate(source, target, { allowNonEmpty = false } = {}) {
    fs.mkdirSync(target, { recursive: true });
    const from = fs.realpathSync(source), to = fs.realpathSync(target);
    const nested = (a, b) => { const rel = path.relative(a, b); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
    if (nested(from, to) || nested(to, from)) throw new Error('Choose a separate folder outside the current library.');
    if (!allowNonEmpty && fs.readdirSync(to).length) throw new Error('Choose an empty folder. Existing files will not be overwritten.');
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
  /** Every file and folder in the library's own entries (LIBRARY_ENTRIES), with each file's hash. */
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
    for (const name of LIBRARY_ENTRIES) {
      const full = path.join(root, name);
      if (!fs.existsSync(full)) continue;
      if (!fs.lstatSync(full).isDirectory()) throw new Error(`The library's ${name} is not a folder.`);
      files.push([name, 'directory']); walk(full, name);
    }
    return JSON.stringify(files);
  }
  // Called only at startup, before store/sync/capture are created. Until the
  // verified destination is committed, the old library stays authoritative.
  applyPending() {
    if (this.override || !this.state.pending) return this.status().current;
    const automatic = this.state.pending.automatic === true;
    let holder, installedTarget;
    try {
      const remembered = automatic && typeof this.state.pending.copiedManifest === 'string'
        ? this.state.pending.copiedManifest : null;
      const { source, target } = this.validate(this.state.pending.source, this.state.pending.target, { allowNonEmpty: remembered !== null });
      const before = this.manifest(source);
      const recoverCopy = remembered !== null && fs.readdirSync(target).length > 0;
      if (recoverCopy) {
        // A previous attempt installed its verified copy, but could neither
        // commit the location file nor move the copy back. Adopt it only if
        // neither side has changed since that attempt.
        if (before !== remembered || this.manifest(target) !== remembered) {
          throw Object.assign(new Error('A previous migration left two different library copies. Both have been kept; choose an empty folder in Guide storage or combine the copies manually before trying again.'), { code: 'MIGRATION_DIVERGED' });
        }
      } else {
        // Copy into a new staging folder, on the destination's filesystem.
        holder = fs.mkdtempSync(path.join(path.dirname(target), '.stepforge-move-'));
        const staging = path.join(holder, 'library');
        fs.mkdirSync(staging);
        for (const name of LIBRARY_ENTRIES) {
          if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(staging, name), { recursive: true, force: false, errorOnExist: true });
        }
        if (before !== this.manifest(staging) || before !== this.manifest(source)) throw new Error('Library verification failed; the original is unchanged.');
        if (automatic) {
          // Record ownership and exact content before installing the copy,
          // so a failed rollback (or interrupted startup) can be recovered.
          this.state = { ...this.state, pending: { ...this.state.pending, copiedManifest: before } };
          writeJsonSync(this.file, this.state);
        }
        fs.rmdirSync(target); fs.renameSync(staging, target); installedTarget = target;
      }
      const previous = this.state;
      this.state = automatic ? { current: target, backup: source, migrated: { from: source, at: new Date().toISOString() } } : { current: target, backup: source };
      try { writeJsonSync(this.file, this.state); }
      catch (error) { this.state = previous; throw error; }
      // The switch is durable now. A staging-directory cleanup failure must
      // not turn a successful move into a reported failure.
      installedTarget = null;
      try { if (holder) fs.rmdirSync(holder); } catch { /* an empty staging directory can be removed later */ }
      holder = null;
      if (automatic) return target;
      // Keep one clearly named backup after the verified move; never purge data.
      // Not when this bookkeeping file lives in the old folder (Windows keeps
      // it in Electron's profile, the old default library folder).
      const backup = `${source}.before-move-${Date.now()}`;
      const fromSource = path.relative(source, path.resolve(this.file));
      const fileInSource = Boolean(fromSource) && !fromSource.startsWith('..') && !path.isAbsolute(fromSource);
      if (!fileInSource) {
        try { fs.renameSync(source, backup); this.state.backup = backup; writeJsonSync(this.file, this.state); }
        catch { /* The original remains as a backup if renaming is unavailable. */ }
      }
      return target;
    } catch (error) {
      // If the location file could not be committed, the old library is
      // still authoritative. Restore an empty destination so the next start
      // can retry, rather than refusing our own verified copy as another
      // installation's library.
      if (installedTarget) {
        try {
          fs.renameSync(installedTarget, path.join(holder, 'library'));
          fs.mkdirSync(installedTarget);
        } catch { /* preserve both copies if rolling back is unavailable */ }
      }
      try { if (holder) fs.rmSync(holder, { recursive: true, force: true }); } catch { /* preserve a locked staging copy */ }
      if (automatic) {
        // The old folder stays current. A durable checkpoint lets the next
        // start retry safely, including after an unsuccessful rollback.
        const { source } = this.state.pending;
        delete this.state.pending;
        const recoveryNeeded = error.code === 'MIGRATION_DIVERGED';
        this.error = `Your guides are still in ${source}: StepForge couldn't move them to ${this.defaultPath} (${error.message}).${recoveryNeeded ? '' : ' It tries again the next time it starts.'}`;
        return this.status().current;
      }
      this.error = `The library was not moved: ${error.message}`;
      return this.status().current;
    }
  }
}
module.exports = { LibraryLocation, LIBRARY_ENTRIES };
