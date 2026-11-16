'use strict';

const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { BrandingStore } = require('../../core/branding');
const { encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { escapeXml } = require('../../core/util');
const { makeTmpDir, rmrf } = require('./helpers');

const NOW = new Date('2026-01-01T00:00:00.000Z');

/** Real store -> AST fixtures. Every picture is generated from solid colors. */
function paginationFixture(t, specs, { sideBySide = false } = {}) {
  const root = makeTmpDir('docx-pagination');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Sample setup' });
  const keys = new Map();
  for (const spec of specs) {
    const text = (spec.instructions || '').repeat(spec.repeat || 1);
    const fields = {
      title: spec.title,
      descriptionHtml: text ? `<p>${escapeXml(text).replace(/\n/g, '<br>')}</p>` : '',
      parentStepId: spec.parent ? keys.get(spec.parent) : null,
      forceNewPage: Boolean(spec.newPage),
      annotations: spec.annotations || [],
      textBlocks: (spec.notes || []).map((note, i) => ({
        id: `note-${i}`, position: note.position, level: note.level || 'info',
        title: note.title || '', order: i + 1,
        descriptionHtml: `<p>${escapeXml(note.text || '')}</p>`,
      })),
    };
    let png = null;
    let size = null;
    if (spec.screenshot) {
      const [width, height] = spec.screenshot;
      const picture = raster.createImage(width, height, [224, 232, 240, 255]);
      raster.fillRect(picture, 0, 0, width, Math.max(1, Math.floor(height / 8)), [48, 64, 80, 255]);
      png = encodePng(picture);
      size = { width, height };
    }
    const step = store.addStep(guide.guideId, fields, png, size);
    if (spec.key) keys.set(spec.key, step.stepId);
  }
  let branding = null;
  if (sideBySide) {
    const brands = new BrandingStore(path.join(root, 'settings'));
    const profile = brands.save({ name: 'Sample layout', screenshots: { layout: 'side-by-side' } });
    branding = brands.resolve(profile.id);
  }
  const ast = buildRenderAst(store, guide.guideId, { now: NOW, branding });
  return { root, ast, store, guide };
}

module.exports = { paginationFixture };
