'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync } = require('./zip');
const { writeJsonSync, readJsonSync, atomicWriteFileSync, nowIso } = require('./util');

/**
 * Per-format export templates stored under settings/templates/<format>/.
 * Templates are plain JSON option objects merged over each exporter's
 * defaults, shareable as .sfglt zip files.
 */

const FORMATS = ['json', 'markdown', 'html-simple', 'html-rich', 'confluence', 'pdf', 'gif', 'image-bundle', 'docx', 'pptx'];

class TemplateManager {
  constructor(templatesDir) {
    this.dir = templatesDir;
  }

  formatDir(format) {
    if (!FORMATS.includes(format)) throw new Error(`unknown export format: ${format}`);
    return path.join(this.dir, format);
  }

  fileFor(format, name) {
    if (!/^[A-Za-z0-9 _-]+$/.test(name)) throw new Error(`bad template name: ${name}`);
    return path.join(this.formatDir(format), `${name}.template.json`);
  }

  list(format) {
    const dir = this.formatDir(format);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.template.json'))
      .map((f) => f.slice(0, -'.template.json'.length))
      .sort();
  }

  load(format, name) {
    const file = this.fileFor(format, name);
    if (!fs.existsSync(file)) return null;
    return readJsonSync(file).options || {};
  }

  save(format, name, options) {
    writeJsonSync(this.fileFor(format, name), {
      schemaVersion: 1, format, name, updatedAt: nowIso(), options,
    });
    return name;
  }

  rename(format, oldName, newName) {
    const src = this.fileFor(format, oldName);
    if (!fs.existsSync(src)) throw new Error(`template not found: ${oldName}`);
    const options = readJsonSync(src).options;
    this.save(format, newName, options);
    fs.rmSync(src);
  }

  duplicate(format, name, copyName) {
    const options = this.load(format, name);
    if (options === null) throw new Error(`template not found: ${name}`);
    return this.save(format, copyName || `${name} copy`, options);
  }

  remove(format, name) {
    fs.rmSync(this.fileFor(format, name), { force: true });
  }

  /** Export one template as a shareable .sfglt file. */
  exportTemplate(format, name, destFile) {
    const options = this.load(format, name);
    if (options === null) throw new Error(`template not found: ${name}`);
    const manifest = { format: 'stepforge-template-archive', formatVersion: 1, exportFormat: format, name, exportedAt: nowIso() };
    atomicWriteFileSync(destFile, zipSync([
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
      { name: 'template.json', data: JSON.stringify({ options }, null, 2) },
    ]));
    return destFile;
  }

  /** Import a .sfglt file; returns { format, name }. */
  importTemplate(file) {
    const entries = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data]));
    if (!entries.has('manifest.json') || !entries.has('template.json')) {
      throw new Error('not a StepForge template archive');
    }
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    if (manifest.format !== 'stepforge-template-archive') throw new Error('unsupported template archive');
    const { options } = JSON.parse(entries.get('template.json').toString('utf8'));
    let name = manifest.name || 'imported';
    if (this.list(manifest.exportFormat).includes(name)) name = `${name} (imported)`;
    this.save(manifest.exportFormat, name, options || {});
    return { format: manifest.exportFormat, name };
  }
}

module.exports = { TemplateManager, FORMATS };
