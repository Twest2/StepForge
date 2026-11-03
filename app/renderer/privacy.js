'use strict';

/*
 * Private details: checking a guide's screenshots (app/redaction.js) and
 * reviewing what StepForge blurred. Used from the editor (More → Find
 * private details…) and the Publish to the web dialog.
 */

/** One line summing up a review, e.g. "Blurred 3 possible private details in 2 steps." */
function privacySummary(review) {
  const blurs = review?.blurs?.length || 0;
  const text = review?.text?.length || 0;
  if (!blurs && !text) return t('No private details found.');
  const steps = tn(review.steps, 'in {count} step', 'in {count} steps');
  if (!text) return t('{found} {steps}.', { found: tn(blurs, 'Blurred {count} possible private detail', 'Blurred {count} possible private details'), steps });
  if (!blurs) return t('{found} {steps}.', { found: tn(text, 'Found {count} possible private detail in step text', 'Found {count} possible private details in step text'), steps });
  return t('{blurred} and {found} {steps}.', {
    blurred: tn(blurs, 'Blurred {count} possible private detail', 'Blurred {count} possible private details'),
    found: tn(text, 'found {count} more in step text', 'found {count} more in step text'),
    steps,
  });
}

/**
 * Check a guide's screenshots, reporting progress through `onProgress(text)`.
 * Resolves with the review.
 */
async function runPrivacyCheck(api, guideId, onProgress = () => {}) {
  const stop = api.redact.onProgress((update) => {
    if (update?.guideId !== guideId) return;
    onProgress(update.total
      ? t('Checking screenshots for private details… {done} of {total}', { done: update.done, total: update.total })
      : t('Checking screenshots for private details…'));
  });
  try {
    onProgress(t('Checking screenshots for private details…'));
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
      node.append(el('p.muted', {}, t('Nothing to review. If you spot something private, use the Blur tool on that step.')));
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
      const keep = el('button', { type: 'button', title: t('Remove this blur. StepForge won’t blur it again.') }, t('Not private'));
      keep.addEventListener('click', act(keep, t('Removing…'), () => api.redact.keepVisible({ guideId, stepId: item.stepId, annotationId: item.annotationId })));
      node.append(el('div.privacy-item', {},
        el('span.privacy-kind', {}, t('Step {number}', { number: item.stepNumber })),
        el('span.privacy-label', {}, item.label, el('span.muted', {}, ` · ${t('blurred in the screenshot')}`)),
        el('div.privacy-actions', {},
          onShow ? el('button', { type: 'button', onClick: () => onShow(item.stepId, item.annotationId) }, t('Show')) : null,
          keep)));
    }
    for (const item of current.text) {
      const hide = el('button.primary', { type: 'button', title: t('Replace it with [hidden] in the step’s text.') }, t('Hide it'));
      hide.addEventListener('click', act(hide, t('Hiding…'), () => api.redact.hideText({ guideId, stepId: item.stepId })));
      const keep = el('button', { type: 'button' }, t('Not private'));
      keep.addEventListener('click', act(keep, t('Saving…'), () => api.redact.keepText({ guideId, stepId: item.stepId, key: item.key })));
      node.append(el('div.privacy-item.text', {},
        el('span.privacy-kind', {}, t('Step {number}', { number: item.stepNumber })),
        el('span.privacy-label', {}, item.label, el('span.muted', {}, ` · ${item.field === 'title'
          ? t('“{text}” in the title', { text: item.preview })
          : t('“{text}” in the description', { text: item.preview })}`)),
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
    const status = el('p.privacy-status', { role: 'status', 'aria-live': 'polite' }, t('Checking screenshots for private details…'));
    const body = el('div.privacy-dialog', {}, status);
    const finish = (show = null) => resolve({ changed, show });
    const done = el('button.primary', { type: 'button', onClick: () => { close(); finish(); } }, t('Done'));
    const { close } = openModal({ title: t('Private details'), body, footer: [done], onClose: () => finish() });
    runPrivacyCheck(api, guideId, (text) => { status.textContent = text; })
      .then((review) => {
        changed = review.added > 0;
        status.textContent = review.checked ? privacySummary(review) : `${privacySummary(review)} ${t('Screenshots haven’t changed since they were last checked.')}`;
        body.append(
          el('p.muted', {}, t('Blurs are drawn into every export and published page. Check each one, and remove any that aren’t needed.')),
          privacyReviewList(api, guideId, review, {
            onShow: canShow ? (stepId, annotationId) => { close(); finish({ stepId, annotationId }); } : null,
            onChange: (next) => { changed = true; status.textContent = privacySummary(next); },
          }));
      })
      .catch((err) => { status.textContent = t('StepForge couldn’t check the screenshots: {error}', { error: err.message }); status.classList.add('error'); });
  });
}
