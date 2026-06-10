'use strict';

const { GuideStore } = require('../../core/store');
const raster = require('../../core/raster');
const { encodePng } = require('../../core/png');

/**
 * Build a realistic guide used by exporter tests: real PNG screenshots,
 * annotations, substeps, text/code/table blocks, placeholders, and a
 * hidden + skipped step to exercise filtering.
 */
function buildFixtureGuide(rootDir) {
  const store = new GuideStore(rootDir);
  const guide = store.createGuide({
    title: 'Configure [[Product]] backups',
    descriptionHtml: '<p>Maintained by <strong>[[Author]]</strong>.</p>',
    placeholders: { Product: 'AcmeSync', Author: 'Casey' },
  });

  // screenshot 1: blue window with a light panel
  const shot1 = raster.createImage(320, 200, [40, 60, 200, 255]);
  raster.fillRect(shot1, 40, 30, 240, 140, [240, 240, 245, 255]);
  const s1 = store.addStep(guide.guideId, {
    title: 'Open [[Product]] settings',
    descriptionHtml: '<p>Click the <b>gear</b> icon, then choose <a href="https://docs.example.com">Settings</a>.</p>',
    annotations: [
      { type: 'rect', x: 0.125, y: 0.15, w: 0.75, h: 0.7, style: { stroke: '#FF0000', strokeWidth: 6, fill: 'transparent' } },
      { type: 'number', value: 1, x: 0.02, y: 0.05, w: 0.12, h: 0.2, style: { stroke: '#E5484D' } },
    ],
  }, encodePng(shot1), { width: 320, height: 200 });

  const sub = store.addStep(guide.guideId, {
    kind: 'empty',
    parentStepId: s1.stepId,
    title: 'Verify the gear icon is visible',
    textBlocks: [{ position: 'after-description', level: 'warn', title: 'Access', descriptionHtml: '<p>Admins only.</p>' }],
  });

  const shot2 = raster.createImage(320, 200, [20, 140, 90, 255]);
  const s2 = store.addStep(guide.guideId, {
    title: 'Enable nightly backups',
    descriptionHtml: '<p>Use the schedule below.</p>',
    codeBlocks: [{ id: 'cb1', language: 'cron', code: '0 2 * * * /usr/local/bin/acmesync --backup' }],
    tableBlocks: [{ id: 'tb1', rows: [['Day', 'Window'], ['Weekdays', '02:00-03:00'], ['Weekends', '04:00-05:00']] }],
  }, encodePng(shot2), { width: 320, height: 200 });

  const hidden = store.addStep(guide.guideId, { kind: 'empty', title: 'Internal-only note', hidden: true });
  const skipped = store.addStep(guide.guideId, { kind: 'empty', title: 'Legacy path', skipped: true });

  return { store, guide: store.getGuide(guide.guideId), s1, sub, s2, hidden, skipped };
}

module.exports = { buildFixtureGuide };
