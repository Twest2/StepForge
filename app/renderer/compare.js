'use strict';

(() => {

/*
 * Compare view: how the guide changed since a snapshot, drawn from the
 * comparison core/guide-diff.js makes (api.snapshots.compare). Removed text
 * is red and struck through, added text green, like a git diff. Steps that
 * didn't change fold into one row; n / p jump between changes. Like a
 * GitHub review, each change can be ticked off as viewed: it folds away,
 * and stays viewed for that snapshot until the step changes again.
 */

const STATUS_LABELS = { added: t('Added'), deleted: t('Deleted'), changed: t('Changed'), unchanged: t('Unchanged') };
const LEVEL_LABELS = { info: t('Info'), warn: t('Warning'), error: t('Error'), success: t('Success') };
const REASON_LABELS = { screenshot: t('new screenshot'), annotations: t('annotations changed'), 'focused view': t('focused view changed') };
// Labels and values core/guide-diff.js reports in English, as the reader sees them.
const CHANGE_LABELS = {
  Title: t('Title'), Description: t('Description'), 'Step type': t('Step type'), Hidden: t('Hidden'), Skipped: t('Skipped'),
  'Starts a new page': t('Starts a new page'), Links: t('Links'), Screenshot: t('Screenshot'), 'Guide title': t('Guide title'),
  'Guide description': t('Guide description'), Theme: t('Theme'), Style: t('Style'), Placed: t('Placed'), Text: t('Text'),
  Language: t('Language'), Author: t('Author'), 'Co-authors': t('Co-authors'), Organization: t('Organization'),
  'Focused view for new steps': t('Focused view for new steps'), 'Hide skipped steps in exports': t('Hide skipped steps in exports'), Link: t('Link'), 'Text block': t('Text block'), 'Code block': t('Code block'), Table: t('Table'),
};
const VALUE_LABELS = {
  Yes: t('Yes'), No: t('No'), Screenshot: t('Screenshot'), Blank: t('Blank'), 'Content only': t('Content only'),
  Info: t('Info'), Warning: t('Warning'), Error: t('Error'), Success: t('Success'), 'Plain text': t('Plain text'), None: t('None'),
  system: t('system'), 'Before the title': t('Before the title'), 'After the title': t('After the title'),
  'Before the screenshot': t('Before the screenshot'), 'After the screenshot': t('After the screenshot'),
  'Before the description': t('Before the description'), 'After the description': t('After the description'),
};
const changeLabel = (label) => {
  const placeholder = /^Placeholder \[\[(.*)\]\]$/.exec(label);
  return placeholder ? t('Placeholder {name}', { name: `[[${placeholder[1]}]]` }) : CHANGE_LABELS[label] || label;
};
const JUMP_TITLES = {
  added: t('Jump to the first added step'), deleted: t('Jump to the first deleted step'),
  changed: t('Jump to the first changed step'), moved: t('Jump to the first moved step'),
};
const COUNT_LABELS = { added: t('{count} added'), deleted: t('{count} deleted'), changed: t('{count} changed'), moved: t('{count} moved') };
// Unchanged code lines around a change that stay visible; longer runs fold.
const CODE_CONTEXT = 3;

/** Inline word diff: removed parts struck through in red, added parts green. */
function diffText(parts, className = 'cmp-text') {
  return el(`div.${className}`, {}, ...parts.map((part) => (
    part.op === 'eq' ? document.createTextNode(part.text)
      : el(part.op === 'del' ? 'del.cmp-del' : 'ins.cmp-add', {}, part.text))));
}

function statusTag(status) {
  return el(`span.cmp-status.${status}`, {}, STATUS_LABELS[status] || status);
}

function movedTag(from, to) {
  return el('span.cmp-status.moved', { title: t('Its place among the others changed') }, from && to && from !== to ? t('Moved #{from} → #{to}', { from, to }) : t('Moved'));
}

/** A short, stable fingerprint of a change, so "viewed" resets when it changes again. */
function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}

function changeRow(label, content) {
  return el('div.cmp-row', {}, el('div.cmp-label', {}, changeLabel(label)), el('div.cmp-value', {}, content));
}

function fieldValue(value, label) {
  if (value === null || value === undefined || value === '') return el('span.muted', {}, t('None'));
  // Metadata, placeholders and link titles belong to the guide's author.
  // Only the core's known enum fields contain interface text to translate.
  const choices = {
    Hidden: ['Yes', 'No'], Skipped: ['Yes', 'No'], 'Starts a new page': ['Yes', 'No'],
    'Focused view for new steps': ['Yes', 'No'], 'Hide skipped steps in exports': ['Yes', 'No'],
    'Step type': ['Screenshot', 'Blank', 'Content only'],
    Style: ['Info', 'Warning', 'Error', 'Success'],
    Placed: ['Before the title', 'After the title', 'Before the screenshot', 'After the screenshot', 'Before the description', 'After the description'],
    Language: ['Plain text'], Theme: ['system'],
  };
  return choices[label]?.includes(value) ? VALUE_LABELS[value] || String(value) : String(value);
}

/** "Hidden: No → Yes", old value struck red, new value green. */
function fieldRow(change) {
  const empty = (value) => value === null || value === undefined || value === '';
  const removed = empty(change.after);
  const added = empty(change.before);
  return changeRow(change.label, el('div.cmp-field', {},
    added ? null : el('del.cmp-del', {}, fieldValue(change.before, change.label)),
    added || removed ? null : el('span.cmp-arrow', { 'aria-hidden': 'true' }, '→'),
    removed ? null : el('ins.cmp-add', {}, fieldValue(change.after, change.label)),
    added ? el('span.muted', {}, ` ${t('(added)')}`) : removed ? el('span.muted', {}, ` ${t('(removed)')}`) : null));
}

/** Git-style code lines with -/+ gutters; long unchanged runs fold. */
function codeDiff(lines) {
  const rows = [];
  let beforeLine = 0;
  let afterLine = 0;
  const near = (i) => lines.slice(Math.max(0, i - CODE_CONTEXT), i + CODE_CONTEXT + 1).some((line) => line.op !== 'eq');
  const anyChange = lines.some((line) => line.op !== 'eq');
  let folded = [];
  const flushFold = () => {
    if (!folded.length) return;
    const hidden = folded;
    folded = [];
    if (hidden.length === 1) { rows.push(hidden[0]); return; }
    const fold = el('button.cmp-code-fold', { type: 'button', title: t('Show these lines') }, `⋯ ${tn(hidden.length, '{count} unchanged line', '{count} unchanged lines')}`);
    fold.addEventListener('click', () => fold.replaceWith(...hidden));
    rows.push(fold);
  };
  lines.forEach((line, i) => {
    if (line.op !== 'add') beforeLine += 1;
    if (line.op !== 'del') afterLine += 1;
    const content = line.parts
      ? el('span.cmp-code-text', {}, ...line.parts.map((part) => (part.op === 'eq' ? document.createTextNode(part.text) : el(`span.cmp-word-${part.op}`, {}, part.text))))
      : el('span.cmp-code-text', {}, line.text || ' ');
    const row = el(`div.cmp-code-line.${line.op}`, {},
      el('span.cmp-ln', {}, line.op === 'add' ? '' : String(beforeLine)),
      el('span.cmp-ln', {}, line.op === 'del' ? '' : String(afterLine)),
      el('span.cmp-sign', { 'aria-hidden': 'true' }, line.op === 'del' ? '−' : line.op === 'add' ? '+' : ' '),
      content);
    if (line.op === 'eq' && anyChange && !near(i)) { folded.push(row); return; }
    flushFold();
    rows.push(row);
  });
  flushFold();
  return el('div.cmp-code', {}, ...rows);
}

function tableGrid(rows, op) {
  return el('table.cmp-table', {}, ...rows.map((row) => el(`tr.${op}`, {}, ...row.map((cell) => el('td', {}, cell)))));
}

function tableDiff(table) {
  if (table.structure) {
    return el('div.cmp-table-structure', {},
      el('div.cmp-note', {}, t('Table structure changed (a different number of columns).')),
      el('div.cmp-caption.before', {}, t('Before')), tableGrid(table.before, 'del'),
      el('div.cmp-caption.after', {}, t('After')), tableGrid(table.after, 'add'));
  }
  return el('table.cmp-table', {}, ...table.rows.map((row) => el(`tr.${row.op}`, {},
    el('td.cmp-sign', { 'aria-hidden': 'true' }, row.op === 'del' ? '−' : row.op === 'add' ? '+' : row.op === 'change' ? '~' : ''),
    ...row.cells.map((parts) => el('td', {}, diffText(parts, 'cmp-cell'))))));
}

/** A text, code or table block that was added, deleted, changed or moved. */
function blockCard(block) {
  const kind = block.kind === 'code' && block.languageValue ? block.languageValue
    : block.kind === 'text' && block.levelValue ? LEVEL_LABELS[block.levelValue] || block.levelValue : '';
  const head = el('div.cmp-block-head', {},
    el('span.cmp-block-kind', {}, changeLabel(block.label)),
    kind ? el(`span.cmp-block-type${block.kind === 'code' ? '.mono' : ''}`, {}, kind) : null,
    el('span.spacer'),
    block.moved ? movedTag() : null,
    block.status !== 'unchanged' ? statusTag(block.status) : null);
  const body = [];
  if (block.kind === 'text') {
    if (block.level) body.push(fieldRow(block.level));
    if (block.position) body.push(fieldRow(block.position));
    if (block.title) body.push(diffText(block.title.parts, 'cmp-block-title'));
    if (block.description?.type === 'formatting') body.push(el('div.cmp-note', {}, t('Formatting changed (bold, links, lists…); the words are the same.')));
    else if (block.description) body.push(diffText(block.description.parts));
  } else if (block.kind === 'code') {
    if (block.language) body.push(fieldRow(block.language));
    body.push(codeDiff(block.lines));
  } else {
    body.push(tableDiff(block.table));
  }
  const card = el(`div.cmp-block.${block.status}`, {}, head, ...body);
  if (block.kind === 'text' && block.levelValue) card.classList.add(`level-${block.levelValue}`);
  return card;
}

/**
 * Before | After screenshots, drawn with their annotations (and focused
 * view) by the editor's own canvas, so they look as readers see them.
 * Images load as they scroll into view.
 */
function imageCompare(change, loadImage, observer) {
  const pane = (side, ref) => {
    const holder = el('div.cmp-image-holder', {}, el('div.cmp-image-loading.muted', {}, t('Loading screenshot…')));
    const node = el(`div.cmp-image-pane.${side}`, {},
      el('div.cmp-caption', {},
        el(`span.cmp-key.${side === 'before' ? 'del' : 'add'}`, { 'aria-hidden': 'true' }, side === 'before' ? '−' : '+'),
        side === 'before' ? t('Before (snapshot)') : t('After (now)')),
      holder);
    if (!ref) {
      holder.replaceChildren(el('div.cmp-image-empty.muted', {}, side === 'before' ? t('No screenshot in the snapshot') : t('No screenshot now')));
      return node;
    }
    holder.cmpLoad = () => drawImage(holder, ref, () => loadImage(side, ref.file));
    observer.observe(holder);
    return node;
  };
  const reasons = (change.reasons || []).map((reason) => REASON_LABELS[reason] || reason);
  if (change.status === 'added') reasons.push(t('added'));
  if (change.status === 'deleted') reasons.push(t('removed'));
  return el('div.cmp-images', {},
    el('div.cmp-images-head', {},
      el('span.cmp-label', {}, changeLabel(change.label)),
      reasons.length ? el('span.muted', {}, reasons.join(', ')) : null),
    el(`div.cmp-image-pair${change.before && change.after ? '' : '.single'}`, {},
      change.before || change.status === 'changed' ? pane('before', change.before) : null,
      change.after || change.status === 'changed' ? pane('after', change.after) : null));
}

async function drawImage(holder, ref, load) {
  try {
    const url = await load();
    if (!url) throw new Error('missing');
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    if (!holder.isConnected) return;
    const canvasEl = el('canvas.cmp-canvas', { 'aria-label': t('Screenshot with annotations') });
    holder.replaceChildren(canvasEl);
    // Compare thumbnails grow vertically with their image; only width is
    // constrained. AnnotationCanvas itself applies the display pixel ratio.
    const view = new window.AnnotationCanvas(canvasEl, { constrainHeight: false });
    holder.cmpCanvas = view;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    view.focusedView = ref.focusedView || null;
    view.annotations = ref.annotations || [];
    view.zoomMode = String(Math.min(1, Math.max(1, holder.clientWidth - 16) / width));
    view.setImage(img, width, height);
  } catch {
    holder.replaceChildren(el('div.cmp-image-empty.muted', {}, t('This screenshot can’t be shown (it is missing or damaged).')));
  }
}

function stepChangeNodes(step, loadImage, observer) {
  return step.changes.map((change) => {
    if (change.type === 'text') return changeRow(change.label, diffText(change.parts));
    if (change.type === 'formatting') return changeRow(change.label, el('div.cmp-note', {}, t('Formatting changed (bold, links, lists…); the words are the same.')));
    if (change.type === 'field') return fieldRow(change);
    if (change.type === 'image') return imageCompare(change, loadImage, observer);
    if (change.type === 'block') return blockCard(change);
    return null;
  });
}

function stepNumber(step) {
  const { before, after } = step.number;
  return step.status === 'deleted' ? before : after;
}

/**
 * A change's box: a header that folds it, and a "Viewed" checkbox like
 * GitHub's. `review` remembers what was viewed.
 */
function reviewCard({ className, key, print, headParts, body, review, depth = 0, dataset = {} }) {
  const chevron = el('button.cmp-fold', { type: 'button', title: t('Fold'), 'aria-expanded': 'true' }, el('span.cmp-chevron', { 'aria-hidden': 'true' }, '▾'));
  const viewed = el('input', { type: 'checkbox' });
  const card = el(`section.cmp-step.${className}`, {
    style: { marginLeft: `${Math.min(depth, 4) * 18}px` },
    dataset,
  },
  el('div.cmp-step-head', {}, chevron, ...headParts,
    el('label.cmp-viewed', { title: t('Mark as viewed (V) and fold it away') }, viewed, t('Viewed'))),
  body);
  card.cmpSetOpen = (open) => {
    body.hidden = !open;
    chevron.setAttribute('aria-expanded', String(open));
    chevron.title = open ? t('Fold') : t('Unfold');
    card.classList.toggle('folded', !open);
  };
  card.cmpSetViewed = (on) => {
    viewed.checked = on;
    card.classList.toggle('viewed', on);
    card.cmpSetOpen(!on);
    review.set(key, on ? print : null);
  };
  card.cmpIsViewed = () => viewed.checked;
  chevron.addEventListener('click', () => card.cmpSetOpen(body.hidden));
  viewed.addEventListener('change', () => card.cmpSetViewed(viewed.checked));
  if (review.get(key) === print) {
    viewed.checked = true;
    card.classList.add('viewed');
    card.cmpSetOpen(false);
  }
  return card;
}

function stepCard(step, loadImage, observer, review) {
  const number = stepNumber(step);
  const body = step.status === 'unchanged'
    ? el('div.cmp-step-body', {}, el('div.cmp-note', {}, step.number.before !== step.number.after
      ? t('Only its place in the guide changed (it was step {number}).', { number: step.number.before })
      : t('Only its place among the other steps changed.')))
    : el('div.cmp-step-body', {}, ...stepChangeNodes(step, loadImage, observer));
  return reviewCard({
    className: `${step.status}${step.moved ? '.is-moved' : ''}`,
    key: step.stepId,
    print: fingerprint([step.status, step.moved, step.number, step.changes]),
    headParts: [
      el('span.cmp-step-number', {}, number ? `#${number}` : ''),
      el('span.cmp-step-title', { title: step.title }, step.title || el('span.muted', {}, t('Untitled step'))),
      step.moved ? movedTag(step.number.before, step.number.after) : null,
      step.status !== 'unchanged' ? statusTag(step.status) : null,
    ],
    body,
    review,
    depth: step.depth,
    dataset: { stepId: step.stepId, status: step.status },
  });
}

/** A row standing for unchanged steps; clicking it lists them. */
function unchangedGroup(steps) {
  const first = stepNumber(steps[0]);
  const last = stepNumber(steps.at(-1));
  const range = steps.length === 1 ? t('step {number}', { number: first }) : t('steps {first}–{last}', { first, last });
  const list = el('div.cmp-unchanged-list', { hidden: true }, ...steps.map((step) => el('div.cmp-unchanged-item', {
    style: { paddingLeft: `${10 + Math.min(step.depth, 4) * 18}px` },
  }, el('span.cmp-step-number', {}, `#${stepNumber(step)}`), step.title || el('span.muted', {}, t('Untitled step')))));
  const toggle = el('button.cmp-unchanged-toggle', { type: 'button', 'aria-expanded': 'false' },
    el('span.cmp-chevron', { 'aria-hidden': 'true' }, '▾'),
    `${tn(steps.length, '{count} unchanged step', '{count} unchanged steps')} `, el('span.muted', {}, `(${range})`));
  const group = el('div.cmp-unchanged', {}, toggle, list);
  toggle.addEventListener('click', () => group.cmpSetOpen(list.hidden));
  group.cmpSetOpen = (open) => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    group.classList.toggle('open', open);
  };
  return group;
}

