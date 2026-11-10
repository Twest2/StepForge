'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('./util');
const { readImageSize } = require('./image-format');

/**
 * "Welcome to StepForge": a short sample guide a new installation starts
 * with, written in the interface language. Its screenshots are pictures of
 * StepForge itself (app/assets/welcome-guide/). It is added once: app/main.js
 * only calls this for a new library and then remembers that it did, so a
 * deleted welcome guide stays deleted.
 */

const IMAGES_DIR = path.join(__dirname, '..', 'app', 'assets', 'welcome-guide');

/** "Ctrl+Shift+1" from an accelerator such as "CommandOrControl+Shift+1". */
const keys = (accelerator) => String(accelerator || '').replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl');

/**
 * A paragraph from a translated sentence; each {name} becomes the bold label
 * of the button or menu it names, in the interface language too.
 */
function paragraph(text, labels = {}) {
  const html = escapeHtml(text).replace(/\{(\w+)\}/g, (whole, name) => (
    labels[name] == null ? whole : `<strong>${escapeHtml(labels[name])}</strong>`));
  return `<p>${html}</p>`;
}

/** Label without its menu arrow: "More ▾" → "More". */
const menu = (label) => String(label).replace(/\s*▾$/, '');

/**
 * True on StepForge's first start with this library: no settings file yet
 * and no guides. (A library moved or synced from elsewhere has both.)
 */
function isNewLibrary(store) {
  return !fs.existsSync(path.join(store.settingsDir, 'app-settings.json')) && store.listGuides().length === 0;
}

function image(name) {
  const data = fs.readFileSync(path.join(IMAGES_DIR, name));
  return { data, size: readImageSize(data) };
}

/**
 * Adds the welcome guide to `store`; returns its guideId. `t` translates
 * into the interface language; `hotkeys` are this computer's recording
 * shortcuts (Settings → Recording).
 */
function addWelcomeGuide(store, { t, hotkeys = {} } = {}) {
  const guide = store.createGuide({
    title: t('Welcome to StepForge'),
    descriptionHtml: paragraph(t('A sample guide to show you around. Delete it whenever you like: it won’t come back.')),
  });
  const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h, style: { stroke: '#E5484D', strokeWidth: 4, fill: 'transparent' } });
  const badge = (value, x, y) => ({ type: 'number', value, x, y, w: 0.045, h: 0.07, style: { stroke: '#E5484D' } });

  const steps = [
    {
      title: t('Start a new capture'),
      descriptionHtml: paragraph(t('Click {button}, then do your task as usual. Every click becomes a step: a screenshot, a marker where you clicked, and a title read from what you clicked.'), { button: t('New Capture') }),
      textBlocks: [{
        position: 'after-description', level: 'success',
        descriptionHtml: paragraph(t('When you’re done, click {button} at the top right.'), { button: t('Stop recording') }),
      }],
      annotations: [rect(0.150, 0.848, 0.232, 0.088)],
      file: 'start-capture.webp',
    },
    {
      title: t('Tidy up your steps'),
      descriptionHtml: paragraph(t('Pick a step on the left, then change its title and description on the right. Move steps up or down, or hide the ones readers don’t need.')),
      annotations: [
        rect(0.005, 0.158, 0.24, 0.272), badge(1, 0.222, 0.128),
        rect(0.751, 0.131, 0.233, 0.048), badge(2, 0.94, 0.098),
        rect(0.751, 0.52, 0.233, 0.182), badge(3, 0.94, 0.488),
      ],
      file: 'edit-steps.webp',
    },
    {
      title: t('Draw on the screenshot'),
      descriptionHtml: paragraph(t('Use the toolbar above the screenshot to add boxes, arrows, numbers, text and blur.')),
      textBlocks: [{
        position: 'after-image', level: 'warn', title: t('Before you share'),
        descriptionHtml: paragraph(t('Choose {menu} to find email addresses, passwords and keys in your screenshots and blur them.'),
          { menu: `${menu(t('More ▾'))} → ${t('Find private details…')}` }),
      }],
      annotations: [rect(0.26, 0.068, 0.455, 0.055)],
      file: 'annotate.webp',
    },
    {
      title: t('Add code and tables'),
      kind: 'empty',
      descriptionHtml: paragraph(t('Steps can hold code with syntax colors, tables and notes, so setup guides and runbooks stay ready to copy and paste.')),
      codeBlocks: [{ language: 'bash', code: 'git clone https://github.com/your-org/your-app.git\ncd your-app\nnpm install' }],
      tableBlocks: [{ rows: [
        [t('Shortcut'), t('What it does')],
        [keys(hotkeys.capture || 'CommandOrControl+Shift+1'), t('Take a step without clicking')],
        [keys(hotkeys.pauseResume || 'CommandOrControl+Shift+2'), t('Pause or resume recording')],
      ] }],
    },
    {
      title: t('Export or share it'),
      descriptionHtml: paragraph(t('Click {export} to save a PDF, Word, PowerPoint, Markdown or HTML file. {share} puts the guide on the web, in Confluence or in Wiki.js.'),
        { export: t('Export'), share: menu(t('Share ▾')) }),
      textBlocks: [{
        position: 'after-image', level: 'success', title: t('Make it yours'),
        descriptionHtml: paragraph(t('Add your logo, colors and fonts to every export in {place}.'), { place: `${t('Settings')} → ${t('Branding')}` }),
      }],
      annotations: [rect(0.243, 0.128, 0.638, 0.07)],
      file: 'export.webp',
    },
  ];

  for (const { file, ...fields } of steps) {
    const shot = file ? image(file) : null;
    store.addStep(guide.guideId, fields, shot?.data || null, shot?.size || null);
  }
  return guide.guideId;
}

module.exports = { addWelcomeGuide, isNewLibrary, IMAGES_DIR };
