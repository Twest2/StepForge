'use strict';

/* Small DOM + app helpers shared by all renderer modules. */

// Interface text in the language the main process loaded this page in
// (?lang=, Settings → General → Language). core/i18n.js explains t and tn.
const { t, tn, language: uiLanguage } = StepForgeI18n.createTranslator(
  new URLSearchParams(location.search).get('lang'), globalThis.StepForgeLocales);
// Dates follow the interface language; in English, the system's date format.
const dateLocale = uiLanguage === 'en' ? undefined : uiLanguage;

// Between two sentences: Japanese and Chinese don't put a space there.
const sentenceGap = uiLanguage === 'ja' || uiLanguage === 'zh-CN' ? '' : ' ';

/**
 * Translated text with elements in it, for el() children: each {name} in
 * `text` becomes nodes[name], so a link can sit anywhere in the sentence.
 * Example: fillNodes(translatedText, { link: el('a', {}, linkText) }).
 */
function fillNodes(text, nodes) {
  return String(text).split(/(\{\w+\})/).filter(Boolean)
    .map((part) => (/^\{\w+\}$/.test(part) && nodes[part.slice(1, -1)] != null ? nodes[part.slice(1, -1)] : part));
}

/** Element builder: el('div.cls#id', {attrs/on*}, ...children) */
function el(spec, props = {}, ...children) {
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const node = document.createElement(tag || 'div');
  for (const part of rest) {
    if (part.startsWith('.')) node.classList.add(part.slice(1));
    if (part.startsWith('#')) node.id = part.slice(1);
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key in node && key !== 'list') {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** The "Beta" chip beside features that are new and may still change (AI, Confluence, Wiki.js). */
function betaBadge(text = 'Beta') {
  return el('span.settings-chip.beta-badge', {}, t(text));
}

/** Settings row: a title and optional description beside its control. */
function settingRow(title, description, control) {
  const heading = el('div.setting-title', {}, title);
  const help = description ? el('div.setting-desc', {}, description) : null;
  labelControl(heading, control, help);
  return el('div.setting-row', {},
    el('div.setting-text', {},
      heading, help),
    el('div.setting-control', {}, control));
}

let controlLabelCount = 0;
/** Connect visible form text to its controls without replacing explicit names. */
function labelControl(label, control, description = null) {
  if (!label.textContent?.trim()) return control;
  const identify = node => {
    if (!node.id) node.setAttribute('id', `control-label-${++controlLabelCount}`);
    return node.id;
  };
  const labelId = identify(label), descriptionId = description ? identify(description) : '';
  let linked = false;
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object' || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return;
    const tag = tagOf(node);
    const native = ['input', 'select', 'textarea', 'button'].includes(tag) && node.type !== 'hidden';
    const editable = node.getAttribute?.('role') === 'textbox';
    if (native || editable) {
      const wrapped = node.closest?.('label');
      if (tagOf(label) === 'label' && native && !linked && !wrapped && !label.getAttribute('for')) {
        label.setAttribute('for', identify(node)); linked = true;
      }
      if (!wrapped && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')) {
        const ownText = tag === 'button' && node.textContent?.trim() ? ` ${identify(node)}` : '';
        node.setAttribute('aria-labelledby', labelId + ownText);
      }
      if (descriptionId) {
        const ids = new Set((node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        ids.add(descriptionId); node.setAttribute('aria-describedby', [...ids].join(' '));
      }
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(control);
  return control;
}

/** Wraps a checkbox as an on/off switch; the checkbox keeps its `checked` state. */
function makeSwitch(input, label) {
  input.classList.add('switch-input');
  return el('label.switch', { title: label }, input, el('span.switch-track', { 'aria-hidden': 'true' }),
    el('span.sr-only', {}, label));
}

function settingsCard(title, ...rows) {
  return el('div.settings-card', {}, title ? el('h4.settings-card-title', {}, title) : null, ...rows);
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Toggle a button into/out of a busy state: disables it and swaps its label
 * for a spinner + `label` (e.g. "Exporting…"), restoring the original label
 * afterwards. Used for actions that block on a slow main-process call.
 */
function setButtonLoading(btn, loading, label) {
  if (loading) {
    if (btn.dataset.origLabel === undefined) btn.dataset.origLabel = btn.textContent;
    btn.disabled = true;
    btn.classList.add('loading');
    clearNode(btn);
    btn.append(el('span.spinner'), label || btn.dataset.origLabel);
  } else {
    btn.disabled = false;
    btn.classList.remove('loading');
    clearNode(btn);
    btn.append(btn.dataset.origLabel ?? '');
    delete btn.dataset.origLabel;
  }
}

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

function toast(message, { error = false, ms = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  const node = el('div.toast', { className: `toast${error ? ' error' : ''}` }, message);
  root.append(node);
  const announcer = document.getElementById(error ? 'toast-alert' : 'toast-status');
  if (announcer) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = String(message); }, 20);
  }
  setTimeout(() => node.remove(), ms);
}

const modalStack = [];
let activeContextMenu = null;
let contextMenuCount = 0;
// Close function of the "Discard your changes?" prompt while it is open, so
// Escape or × can't stack a second one.
let discardPrompt = null;
let modalCount = 0;

const FIELD_TAGS = ['input', 'select', 'textarea'];

const tagOf = (node) => String(node.localName || node.tagName || '').toLowerCase();

/**
 * Enabled, visible controls inside `root` in tab order. Skips hidden and
 * inert subtrees (other Settings sections, dialogs underneath). With
 * `fieldsOnly`, only text fields, selects and checkboxes count.
 */
function focusableIn(root, { fieldsOnly = false } = {}) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.hidden || node.inert || node.classList?.contains?.('hidden')) return;
    const tag = tagOf(node);
    const isField = FIELD_TAGS.includes(tag);
    const isControl = (isField || tag === 'button' || (tag === 'a' && node.getAttribute?.('href') != null))
      && !node.disabled && node.type !== 'hidden' && (node.tabIndex ?? 0) >= 0;
    if (isControl && (isField || !fieldsOnly)) found.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return found;
}

/** Tab and Shift+Tab stay inside the dialog: at either end, wrap to the other. */
function trapTab(e, dialogNode) {
  const items = focusableIn(dialogNode);
  if (!items.length) { e.preventDefault(); return; }
  const at = items.indexOf(document.activeElement);
  if (e.shiftKey ? at <= 0 : at === -1 || at === items.length - 1) {
    e.preventDefault();
    (e.shiftKey ? items.at(-1) : items[0]).focus();
  }
}

/** True while any dialog is open: the app's own shortcuts stand down. */
function modalIsOpen() {
  return modalStack.length > 0;
}

/**
 * Keys aimed at the top dialog reach it; Tab is trapped; keys aimed at
 * anything behind it are stopped before the app's own shortcut handlers see
 * them (Escape among them still closes the dialog).
 */
function onModalKeyDown(e) {
  const top = modalStack.at(-1);
  if (!top) return;
  // Menus owned by this dialog handle their own Escape and Tab first.
  if (activeContextMenu?.owner === top && activeContextMenu.root.contains(e.target)) return;
  if (e.key === 'Tab') { trapTab(e, top.node); return; }
  if (top.node.contains?.(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') top.requestDismiss();
}

/**
 * Escape closes the top dialog (asking first when it has unsaved changes),
 * once it has bubbled back up: a control in the dialog that uses Escape
 * itself (the shortcut recorder in Settings, a search list) handles it first
 * and stops it or prevents its default.
 */
function onModalEscape(e) {
  const top = modalStack.at(-1);
  if (!top || e.key !== 'Escape' || e.defaultPrevented) return;
  e.preventDefault();
  top.requestDismiss();
}

/**
 * Tracks focus inside the top dialog, and sends focus that lands outside it
 * (a click or a script) back to the control that had it last.
 */
function keepFocusInDialog(e) {
  const top = modalStack.at(-1);
  if (!top) return;
  if (top.node.contains?.(e.target)) { top.lastFocus = e.target; return; }
  const items = focusableIn(top.node);
  (items.includes(top.lastFocus) ? top.lastFocus : items[0])?.focus?.();
}

/** The app behind the dialogs is inert while any dialog is open. */
function syncAppInert() {
  const app = document.getElementById('app');
  if (app) app.inert = modalStack.length > 0;
}

// Key and focus guards for every dialog. Window capture runs before the page's own key handlers.
if (typeof document !== 'undefined') {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', onModalKeyDown, true);
    window.addEventListener('keydown', onModalEscape);
  } else {
    document.addEventListener('keydown', onModalKeyDown, true);
    document.addEventListener('keydown', onModalEscape);
  }
  document.addEventListener('focusin', keepFocusInDialog, true);
}

/**
 * For openModal's isDirty: true once what `read()` returns differs from what
 * it returned when this was called (call it just before opening the dialog).
 */
function unsavedChanges(read) {
  const start = JSON.stringify(read());
  return () => JSON.stringify(read()) !== start;
}

/**
 * Modal helper. Returns { close, node }. Esc and × close it; with `isDirty`
 * (a function) they ask "Discard your changes?" first when it returns true.
 * Clicking the backdrop does nothing, so an edit can't be lost by a stray
 * click. Focus moves into the dialog, Tab is trapped there, and focus goes
 * back to what opened it when it closes. `initialFocus` picks the element
 * to focus on open (default: the first field, else the primary button).
 */
function openModal({ title, body, footer, wide = false, onClose, isDirty = null, initialFocus = null }) {
  activeContextMenu?.close();
  const root = document.getElementById('modal-root');
  const parent = modalStack.at(-1);
  const previousFocus = document.activeElement;
  if (parent) { parent.node.hidden = true; parent.node.inert = true; }
  const titleId = `modal-title-${++modalCount}`;
  let closed = false;
  // `close` just tears down the modal. Buttons that already resolve the
  // dialog's promise themselves call this. `dismiss` additionally fires
  // `onClose`, for ways of leaving the dialog that didn't pick an option
  // (Esc or the ×) and need a default resolution.
  const close = () => {
    if (closed) return;
    closed = true;
    if (activeContextMenu?.owner === entry) activeContextMenu.close({ restoreFocus: false });
    const index = modalStack.indexOf(entry);
    // Closing a parent also resolves any child dialogs still open above it.
    for (const child of modalStack.slice(index + 1).reverse()) child.dismiss();
    modalStack.splice(index, 1);
    modal.remove();
    const active = modalStack.at(-1);
    if (active) { active.node.hidden = false; active.node.inert = false; }
    syncAppInert();
    if (previousFocus?.isConnected) previousFocus.focus();
    else if (active) focusableIn(active.node)[0]?.focus();
  };
  const dismiss = () => {
    if (closed) return;
    close();
    if (onClose) onClose();
  };
  // Esc and × with unsaved changes: ask first. "Keep editing" is the default.
  const requestDismiss = () => {
    if (closed) return;
    if (isDirty && !discardPrompt && isDirty()) { askDiscard(); return; }
    dismiss();
  };
  function askDiscard() {
    let closePrompt = () => {};
    const finish = (discard) => {
      discardPrompt = null;
      closePrompt();
      if (discard) dismiss();
    };
    const keep = el('button', { type: 'button', className: 'primary', onClick: () => finish(false) }, t('Keep editing'));
    const discard = el('button', { type: 'button', className: 'danger', onClick: () => finish(true) }, t('Discard'));
    ({ close: closePrompt } = openModal({
      title: t('Discard your changes?'),
      body: el('div', {}, t('Your unsaved changes will be lost.')),
      footer: [keep, discard],
      initialFocus: keep,
      onClose: () => { discardPrompt = null; },
    }));
    discardPrompt = { close: closePrompt };
  }
  const bodyEl = el('div.body', {}, body);
  const footerEl = footer ? el('footer', {}, footer) : null;
  const closeButton = el('button', {
    type: 'button', className: 'close', title: t('Close (Esc)'), 'aria-label': t('Close (Esc)'), onClick: requestDismiss,
  }, '✕');
  const modal = el('div.modal', { className: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('header', {}, el('h2.modal-title', { id: titleId }, title), closeButton),
    bodyEl,
    footerEl,
  );
  const entry = { node: modal, dismiss, requestDismiss, lastFocus: null };
  modalStack.push(entry);
  root.append(modal);
  syncAppInert();
  const primary = footerEl ? focusableIn(footerEl).find((n) => n.classList?.contains?.('primary')) : null;
  const target = initialFocus || focusableIn(bodyEl, { fieldsOnly: true })[0] || primary || focusableIn(modal)[0];
  target?.focus?.();
  return { close, requestDismiss, node: modal };
}

/**
 * Simple confirm dialog returning a promise<boolean>. A destructive one
 * (`danger`) opens with Cancel focused, so Enter can't confirm it by accident.
 */
function confirmDialog(message, { danger = false, okLabel = t('OK') } = {}) {
  return new Promise((resolve) => {
    const cancel = el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel'));
    const { close } = openModal({
      title: t('Confirm'),
      body: el('div', {}, message),
      footer: [
        cancel,
        el('button', {
          type: 'button',
          className: `primary${danger ? ' danger' : ''}`,
          onClick: () => { close(); resolve(true); },
        }, okLabel),
      ],
      initialFocus: danger ? cancel : null,
      onClose: () => resolve(false),
    });
  });
}

/** A review interval from core/review.js ("3 months") in the interface language. */
function intervalText(days) {
  const known = window.StepForgeReview.REVIEW_INTERVALS.some((i) => i.days === days);
  if (known && days % 365 === 0) return tn(days / 365, '{count} year', '{count} years');
  if (known) return tn(days / 30, '{count} month', '{count} months');
  return tn(days, '{count} day', '{count} days');
}

/** "Oct 20", with the year when it isn't this year; '' for no date. */
function shortDate(iso) {
  const date = new Date(iso || '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/**
 * Asks before publishing over a page someone edited on the site since the
 * guide was last published. `edited` is { url, by, when } from the main
 * process; `where` names the site ("in Confluence"), and `history` says
 * where the edited version is kept, both already translated. Open page
 * leaves the question open. Resolves true to publish anyway.
 */
function confirmReplaceEdits(api, edited, { where, history }) {
  const by = edited?.by || '';
  const date = shortDate(edited?.when);
  // One sentence per combination, so each language can order the parts its own way.
  const edits = by && date
    ? t('This page was edited {where} by {name} on {date} since you last published. Publishing will replace those edits.', { where, name: by, date })
    : by
      ? t('This page was edited {where} by {name} since you last published. Publishing will replace those edits.', { where, name: by })
      : date
        ? t('This page was edited {where} on {date} since you last published. Publishing will replace those edits.', { where, date })
        : t('This page was edited {where} since you last published. Publishing will replace those edits.', { where });
  return new Promise((resolve) => {
    // "Publish anyway" replaces the edits, so Cancel is the focused choice.
    const cancel = el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel'));
    const { close } = openModal({
      title: t('Page edited since you published'),
      body: el('div.cloud-confirm', {},
        el('strong', {}, edits),
        el('p', {}, history)),
      footer: [
        edited?.url ? el('button', { type: 'button', onClick: () => { void api.shell.openExternal({ url: edited.url }).catch(() => {}); } }, t('Open page')) : null,
        cancel,
        el('button.primary', { type: 'button', onClick: () => { close(); resolve(true); } }, t('Publish anyway')),
      ].filter(Boolean),
      initialFocus: cancel,
      onClose: () => resolve(false),
    });
  });
}

function promptDialog(title, { value = '', label = t('Name') } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value });
    const done = (v) => { close(); resolve(v); };
    const inputLabel = el('label', {}, label);
    labelControl(inputLabel, input);
    const { close, requestDismiss } = openModal({
      title,
      body: el('div.form-row', {}, inputLabel, input),
      footer: [
        el('button', { onClick: () => requestDismiss() }, t('Cancel')),
        el('button.primary', { onClick: () => done(input.value.trim() || null) }, t('OK')),
      ],
      isDirty: unsavedChanges(() => input.value),
      onClose: () => resolve(null),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); });
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * Context menu at (x, y).
 * items: [{label, danger, action, badge}] | [{label, submenu}] | 'sep'.
 * `badge` adds a chip such as "Beta" after the label.
 * `submenu` is an array (or a function returning one) of the same item
 * shapes, shown in a scrollable panel beside the item on hover.
 */
function contextMenu(x, y, items, { trigger = document.activeElement, label = '' } = {}) {
  activeContextMenu?.close({ restoreFocus: false });
  const owner = modalStack.at(-1);
  const panels = [];
  const menuId = `context-menu-${++contextMenuCount}`;
  const menuName = label || trigger?.getAttribute?.('aria-label') || trigger?.textContent?.trim() || t('Actions');
  let closed = false;
  const isButton = tagOf(trigger || {}) === 'button';
  const removeAfter = (index) => {
    while (panels.length > index + 1) {
      const panel = panels.pop();
      panel.parentButton?.setAttribute('aria-expanded', 'false');
      panel.parentButton?.removeAttribute?.('aria-controls');
      panel.node.remove();
    }
  };
  const close = ({ restoreFocus = true } = {}) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', focusOutside, true);
    window.removeEventListener('resize', resize);
    activeContextMenu = null;
    removeAfter(-1);
    if (isButton) { trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute?.('aria-controls'); }
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  };
  const outside = event => { if (!panels[0]?.node.contains(event.target)) close({ restoreFocus: false }); };
  const focusOutside = event => { if (!panels[0]?.node.contains(event.target)) close({ restoreFocus: false }); };
  const resize = () => close();
  const place = (node, left, top, parentButton = null) => {
    node.style.left = `${left}px`; node.style.top = `${top}px`;
    const rect = node.getBoundingClientRect();
    if (rect.right > innerWidth - 6) node.style.left = `${Math.max(6, parentButton ? parentButton.getBoundingClientRect().left - rect.width - 2 : innerWidth - rect.width - 6)}px`;
    if (rect.bottom > innerHeight - 6) node.style.top = `${Math.max(6, innerHeight - rect.height - 6)}px`;
  };
  const build = (entries, parentButton = null, depth = 0) => {
    const node = el('div.ctx-menu', { className: `ctx-menu${depth ? ' ctx-submenu' : ''}`, role: 'menu',
      id: depth ? `${menuId}-${depth}` : menuId, 'aria-label': parentButton?.textContent || menuName });
    const panel = { node, parentButton, buttons: [], entries: [] };
    panels.push(panel);
    let prefix = '', typedAt = 0;
    const openSubmenu = (item, button, focus = false) => {
      if (panels[depth + 1]?.parentButton === button) {
        if (focus) panels[depth + 1].buttons[0]?.focus();
        return;
      }
      removeAfter(depth);
      const children = typeof item.submenu === 'function' ? item.submenu() : item.submenu;
      const child = build(children?.length ? children : [{ label: t('Nothing else to choose'), disabled: true }], button, depth + 1);
      node.append(child.node);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-controls', child.node.id);
      const rect = button.getBoundingClientRect();
      place(child.node, rect.right + 2, rect.top, button);
      if (focus) child.buttons[0]?.focus();
    };
    for (const item of entries) {
      if (item === 'sep') { node.append(el('hr', { role: 'separator' })); continue; }
      const button = el('button.mi', { type: 'button', role: 'menuitem', tabIndex: -1,
        className: `mi${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}${item.submenu ? ' has-submenu' : ''}`,
        ...(item.disabled ? { 'aria-disabled': 'true' } : {}),
        ...(item.submenu ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
        onMouseEnter: () => { if (item.submenu && !item.disabled) openSubmenu(item, button); else removeAfter(depth); },
        onClick: () => {
          if (item.disabled) return;
          if (item.submenu) { openSubmenu(item, button, true); return; }
          close(); item.action?.();
        },
      }, el('span', {}, item.label), item.badge ? betaBadge(item.badge) : null,
      item.submenu ? el('span.submenu-arrow', { 'aria-hidden': 'true' }, '›') : null);
      node.append(button); panel.buttons.push(button); panel.entries.push(item);
    }
    node.addEventListener('keydown', event => {
      if (event.target.closest('.ctx-menu') !== node) return;
      const at = panel.buttons.indexOf(document.activeElement);
      const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (move || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation(); removeAfter(depth);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? panel.buttons.length - 1 : (at + move + panel.buttons.length) % panel.buttons.length;
        panel.buttons[next]?.focus();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation();
        const item = panel.entries[at];
        if (item?.submenu && !item.disabled) openSubmenu(item, panel.buttons[at], true);
      } else if (event.key === 'Escape' || (event.key === 'ArrowLeft' && depth)) {
        event.preventDefault(); event.stopPropagation();
        if (depth) { removeAfter(depth - 1); parentButton.focus(); } else close();
      } else if (event.key === 'Tab') {
        close();
        if (owner) trapTab(event, owner.node);
      } else if (event.key.length === 1 && event.key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now(), letter = event.key.toLocaleLowerCase();
        prefix = now - typedAt > 700 ? letter : prefix + letter; typedAt = now;
        const search = [...prefix].every(char => char === letter) ? letter : prefix;
        const ordered = [...panel.entries.slice(at + 1), ...panel.entries.slice(0, at + 1)];
        const match = ordered.find(item => String(item.label).toLocaleLowerCase().startsWith(search));
        if (match) { event.preventDefault(); removeAfter(depth); panel.buttons[panel.entries.indexOf(match)].focus(); }
      }
    });
    return panel;
  };
  const root = build(items.length ? items : [{ label: t('Nothing else to choose'), disabled: true }]).node;
  (owner?.node || document.body).append(root);
  place(root, x, y);
  if (isButton) { trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', menuId); }
  activeContextMenu = { root, owner, close };
  panels[0].buttons[0]?.focus();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', focusOutside, true);
  window.addEventListener('resize', resize);
  return { close, node: root };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/** Wording for a live cloud transfer ({ direction, name, loaded, total, bytesPerSecond }). */
function describeTransfer(transfer) {
  const percent = transfer.total ? Math.min(100, Math.floor((transfer.loaded / transfer.total) * 100)) : 0;
  const parts = { name: transfer.name || t('guide'), loaded: formatBytes(transfer.loaded), total: formatBytes(transfer.total) };
  const rate = transfer.bytesPerSecond ? `${formatBytes(transfer.bytesPerSecond)}/s` : '';
  const progress = transfer.direction === 'upload'
    ? t('Uploading “{name}” — {loaded} of {total}', parts)
    : t('Downloading “{name}” — {loaded} of {total}', parts);
  return {
    percent,
    arrow: transfer.direction === 'upload' ? '↑' : '↓',
    compact: `${formatBytes(transfer.loaded)} / ${formatBytes(transfer.total)}`,
    detail: `${progress}${rate ? ` · ${rate}` : ''}`,
  };
}
