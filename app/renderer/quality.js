'use strict';

/*
 * Guide quality checks (core/quality.js), shown at the top of the Export
 * dialog and the Publish dialogs. A warning only: exporting still works.
 * Each finding is a button that jumps to what needs fixing.
 */

/** What a finding says, e.g. "[[Product]] has no value". */
function qualityLabel(finding) {
  if (finding.kind === 'placeholder') {
    const names = finding.names.map((name) => `[[${name}]]`).join(', ');
    return finding.names.length === 1 ? `${names} has no value` : `${names} have no value`;
  }
  if (finding.kind === 'screenshot') {
    return finding.detail === 'file-missing' ? 'Screenshot file is missing' : 'No screenshot';
  }
  return finding.detail === 'automatic' ? `Still has the automatic title “${finding.title}”` : 'No title';
}

/**
 * The warning box, or null when there's nothing to fix. `onShow(finding)`
 * runs when a finding is clicked; the caller closes its dialog there.
 */
function qualityPanel(findings, onShow) {
  if (!findings?.length) return null;
  const count = findings.length;
  return el('div.quality-panel', { role: 'group', 'aria-label': 'Things to check' },
    el('div.quality-head', {}, `${count} thing${count === 1 ? '' : 's'} to check before sharing`,
      el('span.muted', {}, ' · you can still export as it is')),
    el('div.quality-list', {}, findings.map((finding) => el('button.quality-item', {
      type: 'button',
      title: finding.stepId ? `Go to step ${finding.stepNumber}` : 'Open the guide’s placeholders',
      onClick: () => onShow(finding),
    },
    el('span.quality-where', {}, finding.stepId ? `Step ${finding.stepNumber}` : 'Guide'),
    el('span.quality-label', {}, qualityLabel(finding))))));
}

/**
 * Check a guide and put the warning box in `host` (an empty element above
 * the dialog's content) if anything needs fixing. Failing to check never
 * gets in the way of publishing.
 */
async function addQualityPanel(api, guideId, host, onShow) {
  try {
    const panel = qualityPanel(await api.guide.quality({ guideId }), onShow);
    if (panel && host.isConnected) host.replaceChildren(panel);
  } catch {
    // Only a warning; the dialog works without it.
  }
}