function guideCard(changes, review) {
  return reviewCard({
    className: 'changed.cmp-guide',
    key: 'guide',
    print: fingerprint(changes),
    headParts: [el('span.cmp-step-title', {}, t('Guide details')), statusTag('changed')],
    body: el('div.cmp-step-body', {}, ...changes.map((change) => {
      if (change.type === 'text') return changeRow(change.label, diffText(change.parts));
      if (change.type === 'formatting') return changeRow(change.label, el('div.cmp-note', {}, t('Formatting changed; the words are the same.')));
      return fieldRow(change);
    })),
    review,
    dataset: { status: 'changed' },
  });
}

/** "1 added, 1 deleted, 4 changed, 1 moved · 5 unchanged"; each count jumps to its first step. */
function summaryBar(summary, jumpTo) {
  const items = ['added', 'deleted', 'changed', 'moved']
    .filter((kind) => summary[kind])
    .map((kind) => el(`button.cmp-count.${kind}`, {
      type: 'button', title: JUMP_TITLES[kind], onClick: () => jumpTo(kind),
    }, ...fillNodes(COUNT_LABELS[kind], { count: el('strong', {}, String(summary[kind])) })));
  const parts = [];
  items.forEach((item, i) => { if (i) parts.push(el('span.muted', {}, ', ')); parts.push(item); });
  return el('div.cmp-summary', {}, ...parts,
    summary.unchanged ? el('span.muted', {}, `${parts.length ? ' · ' : ''}${t('{count} unchanged', { count: summary.unchanged })}`) : null);
}

