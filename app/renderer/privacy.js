'use strict';

/*
 * Private details: checking a guide's screenshots (app/redaction.js) and
 * reviewing what StepForge blurred. Used from the editor (More → Find
 * private details…) and the Publish to the web dialog.
 */

// What each kind of private detail is called (core/redaction.js KINDS); app/redaction.js sends the English name.
const PRIVACY_KIND_LABELS = {
  email: t('Email address'), phone: t('Phone number'), card: t('Card number'), ssn: t('Social Security number'),
  ip: t('IP address'), secret: t('Password or key'), url: t('Link with a private token'), custom: t('Word you asked to hide'),
};
const privacyKindLabel = (item) => PRIVACY_KIND_LABELS[item.kind] || item.label || t('Private detail');

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
  // Screenshots draw as they scroll into view, like the snapshot comparison.
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      entry.target.cmpLoad?.();
    }
  }, { rootMargin: '200px 0px' });
  const holders = new Set();
  const observer = { observe: (holder) => { holders.add(holder); io.observe(holder); } };
  // Each screenshot's canvas holds its image until destroyed, so they go with the list they're in.
  const clear = () => {
    io.disconnect();
    for (const holder of holders) holder.cmpCanvas?.destroy();
    holders.clear();
  };
  // Whoever shows the list calls this when its dialog closes.
  node.dispose = clear;
  const loadImage = (side, file) => api.snapshots.compareImage({ guideId, name: null, file });
  const render = (current) => {
    clear();
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
      const accept = el('button.primary', { type: 'button', title: t('Keep this blur.') }, t('Accept'));
      accept.addEventListener('click', act(accept, t('Saving…'), () => api.redact.accept({ guideId, stepId: item.stepId, annotationId: item.annotationId })));
      // Before is the screenshot without this blur, after is with it, drawn like a snapshot comparison.
      const images = item.file ? window.StepForgeCompare.imageCompare({ label: '', status: 'changed',
        before: { file: item.file, annotations: (item.annotations || []).filter((a) => a.id !== item.annotationId) },
        after: { file: item.file, annotations: item.annotations || [] } }, loadImage, observer, { before: t('Before'), after: t('After') }) : null;
      node.append(el(`div.privacy-item${images ? '.with-images' : ''}`, {},
        el('span.privacy-kind', {}, t('Step {number}', { number: item.stepNumber })),
        el('span.privacy-label', {}, privacyKindLabel(item), el('span.muted', {}, ` · ${t('blurred in the screenshot')}`)),
        el('div.privacy-actions', {},
          onShow ? el('button', { type: 'button', onClick: () => onShow(item.stepId, item.annotationId) }, t('Show')) : null,
          accept, keep),
        images));
    }
    for (const item of current.text) {
      const hide = el('button.primary', { type: 'button', title: t('Replace it with [hidden] in the step’s text.') }, t('Hide it'));
      hide.addEventListener('click', act(hide, t('Hiding…'), () => api.redact.hideText({ guideId, stepId: item.stepId })));
      const keep = el('button', { type: 'button' }, t('Not private'));
      keep.addEventListener('click', act(keep, t('Saving…'), () => api.redact.keepText({ guideId, stepId: item.stepId, key: item.key })));
      node.append(el('div.privacy-item.text', {},
        el('span.privacy-kind', {}, t('Step {number}', { number: item.stepNumber })),
        el('span.privacy-label', {}, privacyKindLabel(item), el('span.muted', {}, ` · ${item.field === 'title'
          ? t('“{text}” in the title', { text: item.preview })
          : t('“{text}” in the description', { text: item.preview })}`)),
        el('div.privacy-actions', {}, hide, keep)));
    }
  };
  render(review);
  return node;
}

/** The review in a dialog of its own, from a Publish dialog's Review button. `note` says where the blurs show. */
function showPrivacyReview(api, guideId, review, note, onChange) {
  const list = privacyReviewList(api, guideId, review, { onChange });
  const { close } = openModal({
    title: t('Private details'),
    body: el('div.privacy-dialog', {}, el('p.muted', {}, note), list),
    footer: [el('button.primary', { type: 'button', onClick: () => { close(); list.dispose(); } }, t('Done'))],
    onClose: () => list.dispose(),
  });
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
    let list = null;
    const finish = (show = null) => { list?.dispose(); resolve({ changed, show }); };
    const done = el('button.primary', { type: 'button', onClick: () => { close(); finish(); } }, t('Done'));
    const { close } = openModal({ title: t('Private details'), body, footer: [done], onClose: () => finish() });
    runPrivacyCheck(api, guideId, (text) => { status.textContent = text; })
      .then((review) => {
        changed = review.added > 0;
        status.textContent = review.checked ? privacySummary(review) : `${privacySummary(review)} ${t('Screenshots haven’t changed since they were last checked.')}`;
        // Only worth saying while there are blurs to check.
        const note = el('p.muted', { hidden: !review.blurs.length }, t('Blurs are drawn into every export and published page. Check each one, and remove any that aren’t needed.'));
        body.append(
          note,
          list = privacyReviewList(api, guideId, review, {
            onShow: canShow ? (stepId, annotationId) => { close(); finish({ stepId, annotationId }); } : null,
            onChange: (next) => { changed = true; status.textContent = privacySummary(next); note.hidden = !next.blurs.length; },
          }));
      })
      .catch((err) => { status.textContent = t('StepForge couldn’t check the screenshots: {error}', { error: err.message }); status.classList.add('error'); });
  });
}
