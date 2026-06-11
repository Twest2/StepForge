'use strict';

/* Small DOM + app helpers shared by all renderer modules. */

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

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
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
  setTimeout(() => node.remove(), ms);
}

/** Modal helper. Returns { close, node }. Esc and ✕ close it. */
function openModal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  clearNode(root);
  // `close` just tears down the modal. Buttons that already resolve the
  // dialog's promise themselves call this. `dismiss` additionally fires
  // `onClose`, for ways of leaving the dialog that didn't pick an option
  // (Esc, the ✕, or clicking the backdrop) and need a default resolution.
  const close = () => {
    clearNode(root);
    document.removeEventListener('keydown', escHandler, true);
  };
  const dismiss = () => {
    close();
    if (onClose) onClose();
  };
  const escHandler = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss(); }
  };
  document.addEventListener('keydown', escHandler, true);
  const modal = el('div.modal', { className: `modal${wide ? ' wide' : ''}` },
    el('header', {}, title, el('span.close', { onClick: dismiss, title: 'Close (Esc)' }, '✕')),
    el('div.body', {}, body),
    footer ? el('footer', {}, footer) : null,
  );
  modal.addEventListener('click', (e) => e.stopPropagation());
  root.append(modal);
  root.onclick = dismiss;
  return { close, node: modal };
}

/** Simple confirm dialog returning a promise<boolean>. */
function confirmDialog(message, { danger = false, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title: 'Confirm',
      body: el('div', {}, message),
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, 'Cancel'),
        el('button', {
          className: `primary${danger ? ' danger' : ''}`,
          onClick: () => { close(); resolve(true); },
        }, okLabel),
      ],
      onClose: () => resolve(false),
    });
  });
}

function promptDialog(title, { value = '', label = 'Name' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value });
    const done = (v) => { close(); resolve(v); };
    const { close } = openModal({
      title,
      body: el('div.form-row', {}, el('label', {}, label), input),
      footer: [
        el('button', { onClick: () => done(null) }, 'Cancel'),
        el('button.primary', { onClick: () => done(input.value.trim() || null) }, 'OK'),
      ],
      onClose: () => resolve(null),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); });
    setTimeout(() => input.focus(), 0);
  });
}

/** Context menu at (x, y); items: [{label, danger, action}] or 'sep'. */
function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const menu = el('div.ctx-menu', { style: { left: `${x}px`, top: `${y}px` } });
  for (const item of items) {
    if (item === 'sep') { menu.append(el('hr')); continue; }
    menu.append(el('div.mi', {
      className: `mi${item.danger ? ' danger' : ''}`,
      onClick: () => { menu.remove(); item.action(); },
    }, item.label));
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > innerWidth) menu.style.left = `${innerWidth - rect.width - 6}px`;
  if (rect.bottom > innerHeight) menu.style.top = `${innerHeight - rect.height - 6}px`;
  setTimeout(() => {
    document.addEventListener('click', () => menu.remove(), { once: true });
  }, 0);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
