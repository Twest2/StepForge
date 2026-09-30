'use strict';

/*
 * Private details: checking a guide's screenshots (app/redaction.js) and
 * reviewing what StepForge blurred. Used from the editor (More → Find
 * private details…) and the Publish to the web dialog.
 */

const privacyPlural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line summing up a review, e.g. "Blurred 3 private details in 2 steps." */
function privacySummary(review) {
  const blurs = review?.blurs?.length || 0;
  const text = review?.text?.length || 0;
  if (!blurs && !text) return 'No private details found.';
  const parts = [];
  if (blurs) parts.push(`blurred ${privacyPlural(blurs, 'possible private detail')}`);
  if (text) parts.push(`found ${privacyPlural(text, 'more')} in step text`);
  const sentence = parts.join(' and ');
  return `${sentence[0].toUpperCase()}${sentence.slice(1)} in ${privacyPlural(review.steps, 'step')}.`;
}

/**
 * Check a guide's screenshots, reporting progress through `onProgress(text)`.
 * Resolves with the review.
 */
async function runPrivacyCheck(api, guideId, onProgress = () => {}) {
  const stop = api.redact.onProgress((update) => {
    if (update?.guideId !== guideId) return;
    onProgress(update.total ? `Checking screenshots for private details… ${update.done} of ${update.total}` : 'Checking screenshots for private details…');
  });
  try {
    onProgress('Checking screenshots for private details…');
    return await api.redact.check({ guideId });
  } finally {
    stop();
  }
}

/**
 * The review list. `onShow(stepId, annotationId)` jumps to a blur in the
 * editor; without it (outside the editor) there's no Show button.
 * `onChange(review)` runs after every change.
 */
function privacyReviewList(api, guideId, review, { onShow = null, onChange = () => {} } = {}) {
  const node = el('div.privacy-review');
  const render = (current) => {
    node.replaceChildren();
    if (!current.blurs.length && !current.text.length) {
      node.append(el('p.muted', {}, 'Nothing to review. If you spot something private, use the Blur tool on that step.'));
      return;
    }
    const act = (button, label, action) => async () => {
      setButtonLoading(button, true, label);
      try {
        const next = await action();
        render(next);
        onChange(next);
      } catch (err) {
        setButtonLoading(button, false);
        toast(err.message, { error: true });
      }
    };
    for (const item of current.blurs) {
      const keep = el('button', { type: 'button', title: 'Remove this blur. StepForge won’t blur it again.' }, 'Not private');
      keep.addEventListener('click', act(keep, 'Removing…', () => api.redact.keepVisible({ guideId, stepId: item.stepId, annotationId: item.annotationId })));
      node.append(el('div.privacy-item', {},
        el('span.privacy-kind', {}, `Step ${item.stepNumber}`),
        el('span.privacy-label', {}, item.label, el('span.muted', {}, ' · blurred in the screenshot')),
        el('div.privacy-actions', {},
          onShow ? el('button', { type: 'button', onClick: () => onShow(item.stepId, item.annotationId) }, 'Show') : null,
          keep)));
    }
    for (const item of current.text) {
      const hide = el('button.primary', { type: 'button', title: 'Replace it with [hidden] in the step’s text.' }, 'Hide it');
      hide.addEventListener('click', act(hide, 'Hiding…', () => api.redact.hideText({ guideId, stepId: item.stepId })));
      const keep = el('button', { type: 'button' }, 'Not private');
      keep.addEventListener('click', act(keep, 'Saving…', () => api.redact.keepText({ guideId, stepId: item.stepId, key: item.key })));
      node.append(el('div.privacy-item.text', {},
        el('span.privacy-kind', {}, `Step ${item.stepNumber}`),
        el('span.privacy-label', {}, item.label, el('span.muted', {}, ` · “${item.preview}” in the ${item.field}`)),
        el('div.privacy-actions', {}, hide, keep)));
    }
  };
  render(review);
  return node;
}

/**
 * Check a guide and review the results in a dialog. Resolves when it
 * closes with { changed, show }: whether the guide changed (so an open
 * editor can reload), and the blur to jump to if the user chose Show.
 * `canShow` adds Show buttons (in the editor).
 */
function showPrivacyDialog({ api, guideId, canShow = false }) {
  return new Promise((resolve) => {
    let changed = false;
    const status = el('p.privacy-status', { role: 'status', 'aria-live': 'polite' }, 'Checking screenshots for private details…');
    const body = el('div.privacy-dialog', {}, status);
    const finish = (show = null) => resolve({ changed, show });
    const done = el('button.primary', { type: 'button', onClick: () => { close(); finish(); } }, 'Done');
    const { close } = openModal({ title: 'Private details', body, footer: [done], onClose: () => finish() });
    runPrivacyCheck(api, guideId, (text) => { status.textContent = text; })
      .then((review) => {
        changed = review.added > 0;
        status.textContent = review.checked ? privacySummary(review) : `${privacySummary(review)} Screenshots haven’t changed since they were last checked.`;
        body.append(
          el('p.muted', {}, 'Blurs are drawn into every export and published page. Check each one, and remove any that aren’t needed.'),
          privacyReviewList(api, guideId, review, {
            onShow: canShow ? (stepId, annotationId) => { close(); finish({ stepId, annotationId }); } : null,
            onChange: (next) => { changed = true; status.textContent = privacySummary(next); },
          }));
      })
      .catch((err) => { status.textContent = `StepForge couldn’t check the screenshots: ${err.message}`; status.classList.add('error'); });
  });
}