/** Which changes were marked viewed, kept per guide and snapshot in this browser profile. */
function reviewStore(storageKey) {
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { seen = {}; }
  return {
    get: (key) => seen[key] || null,
    set: (key, print) => {
      if (print) seen[key] = print;
      else delete seen[key];
      try {
        if (Object.keys(seen).length) localStorage.setItem(storageKey, JSON.stringify(seen));
        else localStorage.removeItem(storageKey);
      } catch { /* viewed marks are a convenience; losing them is fine */ }
    },
  };
}

/**
 * Open the Compare view for snapshot `label`. `loadImage(side, file)`
 * resolves a screenshot's data URL ('before' is the snapshot, 'after' the
 * guide now). `onRestore()` restores the snapshot and resolves true once
 * done. `storageKey` names where viewed marks are kept. Resolves true when
 * the snapshot was restored.
 */
function showSnapshotCompare({ label, diff, loadImage, onRestore, storageKey = 'stepforge.compare.viewed' } = {}) {
  return new Promise((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        entry.target.cmpLoad?.();
      }
    }, { rootMargin: '400px 0px' });

    const review = reviewStore(storageKey);
    const list = el('div.cmp-list');
    if (diff.guide.length) list.append(guideCard(diff.guide, review));
    let quiet = [];
    const groups = [];
    const flushQuiet = () => {
      if (!quiet.length) return;
      const group = unchangedGroup(quiet);
      groups.push(group);
      list.append(group);
      quiet = [];
    };
    for (const step of diff.steps) {
      if (step.status === 'unchanged' && !step.moved) { quiet.push(step); continue; }
      flushQuiet();
      list.append(stepCard(step, loadImage, observer, review));
    }
    flushQuiet();

    // Every change, in order, for n / p. They skip what is viewed, unless all of it is.
    const targets = [...list.querySelectorAll('.cmp-step')];
    let current = -1;
    const position = el('span.cmp-position.muted', { 'aria-live': 'polite' });
    const progress = el('span.cmp-progress', {});
    const showPosition = () => {
      position.textContent = targets.length
        ? (current < 0 ? tn(targets.length, '{count} change', '{count} changes') : t('Change {current} of {count}', { current: current + 1, count: targets.length }))
        : '';
      const viewedCount = targets.filter((node) => node.cmpIsViewed()).length;
      progress.textContent = t('{viewed} / {count} viewed', { viewed: viewedCount, count: targets.length });
      progress.classList.toggle('all', viewedCount === targets.length);
    };
    const select = (index) => {
      current = index;
      targets.forEach((node, i) => node.classList.toggle('current', i === current));
      targets[current].scrollIntoView({ block: 'start', behavior: 'smooth' });
      showPosition();
    };
    const move = (from, delta) => {
      if (!targets.length) return;
      const open = targets.some((node) => !node.cmpIsViewed());
      for (let i = 1; i <= targets.length; i++) {
        const index = (((from + delta * i) % targets.length) + targets.length) % targets.length;
        if (!open || !targets[index].cmpIsViewed()) { select(index); return; }
      }
    };
    const go = (index) => {
      if (!targets.length) return;
      select((index + targets.length) % targets.length);
    };
    list.addEventListener('change', (e) => { if (e.target.closest('.cmp-viewed')) showPosition(); });
    const jumpTo = (kind) => {
      const index = targets.findIndex((node) => (kind === 'moved' ? node.classList.contains('is-moved') : node.dataset.status === kind));
      if (index >= 0) go(index);
    };
    showPosition();

    const navButton = (text, title, delta) => el('button.cmp-nav', {
      type: 'button', title, disabled: !targets.length, onClick: () => move(current < 0 && delta > 0 ? -1 : current < 0 ? 0 : current, delta),
    }, text);
    const showAll = el('input', { type: 'checkbox' });
    showAll.addEventListener('change', () => groups.forEach((group) => group.cmpSetOpen(showAll.checked)));

    const toolbar = el('div.cmp-toolbar', {},
      el('div.cmp-versions', {}, ...fillNodes(t('Comparing {before} with {after}'), {
        before: el('span.cmp-version', { title: t('Removed text is shown in red') }, el('span.cmp-key.del', { 'aria-hidden': 'true' }, '−'), el('strong', {}, t('snapshot {name}', { name: label }))),
        after: el('span.cmp-version', { title: t('Added text is shown in green') }, el('span.cmp-key.add', { 'aria-hidden': 'true' }, '+'), el('strong', {}, t('the current guide'))),
      })),
      diff.identical ? null : el('div.cmp-toolbar-row', {},
        summaryBar(diff.summary, jumpTo),
        el('div.spacer'),
        groups.length ? el('label.cmp-show-all', {}, showAll, ' ', t('Show unchanged steps')) : null,
        progress,
        position,
        navButton('↑', t('Previous change (P)'), -1),
        navButton('↓', t('Next change (N)'), 1)));

    const body = el('div.cmp-view', {}, toolbar, diff.identical
      ? el('div.cmp-empty', {},
        el('div', {}, el('strong', {}, t('No differences.'))),
        el('div.muted', {}, t('This snapshot matches the current guide.')))
      : list);

    const restoreBtn = el('button', {
      type: 'button',
      onClick: async () => {
        setButtonLoading(restoreBtn, true, t('Restoring…'));
        let restored = false;
        try {
          restored = await onRestore?.();
        } finally {
          if (restoreBtn.isConnected) setButtonLoading(restoreBtn, false);
        }
        if (restored) finish(true);
      },
    }, t('Restore this snapshot'));

    const onKey = (e) => {
      if (!node.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (node.hidden || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
      const key = e.key.toLowerCase();
      if ((key === 'n' && !e.altKey) || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); move(current, 1); }
      if ((key === 'p' && !e.altKey) || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); move(current < 0 ? 0 : current, -1); }
      // V: tick the current change off as viewed and move on to the next one.
      if (key === 'v' && !e.altKey && current >= 0) {
        e.preventDefault();
        const node = targets[current];
        node.cmpSetViewed(!node.cmpIsViewed());
        showPosition();
        if (node.cmpIsViewed()) move(current, 1);
      }
    };
    let done = false;
    const finish = (restored) => {
      if (done) return;
      done = true;
      observer.disconnect();
      for (const holder of list.querySelectorAll('.cmp-image-holder')) holder.cmpCanvas?.destroy();
      document.removeEventListener('keydown', onKey);
      close();
      resolve(restored);
    };

    const { close, node } = openModal({
      title: t('Compare with current guide'),
      body,
      footer: [
        el('span.cmp-keys.muted', {}, ...fillNodes(t('{next} / {previous} next / previous · {viewed} mark viewed · {close} close'), {
          next: el('kbd', {}, 'N'), previous: el('kbd', {}, 'P'), viewed: el('kbd', {}, 'V'), close: el('kbd', {}, 'Esc'),
        })),
        el('div.spacer'),
        restoreBtn,
        el('button.primary', { type: 'button', onClick: () => finish(false) }, t('Close')),
      ],
      wide: true,
      onClose: () => finish(false),
    });
    node.classList.add('compare-modal');
    document.addEventListener('keydown', onKey);
  });
}

window.StepForgeCompare = { showSnapshotCompare };
})();
