'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readJsonIfExists, writeJsonSync } = require('../core/util');
const { t } = require('../core/ui-text');

/*
 * A Markdown folder on this computer: an Obsidian vault, a MkDocs or
 * Docusaurus docs folder, an Azure DevOps or GitHub wiki checkout, or any
 * other. Publishing writes the guide with the Markdown export
 * (exporters/markdown.js) and the same choices it offers (what to write for,
 * contents list, screenshots, Azure's screenshot width), with its
 * screenshots in a steps-<slug> folder beside it. Nothing to sign in to, so
 * the folder and choices are kept in a plain settings file.
 */

const FLAVORS = { obsidian: 'Obsidian', standard: 'Markdown', github: 'GitHub', azure: 'Azure DevOps wiki', mkdocs: 'MkDocs', docusaurus: 'Docusaurus' };
// The Markdown exporter's target for each kind of folder; Obsidian's callouts are GitHub's alert syntax.
const MARKDOWN_TARGET = { obsidian: 'github', standard: 'standard', github: 'github', azure: 'azure', mkdocs: 'mkdocs', docusaurus: 'docusaurus' };

class MarkdownFolder {
  /** `chooseFolder()` resolves with a folder the user picked, or null. */
  constructor({ directory, chooseFolder }) {
    this.label = 'Markdown folder';
    this.file = path.join(directory, 'publish-markdown-folder.json');
    this.pagesFile = path.join(directory, 'publish-markdown-folder-pages.json');
    this.chooseFolder = chooseFolder;
  }

  get config() { return readJsonIfExists(this.file, null); }

  status() {
    const config = this.config;
    return { connected: Boolean(config?.folder), available: true, account: config?.folder || '', site: FLAVORS[config?.flavor] || '', flavor: config?.flavor || '', error: null };
  }

  async connect({ flavor = 'obsidian', toc = 'no', images = 'yes', imageMaxWidth = '' } = {}) {
    if (!FLAVORS[flavor]) throw new Error(t('Choose what the folder is for.'));
    const width = String(imageMaxWidth).trim() ? Number(imageMaxWidth) : 0;
    if (!Number.isInteger(width) || width < 0 || width > 10000) throw new Error(t('Enter a screenshot width in pixels, or leave it empty.'));
    const folder = await this.chooseFolder(flavor === 'obsidian' ? t('Choose your Obsidian vault') : t('Choose the folder to publish guides to'));
    if (!folder) return this.status();
    writeJsonSync(this.file, { folder, flavor, toc: toc === 'yes', includeImages: images !== 'no', imageMaxWidth: width });
    return this.status();
  }

  disconnect() {
    fs.rmSync(this.file, { force: true });
    return this.status();
  }

  cancel() {}
  async recover() { return false; }
  async targets() { return []; }
  /** The Markdown export's options for this folder. */
  markdownOptions() {
    const config = this.config || {};
    return { target: MARKDOWN_TARGET[config.flavor] || 'github', toc: config.toc === true, includeImages: config.includeImages !== false,
      imageMaxWidth: Number(config.imageMaxWidth) || 0 };
  }

  publishedFor(guideId) {
    const folder = this.config?.folder;
    return folder ? readJsonIfExists(this.pagesFile, {})[folder]?.[guideId] || null : null;
  }

  /** `page.file` is the exported <slug>.md, beside its steps-<slug> folder. */
  async publish({ guideId, title, page, replace = false, onProgress = () => {} }) {
    const folder = this.config?.folder;
    if (!folder || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(t('The folder to publish to is missing. Choose it again in Settings → Accounts → Publishing.'));
    }
    const known = this.publishedFor(guideId);
    const name = known?.name || path.basename(page.file);
    const target = path.join(folder, name);
    const exists = fs.existsSync(target);
    if (exists && !known && !replace) return { conflict: { path: target, title: name } };
    onProgress({ stage: 'page' });
    const slug = path.basename(page.file, '.md');
    const images = path.join(path.dirname(page.file), `steps-${slug}`);
    const targetImages = path.join(folder, `steps-${path.basename(name, '.md')}`);
    let markdown = fs.readFileSync(page.file, 'utf8');
    // A guide renamed since it was first published keeps its file and image folder names.
    if (targetImages !== path.join(folder, `steps-${slug}`)) markdown = markdown.split(`steps-${slug}/`).join(`${path.basename(targetImages)}/`);
    fs.rmSync(targetImages, { recursive: true, force: true });
    if (fs.existsSync(images)) fs.cpSync(images, targetImages, { recursive: true });
    fs.writeFileSync(target, markdown);
    const all = readJsonIfExists(this.pagesFile, {});
    const remembered = { name, title, path: target, url: pathToFileURL(target).href, publishedAt: new Date().toISOString() };
    all[folder] = { ...(all[folder] || {}), [guideId]: remembered };
    writeJsonSync(this.pagesFile, all);
    return { ...remembered, updated: exists };
  }
}

module.exports = { MarkdownFolder, MARKDOWN_TARGET };
