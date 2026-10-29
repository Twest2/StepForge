'use strict';

(() => {

/**
 * Small modal factories used by the renderer. They stay intentionally plain:
 * a modal title, a few form rows, and action buttons. No decorative clutter.
 */

function labeledRow(labelText, control, { stacked = false } = {}) {
  return el(stacked ? 'div.form-row.stacked' : 'div.form-row', {},
    el('label', {}, labelText),
    control
  );
}

function makeInput(value = '', type = 'text', attrs = {}) {
  return el('input', { type, value, ...attrs });
}

function makeSelect(value, options) {
  return el('select', {},
    options.map((opt) => el('option', { value: opt.value, selected: opt.value === value }, opt.label))
  );
}

// Review dates (core/review.js, loaded with a script tag before this file).
const review = window.StepForgeReview;

const AI_GUIDE_URL = 'https://github.com/Twest2/StepForge/blob/main/docs/getting_started_with_ai.md';

// Settings → Exports → Code theme. Mirrors CODE_THEME_CHOICES in
// core/code-highlight.js (a unit test keeps the two in step).
const CODE_THEME_CHOICES = [
  { value: 'atom-one-dark', label: 'Atom One Dark' },
  { value: 'atom-one-light', label: 'Atom One Light' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'solarized-light', label: 'Solarized Light' },
  { value: 'nord', label: 'Nord' },
  { value: 'plain', label: t('Plain (no highlighting)') },
];

const HOTKEY_LABELS = {
  CommandOrControl: 'Ctrl',
  Control: 'Ctrl',
  Command: 'Cmd',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Super',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Space: 'Space',
  Escape: 'Esc',
  Return: 'Enter',
};

function hotkeyLabel(part) {
  return HOTKEY_LABELS[part] || part;
}

/** Turn a keydown event into accelerator parts, or null if it's a bare modifier. */
function hotkeyFromEvent(e) {
  const modifiers = [];
  if (e.ctrlKey || e.metaKey) modifiers.push('CommandOrControl');
  if (e.altKey) modifiers.push('Alt');
  if (e.shiftKey) modifiers.push('Shift');

  const { key } = e;
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') {
    return { modifiers, key: null };
  }

  const SPECIAL_KEYS = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
  };

  let keyName = SPECIAL_KEYS[key];
  if (!keyName) {
    if (/^[a-zA-Z0-9]$/.test(key)) keyName = key.toUpperCase();
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) keyName = key;
    else return { modifiers, key: null };
  }
  return { modifiers, key: keyName };
}

/**
 * A "press to record" shortcut field, styled like a row of keycaps. Exposes
 * a `.value` getter/setter holding an Electron accelerator string (e.g.
 * "CommandOrControl+Shift+1"), so it slots in like a text input.
 */
function makeHotkeyInput(value = '') {
  let current = value || '';

  const keys = el('div.hotkey-keys');
  const clearBtn = el('button.hotkey-clear', {
    type: 'button',
    title: t('Clear shortcut'),
    onClick: (e) => {
      e.stopPropagation();
      current = '';
      render();
    },
  }, '×');

  const wrap = el('div.hotkey-input', { tabindex: '0', role: 'button', title: t('Click, then press a key combination') },
    keys, clearBtn);

  function renderKeys(parts) {
    keys.replaceChildren();
    parts.forEach((part, i) => {
      if (i > 0) keys.append(el('span.hotkey-sep', {}, '+'));
      keys.append(el('kbd', {}, hotkeyLabel(part)));
    });
  }

  function render() {
    if (wrap.classList.contains('recording')) {
      keys.replaceChildren(el('span.hotkey-placeholder', {}, t('Press a key combination…')));
      clearBtn.hidden = true;
      return;
    }
    if (!current) {
      keys.replaceChildren(el('span.hotkey-placeholder', {}, t('Click to set shortcut')));
      clearBtn.hidden = true;
      return;
    }
    renderKeys(current.split('+').filter(Boolean));
    clearBtn.hidden = false;
  }

  // While recording, a window-level capturing listener intercepts keydown
  // before the modal's own Escape handler can see it (capture order is
  // window -> document -> ... -> target), so Escape cancels recording
  // instead of closing the whole dialog.
  let recordingKeyHandler = null;

  wrap.addEventListener('focus', () => {
    wrap.classList.add('recording');
    render();
    recordingKeyHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        wrap.blur();
        return;
      }
      const { modifiers, key } = hotkeyFromEvent(e);
      if (key) {
        current = [...modifiers, key].join('+');
        wrap.blur();
      } else if (modifiers.length) {
        renderKeys([...modifiers, '…']);
      } else {
        render();
      }
    };
    window.addEventListener('keydown', recordingKeyHandler, true);
  });
  wrap.addEventListener('blur', () => {
    wrap.classList.remove('recording');
    if (recordingKeyHandler) {
      window.removeEventListener('keydown', recordingKeyHandler, true);
      recordingKeyHandler = null;
    }
    render();
  });

  Object.defineProperty(wrap, 'value', {
    get() { return current; },
    set(v) { current = v || ''; render(); },
  });

  render();
  return wrap;
}

/**
 * "Move to…" for a step: pick the place (after which step) and the level
 * there. `positions` is [{ value, label, current?, levels: [{ value, label }] }];
 * resolves { gap, depth } (the chosen values) or null.
 */
function showMoveStepDialog({ title = t('Move step'), hint = '', positions = [], currentDepth = 0 } = {}) {
  return new Promise((resolve) => {
    const where = el('select', {}, positions.map((p) => el('option', { value: p.value }, p.current ? t('{place} (current place)', { place: p.label }) : p.label)));
    const level = el('select', {});
    const fillLevels = () => {
      const position = positions.find((p) => p.value === where.value) || positions[0];
      clearNode(level);
      for (const l of position.levels) level.append(el('option', { value: l.value }, l.label));
      // Keep the step's present level where the new place allows it.
      const keep = position.levels.reduce((best, l) => (Math.abs(l.depth - currentDepth) < Math.abs(best.depth - currentDepth) ? l : best), position.levels[0]);
      if (keep) level.value = keep.value;
    };
    const current = positions.find((p) => p.current) || positions[0];
    if (current) where.value = current.value;
    where.addEventListener('change', fillLevels);
    fillLevels();

    const done = (value) => { close(); resolve(value); };
    const { close } = openModal({
      title,
      body: el('div', {},
        hint ? el('div.muted', { style: { marginBottom: '8px' } }, hint) : null,
        labeledRow(t('Place'), where),
        labeledRow(t('Level'), level),
      ),
      footer: [
        el('button', { onClick: () => done(null) }, t('Cancel')),
        el('button.primary', { onClick: () => done({ gap: where.value, depth: level.value }) }, t('Move')),
      ],
      onClose: () => resolve(null),
    });
    setTimeout(() => where.focus(), 0);
  });
}

async function promptText({
  title,
  label = 'Value',
  value = '',
  placeholder = '',
  multiline = false,
  onInput = null,
} = {}) {
  return new Promise((resolve) => {
    const field = multiline
      ? el('textarea', { rows: 6, placeholder }, value)
      : el('input', { type: 'text', value, placeholder });

    const { close } = openModal({
      title,
      body: labeledRow(label, field, { stacked: multiline }),
      footer: [
        el('button', { onClick: () => { close(); resolve(null); } }, t('Cancel')),
        el('button.primary', { onClick: () => { close(); resolve(field.value); } }, t('OK')),
      ],
      onClose: () => resolve(null),
    });

    field.addEventListener('keydown', (e) => {
      if (multiline && e.key === 'Enter') {
        // Let the textarea keep the Enter key for a new line.
        e.stopPropagation();
        return;
      }
      if (!multiline && e.key === 'Enter') {
        e.preventDefault();
        close();
        resolve(field.value);
      }
    });
    field.addEventListener('input', () => {
      if (typeof onInput === 'function') onInput(field.value);
    });

    setTimeout(() => field.focus(), 0);
  });
}

function showQuickActions({ query = '', commands = [], searchFn, onOpenItem, onClose } = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      type: 'search',
      value: query,
      placeholder: t('Search guides, steps, and commands'),
      autocomplete: 'off',
      spellcheck: false,
    });
    const results = el('div.qa-results');
    const hint = el('div.muted', {}, t('Type to search, arrows to move, Enter to open.'));
    let items = [];
    let active = 0;

    function updateActiveItem() {
      [...results.children].forEach((row, idx) => row.classList.toggle('active', idx === active));
    }

    function renderItems() {
      clearNode(results);
      if (!items.length) {
        results.append(el('div.muted', { style: { padding: '8px 2px' } }, t('No matches.')));
        return;
      }
      items.forEach((item, idx) => {
        results.append(el('div.qa-item', {
          className: `qa-item${idx === active ? ' active' : ''}`,
          onMouseenter: () => { active = idx; updateActiveItem(); },
          onClick: () => choose(idx),
        },
        el('span.kind', {}, item.kind || 'cmd'),
        el('div', {},
          el('div', { style: { fontWeight: 600 } }, item.label),
          item.description ? el('div.snippet', {}, item.description) : null,
        )));
      });
    }

    function choose(idx = active) {
      const item = items[idx];
      if (!item) return;
      close();
      if (item.action) item.action();
      if (onOpenItem) onOpenItem(item);
      resolve(item);
    }

    async function refresh() {
      const q = input.value.trim();
      const commandMatches = commands.filter((cmd) => {
        if (!q) return true;
        const needle = q.toLowerCase();
        return `${cmd.label} ${cmd.description || ''}`.toLowerCase().includes(needle);
      }).map((cmd) => ({ ...cmd, kind: cmd.kind || 'cmd' }));
      const searchResults = q && searchFn ? await searchFn(q) : [];
      items = [...commandMatches, ...searchResults];
      if (active >= items.length) active = 0;
      renderItems();
    }

    const { close } = openModal({
      title: t('Quick Actions'),
      body: el('div.quick-actions', {},
        input,
        hint,
        results,
      ),
      wide: true,
      footer: [
        el('button', { onClick: () => { close(); resolve(null); } }, t('Close')),
      ],
      onClose: () => {
        if (onClose) onClose();
        resolve(null);
      },
    });

    const debounced = debounce(refresh, 60);
    input.addEventListener('input', debounced);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.max(0, Math.min(items.length - 1, active + 1)); updateActiveItem(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); updateActiveItem(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); resolve(null); }
    });

    refresh();
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * Ctrl+H. `find({ query, replacement, caseSensitive, wholeWord })` resolves to
 * { matches, truncated } (see core/find-replace.js); `replace(matches,
 * replacement)` replaces the ticked ones and resolves to how many it replaced.
 * Matches the replacement cannot go into (`blocked`) are listed but locked.
 */
function showFindReplace({ stepNumbers = {}, find, replace } = {}) {
  return new Promise((resolve) => {
    const query = el('input', { type: 'search', placeholder: t('Find'), autocomplete: 'off', spellcheck: false });
    const replacement = el('input', { type: 'text', placeholder: t('Replace with'), autocomplete: 'off', spellcheck: false });
    const matchCase = el('input', { type: 'checkbox' });
    const wholeWord = el('input', { type: 'checkbox' });
    const summary = el('span.muted');
    const list = el('div.qa-results.fr-results');
    const replaceButton = el('button.primary', { disabled: true }, t('Replace'));
    let matches = [];
    let unticked = new Set(); // ids the user unticked; everything else is ticked
    let lastSearch = '';
    let token = 0;
    let busy = false;
    // True from the moment Find, Replace or an option changes until the search
    // for exactly those inputs comes back: the listed matches (and which of
    // them the replacement can go into) belong to the old inputs meanwhile.
    let stale = false;

    const chosen = () => matches.filter((m) => !m.blocked && !unticked.has(m.id));

    function updateSummary() {
      const n = chosen().length;
      const blocked = matches.filter((m) => m.blocked).length;
      summary.textContent = !query.value ? t('Type something to find.')
        : stale ? t('Searching…')
          : !matches.length ? t('No matches.')
            : blocked ? tn(matches.length, '{count} match, {selected} selected, {blocked} cannot take this replacement.',
              '{count} matches, {selected} selected, {blocked} cannot take this replacement.', { selected: n, blocked })
              : tn(matches.length, '{count} match, {selected} selected.', '{count} matches, {selected} selected.', { selected: n });
      replaceButton.disabled = busy || stale || n === 0;
      replaceButton.textContent = n ? t('Replace {count}', { count: n }) : t('Replace');
    }

    function renderList(truncated) {
      clearNode(list);
      for (const m of matches) {
        const box = el('input', { type: 'checkbox', checked: !m.blocked && !unticked.has(m.id), disabled: Boolean(m.blocked) });
        box.addEventListener('change', () => {
          if (box.checked) unticked.delete(m.id); else unticked.add(m.id);
          updateSummary();
        });
        list.append(el('label.qa-item.fr-item', { title: m.blocked || '' },
          box,
          el('div', {},
            el('div.snippet', {}, el('b', {}, t('Step {number}', { number: stepNumbers[m.stepId] || m.stepIndex + 1 })), ` · ${m.where}`),
            el('div', {}, m.before, el('mark', {}, m.matched), m.after),
            m.blocked ? el('div.muted', {}, m.blocked) : null,
          )));
      }
      if (truncated) list.append(el('div.muted', { style: { padding: '8px 2px' } }, t('Showing the first {count} matches. Narrow the search to see the rest.', { count: matches.length })));
      updateSummary();
    }

    /** The inputs changed: drop any search in flight and lock Replace until the new one is back. */
    function invalidate() {
      token += 1;
      stale = true;
      updateSummary();
    }

    async function refresh() {
      const mine = ++token;
      stale = true;
      const search = JSON.stringify([query.value, matchCase.checked, wholeWord.checked]);
      if (search !== lastSearch) { unticked = new Set(); lastSearch = search; }
      let result = { matches: [], truncated: false };
      if (query.value) {
        try {
          result = await find({
            query: query.value, replacement: replacement.value,
            caseSensitive: matchCase.checked, wholeWord: wholeWord.checked,
          });
        } catch { /* keep the empty result; the next keystroke retries */ }
      }
      if (mine !== token) return;
      matches = result.matches;
      stale = false;
      renderList(result.truncated);
    }

    async function doReplace() {
      const picked = chosen();
      if (!picked.length || busy || stale) return;
      busy = true;
      updateSummary();
      try {
        await replace(picked.map((m) => ({
          id: m.id, stepId: m.stepId, path: m.path, node: m.node, start: m.start, end: m.end, matched: m.matched, kind: m.kind,
        })), replacement.value);
        close();
        resolve(true);
      } catch (err) {
        busy = false;
        summary.textContent = t('Could not replace: {error}', { error: (err && err.message) || err });
      }
    }

    const { close } = openModal({
      title: t('Find and replace'),
      wide: true,
      body: el('div.quick-actions', {},
        query,
        el('div', { style: { height: '8px' } }),
        replacement,
        el('div.form-row', { style: { gap: '16px', margin: '8px 0' } },
          el('label', {}, matchCase, ' Match case'),
          el('label', {}, wholeWord, ' Whole word'),
          summary),
        list,
        el('div.muted', { style: { marginTop: '8px' } },
          t('Searches step titles and descriptions, text, code and table blocks, and annotation labels. Screenshots are not changed. Ctrl+Z undoes the whole replacement.')),
      ),
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, t('Close')),
        replaceButton,
      ],
      onClose: () => resolve(false),
    });

    const debounced = debounce(refresh, 120);
    for (const field of [query, replacement]) field.addEventListener('input', () => { invalidate(); return debounced(); });
    for (const box of [matchCase, wholeWord]) box.addEventListener('change', () => { invalidate(); return refresh(); });
    replaceButton.addEventListener('click', doReplace);
    query.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); refresh(); } });
    replacement.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doReplace(); } });

    updateSummary();
    setTimeout(() => query.focus(), 0);
  });
}

/**
 * Settings → About "Check for updates", and on Windows installs registered
 * with Chocolatey, "Update now". The check only contacts GitHub when pressed
 * (app/update-check.js); Update now is decided and run by the main process
 * (app/windows-update.js). A Microsoft Store install is offered its Store page
 * instead of a download. `flushEdits` saves the open guide before StepForge
 * closes for the update and resolves false if that failed.
 */
function makeUpdateCheck(api, { openLink, flushEdits = null }) {
  const updateStatus = el('div.update-status', { role: 'status', 'aria-live': 'polite' });
  const checkUpdatesBtn = el('button', { type: 'button' }, t('Check for updates'));

  const updateNowButton = (result) => {
    const button = el('button.primary', { type: 'button' }, t('Update now'));
    const note = el('div.setting-desc.update-now-note', {});
    button.addEventListener('click', async () => {
      const ok = await confirmDialog(`StepForge will close to install version ${result.latestVersion}. Continue?`, { okLabel: t('Update now') });
      if (!ok) return;
      note.textContent = '';
      note.classList.remove('error');
      setButtonLoading(button, true, t('Starting…'));
      let outcome;
      try {
        if (flushEdits && !await flushEdits()) {
          outcome = { ok: false, message: t('Your latest changes couldn’t be saved, so the update didn’t start.') };
        } else {
          outcome = await api.app.updateNow();
        }
      } catch {
        outcome = { ok: false, message: t('Couldn’t start the update. Try again, or download the new installer.') };
      }
      if (outcome && outcome.ok) {
        // StepForge quits on its own; keep the button off until it does.
        setButtonLoading(button, true, t('Closing StepForge…'));
        note.textContent = t('An administrator window will install the update and reopen StepForge.');
        return;
      }
      setButtonLoading(button, false);
      note.textContent = (outcome && outcome.message) || t('Couldn’t start the update.');
      note.classList.toggle('error', outcome?.reason !== 'declined');
    });
    return { button, note };
  };

  // The Store installs the update; this only opens StepForge's Store page.
  const storeButton = () => {
    const button = el('button.primary', { type: 'button' }, t('Open Microsoft Store'));
    const note = el('div.setting-desc.update-now-note', {});
    button.addEventListener('click', async () => {
      note.textContent = '';
      note.classList.remove('error');
      let outcome;
      try {
        outcome = await api.app.openStore();
      } catch {
        outcome = null;
      }
      if (!outcome || !outcome.ok) {
        note.textContent = t('Couldn’t open the Microsoft Store. Open it from the Start menu, then choose Library → Get updates.');
        note.classList.add('error');
      }
    });
    return { button, note };
  };

  checkUpdatesBtn.addEventListener('click', async () => {
    setButtonLoading(checkUpdatesBtn, true, t('Checking…'));
    clearNode(updateStatus);
    updateStatus.className = 'update-status';
    let result;
    try {
      result = await api.app.checkForUpdates();
    } catch {
      result = { status: 'error', message: t('Couldn’t check for updates. Try again later.') };
    } finally {
      setButtonLoading(checkUpdatesBtn, false);
    }
    if (result.status === 'update-available') {
      updateStatus.classList.add('available');
      if (result.store) {
        const store = storeButton();
        updateStatus.append(
          el('div.update-status-title', {}, t('Version {version} is available', { version: result.latestVersion })),
          el('div.setting-desc', {}, `${t('You have {version}.', { version: result.currentVersion })} ${result.hint || ''}`),
          el('div.settings-actions', {}, store.button),
          store.note);
        return;
      }
      // With Update now, downloading stays available as the secondary action.
      const updateNow = result.updateNow ? updateNowButton(result) : null;
      const download = el(updateNow ? 'button' : 'button.primary', { type: 'button', onClick: openLink(result.releaseUrl) }, t('View release and download'));
      updateStatus.append(
        el('div.update-status-title', {}, t('Version {version} is available', { version: result.latestVersion })),
        el('div.setting-desc', {}, `${t('You have {version}.', { version: result.currentVersion })} ${result.hint || ''}`),
        el('div.settings-actions', {}, updateNow ? updateNow.button : null, download),
        ...(updateNow ? [updateNow.note] : []));
    } else if (result.status === 'up-to-date') {
      updateStatus.classList.add('current');
      updateStatus.append(el('div.update-status-title', {}, t('You’re up to date')),
        el('div.setting-desc', {}, t('Version {version} is the latest release.', { version: result.currentVersion })));
    } else {
      updateStatus.classList.add('error');
      updateStatus.append(el('div.setting-desc', {}, result.message || t('Couldn’t check for updates.')));
      checkUpdatesBtn.textContent = t('Try again');
    }
  });
  return { checkUpdatesBtn, updateStatus };
}

/**
 * Settings → Guide storage: the warning for a library, or a pending move, in
 * a folder that OneDrive, Dropbox, Google Drive or Nextcloud syncs
 * (`syncedBy` from storage:status, app/synced-folders.js). Null when there's
 * nothing to warn about.
 */
function storageWarning(info) {
  const syncedBy = (info && info.syncedBy) || {};
  const service = info && info.pending ? syncedBy.pending : syncedBy.current;
  if (!service) return null;
  const subject = info.pending ? 'The folder you chose is' : 'Your guides are';
  return {
    title: `${subject} in a folder that ${service} syncs`,
    text: `${service} uploads every guide and screenshot in it, even with StepForge’s sync turned off, and the two can get in each other’s way if you use both. `
      + `Choose a folder ${service} doesn’t sync. To keep guides in step across computers, use StepForge’s own sync in Settings → Accounts.`,
  };
}

function showSettingsDialog({
  api,
  settings,
  placeholders = {},
  onSave,
  onPublishToWeb = null,
  flushEdits = null,
  section: initialSection = 'general',
} = {}) {
  return new Promise((resolve) => {
    const form = el('form', { className: 'settings-form' });
    // A service's id ("drive", "onedrive", "dropbox", "webdav", "github")
    // opens Accounts with that service's panel showing.
    const accountView = ['drive', 'onedrive', 'dropbox', 'webdav', 'github', 'confluence', 'wikijs'].includes(initialSection) ? initialSection : null;
    if (accountView) initialSection = 'accounts';
    const accountsPanel = makeAccountsSettings(api, { view: accountView, onPublishToWeb });
    const brandingPanel = makeBrandingSettings(api, { activeProfileId: settings.branding?.activeProfileId || '' });
    const storagePath = el('code.settings-path', {}, t('Checking guide storage location…'));
    const storageNote = el('div.setting-desc', {}, '');
    const showStorageError = (message) => { storageNote.textContent = message; storageNote.classList.add('error'); };
    const chooseStorageBtn = el('button', { type: 'button' }, t('Choose folder…'));
    const resetStorageBtn = el('button', { type: 'button' }, t('Use default'));
    const cancelStorageBtn = el('button', { type: 'button', hidden: true }, t('Cancel pending move'));
    const storageWarningNote = el('div.storage-warning', { role: 'note', hidden: true });
    let storageInfo = null;
    const refreshStorage = async () => {
      try {
        storageInfo = await api.storage.status();
        storagePath.textContent = storageInfo.current;
        storagePath.title = storageInfo.current;
        const notes = [storageInfo.current === storageInfo.defaultPath ? t('Default location.') : t('Default: {path}', { path: storageInfo.defaultPath })];
        if (storageInfo.pending) notes.push(t('Moving to {path} the next time StepForge starts.', { path: storageInfo.pending }));
        if (storageInfo.locked) notes.push(t('Set by STEPFORGE_DATA_DIR for this session.'));
        if (storageInfo.error) notes.push(storageInfo.error);
        storageNote.textContent = notes.join(' ');
        storageNote.classList.toggle('error', Boolean(storageInfo.error));
        const warning = storageWarning(storageInfo);
        storageWarningNote.hidden = !warning;
        storageWarningNote.replaceChildren(...(warning ? [
          el('span.gh-warning-icon', { 'aria-hidden': 'true' }, '!'),
          el('div', {}, el('strong', {}, warning.title), el('p', {}, warning.text)),
        ] : []));
        chooseStorageBtn.disabled = storageInfo.locked;
        resetStorageBtn.disabled = storageInfo.locked || storageInfo.current === storageInfo.defaultPath;
        cancelStorageBtn.hidden = !storageInfo.pending;
      } catch (error) {
        showStorageError(error.message || t('Could not read guide storage location.'));
      }
    };
    chooseStorageBtn.addEventListener('click', async () => {
      try { await api.storage.choose(); await refreshStorage(); } catch (error) { showStorageError(error.message || t('Could not schedule the library move.')); }
    });
    resetStorageBtn.addEventListener('click', async () => {
      try { await api.storage.reset(); await refreshStorage(); } catch (error) { showStorageError(error.message || t('Could not schedule the library move.')); }
    });
    cancelStorageBtn.addEventListener('click', async () => { await api.storage.cancelMove(); await refreshStorage(); });
    void refreshStorage();
    const versionLabel = el('span', {}, '—');
    const buildLabel = el('span.settings-chip', {}, '');
    const licenseLabel = el('span', {}, '—');
    const dataDirLabel = el('code.settings-path', {}, '—');
    api.app.info().then((info) => {
      versionLabel.textContent = info.buildVersion || info.version;
      buildLabel.textContent = info.devBuild ? t('Development build') : t('Release');
      buildLabel.classList.toggle('dev', Boolean(info.devBuild));
      licenseLabel.textContent = info.license || '—';
      dataDirLabel.textContent = info.dataDir || '—';
      dataDirLabel.title = info.dataDir || '';
    }).catch(() => { versionLabel.textContent = t('Unavailable'); });
    const openLink = (url) => () => { void api.shell.openExternal({ url }).catch(() => {}); };
    // An inline link in a setting's description; opens in the browser.
    const docLink = (label, url) => el('a', { href: url, onClick: (e) => { e.preventDefault(); openLink(url)(); } }, label);
    const { checkUpdatesBtn, updateStatus } = makeUpdateCheck(api, { openLink, flushEdits });

    const appearance = makeSelect(settings.appearance || 'system', [
      { value: 'system', label: t('System') },
      { value: 'light', label: t('Light') },
      { value: 'dark', label: t('Dark') },
    ]);
    const spellcheck = el('input', { type: 'checkbox', checked: Boolean(settings.spellcheck) });
    // Each language is listed in its own name, so anyone can find theirs.
    // Translations are new, so every language but English is marked Beta.
    const language = makeSelect(settings.language || 'system', [
      { value: 'system', label: t('System default') },
      ...StepForgeI18n.LANGUAGES.map((l) => ({ value: l.code, label: l.code === 'en' ? l.name : `${l.name} (${t('Beta')})` })),
    ]);
    const languageBeta = betaBadge();
    const syncLanguageBeta = () => {
      languageBeta.hidden = StepForgeI18n.resolveLanguage(language.value, navigator.languages) === 'en';
    };
    language.addEventListener('change', syncLanguageBeta);
    syncLanguageBeta();
    const delayMs = makeInput(settings.capture?.delayMs ?? 0, 'number', { min: 0, step: 50 });
    // An older settings file may still hold 'region', which recording always
    // treated as fullscreen. Show what actually happens.
    const captureMode = makeSelect(settings.capture?.mode === 'window' ? 'window' : 'fullscreen', [
      { value: 'fullscreen', label: t('Fullscreen') },
      { value: 'window', label: t('Window') },
    ]);
    const smartCropping = el('input', { type: 'checkbox', checked: settings.capture?.smartCropping !== false });
    const redactOnCapture = el('input', { type: 'checkbox', checked: settings.redaction?.onCapture === true });
    const redactTerms = el('textarea.redact-terms', { rows: 4, spellcheck: false, placeholder: t('One per line, for example a name or project code'),
      'aria-label': t('Words to always hide') });
    redactTerms.value = (settings.redaction?.terms || []).join('\n');
    const focusValue = Number(settings.capture?.focusAmount ?? 1.25);
    const focusAmount = el('input', { type: 'range', min: 1, max: 2, step: 0.05,
      'aria-label': t('Default focus amount'), value: Number.isFinite(focusValue) ? Math.max(1, Math.min(2, focusValue)) : 1.25 });
    const focusLabel = el('output', {}, `${Number(focusAmount.value).toFixed(2)}×`);
    focusAmount.addEventListener('input', () => { focusLabel.textContent = `${Number(focusAmount.value).toFixed(2)}×`; });
    const focusControl = el('div.row.settings-range', {}, focusAmount, focusLabel, el('button', { type: 'button', onClick: () => {
      focusAmount.value = '1.25'; focusLabel.textContent = '1.25×';
    } }, t('Reset')));
    const clickMarker = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.clickMarker) });
    const captureHotkey = makeHotkeyInput(settings.capture?.hotkeyCapture || '');
    const pauseHotkey = makeHotkeyInput(settings.capture?.hotkeyPauseResume || '');
    const focusedDefault = el('input', { type: 'checkbox', checked: settings.editor?.focusedViewDefaultForNewSteps !== false });
    const previewCount = makeInput(settings.exports?.previewStepCount ?? 3, 'number', { min: 1, step: 1 });
    const openFolder = el('input', { type: 'checkbox', checked: Boolean(settings.exports?.openFolderAfterExport) });
    const codeTheme = makeSelect(CODE_THEME_CHOICES.some((t) => t.value === settings.exports?.codeTheme) ? settings.exports.codeTheme : 'atom-one-dark',
      CODE_THEME_CHOICES);
    const captureOutside = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.captureOutsideClicks) });
    const fallbackTrigger = makeSelect(settings.capture?.fallbackTrigger === 'interval' ? 'interval' : 'hotkey', [
      { value: 'hotkey', label: t('Hotkey') },
      { value: 'interval', label: t('Timed interval') },
    ]);
    const autoIntervalSec = makeInput(settings.capture?.autoIntervalSec ?? 5, 'number', { min: 1, step: 1 });
    const keepLast = makeInput(settings.backups?.keepLast ?? 10, 'number', { min: 0, step: 1 });
    const trashDays = makeSelect(String(settings.library?.trashDays ?? 30), [
      { value: '7', label: t('After 7 days') },
      { value: '30', label: t('After 30 days') },
      { value: '90', label: t('After 90 days') },
      { value: '0', label: t('Never') },
    ]);
    const reviewAfterDays = review.normalizeReviewDays(settings.library?.reviewAfterDays) ?? review.DEFAULT_REVIEW_DAYS;
    const reviewDefault = makeSelect(String(reviewAfterDays), [
      ...review.REVIEW_INTERVALS.map((i) => ({ value: String(i.days), label: t('After {interval}', { interval: intervalText(i.days) }) })),
      ...(reviewAfterDays > 0 && !review.REVIEW_INTERVALS.some((i) => i.days === reviewAfterDays)
        ? [{ value: String(reviewAfterDays), label: t('After {interval}', { interval: intervalText(reviewAfterDays) }) }] : []),
      { value: '0', label: t('Never') },
    ]);
    const aiEnabled = el('input', { type: 'checkbox', checked: Boolean(settings.ai?.enabled) });
    const aiAutoDoc = el('input', { type: 'checkbox', checked: Boolean(settings.ai?.autoDoc) });
    const ollamaHost = makeInput(settings.ai?.ollama?.host || 'http://127.0.0.1:11434');
    const ollamaModel = makeInput(settings.ai?.ollama?.model || 'llama3.2:1b');
    // Filled with the installed models after Test connection, so the model box suggests them.
    const ollamaModels = el('datalist', { id: 'ollama-models' });
    ollamaModel.setAttribute('list', 'ollama-models');
    const aiScreenshots = el('input', { type: 'checkbox', checked: settings.ai?.attachScreenshots !== false });
    const agentsEnabled = el('input', { type: 'checkbox', checked: Boolean(settings.ai?.agents?.enabled) });
    const agentsScreenshots = el('input', { type: 'checkbox', checked: settings.ai?.agents?.screenshots !== false });
    const agentsBranding = el('input', { type: 'checkbox', checked: Boolean(settings.ai?.agents?.branding) });
    // How Claude Code, Codex, or any MCP app starts StepForge for agents.
    const agentSetup = el('div.agent-setup', {}, el('div.setting-desc', {}, t('Loading the setup commands…')));
    const AGENT_SETUPS = [
      ['claude', 'Claude Code', t('Run this in a terminal once.')],
      ['codex', 'Codex', t('Run this in a terminal once.')],
      ['json', t('Claude Desktop, Cursor, and other apps'), t('Add this to the app’s MCP servers settings.')],
    ];
    api.agents.setup().then((texts) => {
      agentSetup.replaceChildren(...AGENT_SETUPS.map(([kind, label, hint]) => {
        const copy = el('button', {
          type: 'button',
          onClick: async () => {
            await api.agents.copy({ kind });
            copy.textContent = t('Copied');
            setTimeout(() => { copy.textContent = t('Copy'); }, 1500);
          },
        }, t('Copy'));
        return el('div.agent-setup-row', {},
          el('div.setting-text', {}, el('div.setting-title', {}, label), el('div.setting-desc', {}, hint)),
          el('pre.agent-command', {}, texts[kind]),
          copy);
      }));
    }).catch((err) => {
      agentSetup.replaceChildren(el('div.setting-desc.error', {}, t('Could not build the setup commands: {error}', { error: err.message || err })));
    });
    const aiStatus = el('div', { className: 'ai-status' }, t('Not tested yet. Vision-capable models can also inspect each step’s screenshot.'));
    const testAiBtn = el('button', { type: 'button' }, t('Test connection'));
    const persistOllamaModel = debounce(() => {
      const model = ollamaModel.value.trim();
      // Keep the last model choice even if the dialog is dismissed without a full save.
      void api.settings.set({ keyPath: 'ai.ollama.model', value: model }).catch(() => {});
    }, 250);

    const syncFallbackUi = () => {
      // The timer only matters for timed captures, so hide it otherwise.
      intervalRow.hidden = fallbackTrigger.value !== 'interval';
    };
    const intervalRow = el('div');
    fallbackTrigger.addEventListener('change', syncFallbackUi);
    syncFallbackUi();

    const updateAiStatus = (message, { error = false, ok = false } = {}) => {
      aiStatus.textContent = message;
      aiStatus.classList.toggle('error', Boolean(error));
      aiStatus.classList.toggle('ok', Boolean(ok));
    };

    const testAiConnection = async () => {
      setButtonLoading(testAiBtn, true, t('Testing…'));
      updateAiStatus(t('Checking Ollama at the configured host…'));
      try {
        const result = await api.ai.test({
          ollama: {
            host: ollamaHost.value.trim(),
            model: ollamaModel.value.trim(),
          },
        });
        if (!result.ok) {
          updateAiStatus(result.reason || t('Could not connect to Ollama.'), { error: true });
          return;
        }
        ollamaModels.replaceChildren(...(result.models || []).map((model) => el('option', { value: model })));
        if (result.installed) {
          updateAiStatus(result.vision
            ? t('Connected to {host} with {model}. It can inspect screenshots.', { host: result.host, model: result.model })
            : t('Connected to {host} with {model}. This model is text-only, so StepForge will use OCR and metadata only.', { host: result.host, model: result.model }), { ok: true });
        } else {
          const installed = (result.models || []).join(', ');
          updateAiStatus(installed
            ? t('Connected to {host}, but {model} isn’t installed. Installed models: {installed}.', { host: result.host, model: result.model || t('that model'), installed })
            : t('Connected to {host}, but it has no models yet. Run “ollama pull gemma3” first.', { host: result.host }), { error: true });
        }
      } catch (err) {
        updateAiStatus(err.message || t('Could not connect to Ollama.'), { error: true });
      } finally {
        setButtonLoading(testAiBtn, false);
      }
    };
    ollamaModel.addEventListener('input', () => persistOllamaModel());
    ollamaModel.addEventListener('blur', () => persistOllamaModel.flush());

    const placeholderHeader = el('div.global-placeholder-header.hidden', {},
      el('span', {}, t('Placeholder name')), el('span', {}, t('Content')));
    const placeholderRows = el('div', { className: 'placeholder-rows global-placeholder-rows' }, placeholderHeader);
    const rows = [];
    const addPlaceholderRow = (key = '', value = '') => {
      const keyInput = el('textarea.global-placeholder-name', { rows: 4, 'aria-label': t('Placeholder name'), placeholder: '[[placeholder-name]]' }, key);
      keyInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });
      keyInput.addEventListener('input', () => { keyInput.value = keyInput.value.replace(/[\r\n]/g, ''); });
      const valueInput = el('textarea.global-placeholder-value', { rows: 4, 'aria-label': t('Placeholder content'), placeholder: t('Markdown or regular text') }, typeof value === 'object' ? value.text || '' : value);
      const valueCell = el('div.placeholder-markdown-content', {}, valueInput);

      const removeBtn = el('button.icon', {
        type: 'button',
        title: t('Remove placeholder'),
        onClick: () => {
          row.remove();
          rows.splice(rows.indexOf(row), 1);
          placeholderHeader.classList.toggle('hidden', rows.length === 0);
        },
      }, '−');
      const row = el('div.placeholder-row', {},
        keyInput,
        valueCell,
        removeBtn,
      );
      // Keep unchanged legacy plain-text values intact when saving Settings.
      row.placeholderValue = value;
      row.placeholderOriginalText = valueInput.value;
      rows.push(row);
      placeholderHeader.classList.remove('hidden');
      placeholderRows.append(row);
      return row;
    };
    Object.entries(placeholders || {}).forEach(([k, v]) => addPlaceholderRow(k, v));

    const addPlaceholderBtn = el('button', {
      type: 'button',
      onClick: () => addPlaceholderRow(),
    }, t('Add placeholder'));

    const sections = [
      { id: 'general', label: t('General'), description: t('Appearance, exports, where your guides and deleted guides are kept, and when guides are due for review.'), content: [
        settingsCard(t('Appearance'),
          settingRow(t('Theme'), t('Match your system, or always use light or dark.'), appearance),
          settingRow(t('Spellcheck'), t('Underline misspelled words while editing.'), makeSwitch(spellcheck, t('Spellcheck')))),
        settingsCard(t('Exports'),
          settingRow(t('Open folder after export'), t('Show the exported file in your file manager.'), makeSwitch(openFolder, t('Open folder after export'))),
          settingRow(t('Preview step count'), t('How many steps the export preview renders.'), previewCount),
          settingRow(t('Code theme'), t('Syntax colors for code blocks in PDF, Word, HTML and Confluence exports.'), codeTheme)),
        settingsCard(t('Guide storage'),
          el('div.settings-storage', {}, storagePath, storageNote),
          storageWarningNote,
          el('div.settings-actions', {}, chooseStorageBtn, resetStorageBtn, cancelStorageBtn),
          el('div.setting-desc', {}, t('Choose an empty folder. StepForge copies and verifies your library, then switches to it the next time it starts. The old library is kept as a backup.'))),
        settingsCard(t('Trash'),
          settingRow(t('Empty the trash'), t('Deleted guides are removed for good after this long.'), trashDays)),
        settingsCard(t('Guide reviews'),
          settingRow(t('Flag guides for review'), t('Guides that haven’t been saved or marked verified for this long show “May need review” in the library. Each guide can change this in Guide information.'), reviewDefault)),
        settingsCard(t('Language'),
          settingRow(t('Language'), t('The language of StepForge’s menus, buttons and messages. Exported guides stay in English.'),
            el('div.row', {}, language, languageBeta))),
      ] },
      { id: 'branding', label: t('Branding'), description: t('Customize how exported guides appear.'), content: [brandingPanel.node] },
      { id: 'capture', label: t('Capture'), description: t('How StepForge records steps.'), content: [
        settingsCard(t('Recording'),
          settingRow(t('Default mode'), t('Record the whole screen or the active window. For a region, use Capture → Capture region….'), captureMode),
          settingRow(t('Delay'), t('Milliseconds to wait before each screenshot.'), delayMs),
          settingRow(t('Click marker'), t('Draw a marker where you clicked.'), makeSwitch(clickMarker, t('Click marker'))),
          settingRow(t('Capture outside clicks'), t('Record clicks in other apps while a capture session is running.'), makeSwitch(captureOutside, t('Capture outside clicks')))),
        settingsCard(t('When clicks can’t be detected'),
          settingRow(t('Capture with'), t('Some desktops don’t report clicks. Choose how steps are captured instead.'), fallbackTrigger),
          (intervalRow.append(settingRow(t('Timer interval'), t('Seconds between timed captures.'), autoIntervalSec)), intervalRow)),
        settingsCard(t('Hotkeys'),
          settingRow(t('Capture'), t('Take a step. Also used when clicks can’t be detected.'), captureHotkey),
          settingRow(t('Pause / resume'), t('Pause or resume the capture session.'), pauseHotkey)),
      ] },
      { id: 'editor', label: t('Editor'), description: t('Defaults for new steps and automatic backups.'), content: [
        settingsCard(t('New steps'),
          settingRow(t('Focus recorded clicks'), t('Zoom new screenshots toward where you clicked.'), makeSwitch(smartCropping, t('Focus recorded clicks'))),
          settingRow(t('Default focus amount'), t('More context (1×) to closer focus (2×). Applies to new captures only.'), focusControl),
          settingRow(t('Focused view for new steps'), t('Open new steps in focused view.'), makeSwitch(focusedDefault, t('Focused view for new steps')))),
        settingsCard(t('Backups'),
          settingRow(t('Snapshots to keep'), t('Older backup snapshots of each guide are removed. 0 keeps all of them.'), keepLast)),
      ] },
      { id: 'privacy', label: t('Privacy'), description: t('Blur private details in screenshots. Everything is checked on this computer.'), content: [
        settingsCard(t('Private details'),
          el('div.setting-desc', {}, t('Before a guide goes on the web, StepForge reads its screenshots and blurs email addresses, phone and card numbers, Social Security numbers, IP addresses, passwords, keys, and links with private tokens. You can review every blur and undo any that aren’t needed.')),
          settingRow(t('Blur while recording'), t('Check each new capture as soon as it’s taken, instead of waiting until you publish.'), makeSwitch(redactOnCapture, t('Blur while recording'))),
          settingRow(t('Always hide these words'), t('Names, project codes, or anything else to blur wherever it appears. One per line.'), redactTerms)),
      ] },
      { id: 'ai', label: t('AI'), description: t('Let AI write your guides: a model on your own computer through Ollama, or an AI agent such as Claude or Codex.'), content: [
        settingsCard(null,
          settingRow(t('Enable AI'), t('Turn on the AI ▾ menu in the guide toolbar: write a whole guide, a step, or one field.'), makeSwitch(aiEnabled, t('Enable AI'))),
          settingRow(t('Auto-document captures'), t('Write a title and description for each new capture as you record. Turn off to use AI only when you ask.'), makeSwitch(aiAutoDoc, t('Auto-document captures'))),
          settingRow(t('Let the model see screenshots'), t('Models that can read images see each step’s screenshot, with blurred areas already hidden. Turn off to send text only.'), makeSwitch(aiScreenshots, t('Let the model see screenshots')))),
        settingsCard(t('Ollama'),
          el('div.setting-desc', {}, t('Runs on your computer, so your screenshots and text stay here.')),
          settingRow(t('Host'), t('Where Ollama is running.'), ollamaHost),
          settingRow(t('Model'), el('span', {},
            t('Any installed model. Choose Test connection to list them.'), ' ',
            docLink(t('AI guide'), AI_GUIDE_URL), ' · ', docLink(t('Recommended models'), `${AI_GUIDE_URL}#recommended-models`)),
          ollamaModel),
          el('div.settings-test', {}, aiStatus, testAiBtn, ollamaModels)),
        settingsCard(t('AI agents (Claude, Codex)'),
          el('div.setting-desc', {}, t('AI apps such as Claude and Codex can connect to StepForge and edit your guides. They can create and delete guides and steps, reorder steps, replace or remove screenshots, edit text, add placeholders, and add or delete annotations except blurs. StepForge saves snapshots before step creation, moves, deletions and screenshot changes; restore them from More → Backups & snapshots. Deleted guides go to the Trash.')),
          settingRow(t('Let AI agents edit your guides'), t('Turn off to cut off every connected agent at once.'), makeSwitch(agentsEnabled, t('Let AI agents edit your guides'))),
          settingRow(t('Agents can see screenshots'), t('Blurred areas are filled in first. Turn off to share step text only.'), makeSwitch(agentsScreenshots, t('Agents can see screenshots'))),
          settingRow(t('Let AI agents edit brand profiles'), t('Agents can make and change brand profiles: logo, colors, fonts and CSS, and choose the one exports use. They can’t delete a profile.'), makeSwitch(agentsBranding, t('Let AI agents edit brand profiles'))),
          agentSetup),
      ] },
      { id: 'accounts', label: t('Accounts'), description: t('Sync guides with Google Drive, OneDrive, Dropbox or Nextcloud, share them on the web with GitHub, or publish them to Confluence or Wiki.js.'), content: [accountsPanel.node] },
      { id: 'placeholders', label: t('Placeholders'), description: t('Reusable text for every guide. Type [[name]] in a guide to insert it.'), content: [
        settingsCard(null, placeholderRows, el('div.settings-actions', {}, addPlaceholderBtn)),
      ] },
      { id: 'about', label: t('About'), description: '', content: [
        el('div.settings-about', {},
          el('img.settings-about-mark', { src: '../assets/stepforge.png', alt: '', width: 56, height: 56 }),
          el('div', {}, el('div.settings-about-name', {}, 'StepForge'),
            el('div.setting-desc', {}, t('Local-first step-by-step guides.')))),
        settingsCard(null,
          settingRow(t('Version'), null, el('div.row', {}, versionLabel, buildLabel)),
          settingRow(t('License'), null, licenseLabel),
          settingRow(t('Data folder'), null, dataDirLabel)),
        settingsCard(null,
          settingRow(t('Updates'), t('Checks GitHub for a newer release. StepForge only connects when you press the button.'), checkUpdatesBtn),
          updateStatus),
        el('div.settings-actions', {},
          el('button', { type: 'button', onClick: openLink('https://github.com/Twest2/StepForge') }, t('Project on GitHub')),
          el('button', { type: 'button', onClick: openLink('https://github.com/Twest2/StepForge/releases') }, t('Release notes')),
          el('button', { type: 'button', onClick: openLink('https://github.com/Twest2/StepForge/issues') }, t('Report an issue'))),
      ] },
    ];
    const navButtons = new Map();
    const panes = new Map();
    const showSection = (id) => {
      for (const [key, button] of navButtons) {
        button.classList.toggle('active', key === id);
        button.setAttribute('aria-selected', String(key === id));
      }
      for (const [key, pane] of panes) pane.hidden = key !== id;
      content.scrollTop = 0;
    };
    const nav = el('nav.settings-nav', { role: 'tablist', 'aria-label': t('Settings sections') });
    const content = el('div.settings-content');
    for (const item of sections) {
      const button = el('button.settings-nav-item', { type: 'button', role: 'tab', onClick: () => {
        // Choosing Accounts always starts from the list of services.
        if (item.id === 'accounts') accountsPanel.show(null);
        showSection(item.id);
      } },
        item.label, item.badge ? betaBadge(item.badge) : null);
      navButtons.set(item.id, button);
      nav.append(button);
      const pane = el('section.settings-pane', { role: 'tabpanel', 'aria-label': item.label },
        item.id === 'about' ? null : el('header.settings-pane-head', {},
          el('h3', {}, item.label),
          item.description ? el('p.setting-desc', {}, item.description) : null),
        ...item.content);
      panes.set(item.id, pane);
      content.append(pane);
    }
    form.append(el('div.settings-layout', {}, nav, content));
    showSection(navButtons.has(initialSection) ? initialSection : 'general');

    const { close } = openModal({
      title: t('Settings'),
      body: form,
      wide: true,
      footer: [
        el('button', { type: 'button', onClick: () => { accountsPanel.dispose(); close(); resolve(false); } }, t('Cancel')),
        el('button.primary', {
          type: 'submit',
          onClick: async (e) => {
            e.preventDefault();
            const next = {
              appearance: appearance.value,
              language: language.value,
              spellcheck: spellcheck.checked,
              capture: {
                ...settings.capture,
                delayMs: Number(delayMs.value || 0),
                mode: captureMode.value,
                clickMarker: clickMarker.checked,
                smartCropping: smartCropping.checked,
                focusAmount: Number(focusAmount.value),
                fallbackTrigger: fallbackTrigger.value === 'interval' ? 'interval' : 'hotkey',
                autoIntervalSec: Math.max(1, Number(autoIntervalSec.value || 5)),
                hotkeyCapture: captureHotkey.value.trim(),
                hotkeyPauseResume: pauseHotkey.value.trim(),
                captureOutsideClicks: captureOutside.checked,
              },
              editor: {
                ...settings.editor,
                focusedViewDefaultForNewSteps: focusedDefault.checked,
              },
              branding: {
                ...settings.branding,
                activeProfileId: brandingPanel.value(),
              },
              exports: {
                ...settings.exports,
                previewStepCount: Number(previewCount.value || 3),
                openFolderAfterExport: openFolder.checked,
                codeTheme: codeTheme.value,
              },
              backups: {
                ...settings.backups,
                keepLast: Number(keepLast.value || 0),
              },
              library: {
                ...settings.library,
                trashDays: Number(trashDays.value),
                reviewAfterDays: Number(reviewDefault.value),
              },
              redaction: {
                ...settings.redaction,
                onCapture: redactOnCapture.checked,
                terms: [...new Set(redactTerms.value.split('\n').map((t) => t.trim()).filter(Boolean))].slice(0, 200),
              },
              ai: {
                ...settings.ai,
                enabled: aiEnabled.checked,
                autoDoc: aiAutoDoc.checked,
                attachScreenshots: aiScreenshots.checked,
                agents: {
                  ...(settings.ai?.agents || {}),
                  enabled: agentsEnabled.checked,
                  screenshots: agentsScreenshots.checked,
                  branding: agentsBranding.checked,
                },
                ollama: {
                  ...(settings.ai?.ollama || {}),
                  host: ollamaHost.value.trim(),
                  model: ollamaModel.value.trim(),
                },
              },
              placeholders: rows.reduce((acc, row) => {
                const key = row.querySelector('.global-placeholder-name').value.trim().replace(/^\[\[(.*?)\]\]$/, '$1').trim();
                const text = row.querySelector('.global-placeholder-value').value;
                if (key) acc[key] = typeof row.placeholderValue === 'string' && row.placeholderValue && text === row.placeholderOriginalText
                  ? row.placeholderValue : { format: 'markdown', text };
                return acc;
              }, {}),
            };
            if (await onSave(next) === false) return;
            accountsPanel.dispose();
            close();
            resolve(true);
          },
        }, t('Save')),
      ],
      onClose: () => { accountsPanel.dispose(); resolve(false); },
    });

    form.addEventListener('submit', (e) => e.preventDefault());
    testAiBtn.addEventListener('click', testAiConnection);
    aiEnabled.addEventListener('change', () => {
      updateAiStatus(
        aiEnabled.checked
          ? 'Save, then use the AI ▾ menu in a guide. Test connection checks that Ollama is ready.'
          : t('AI is off. These settings are kept for later.'),
      );
    });
  });
}

function showExportDialog({
  formats,
  templatesByFormat = {},
  defaultFormat = 'pdf',
  defaultOutDir = '',
  onChooseDir,
  onExport,
  onPreview,
  onLoadDefaults,      // async (format) => exporter DEFAULT_TEMPLATE
  onLoadTemplate,      // async (format, name) => saved options
  onSaveTemplate,      // async (format, name, options)
  onManageTemplates,   // async (format) => refreshed template name list
  onChooseImage,       // async () => picked image path or null
  webPublish = null,   // { ready, formats, expiryDays, defaultExpiryDays }: offer publishing HTML exports
  publishTargets = {}, // format -> site name, for formats the Share menu can publish directly
  onPublishInstead,    // (format) => called after the dialog closes to publish instead of exporting
  quality = [],        // findings from api.guide.quality, shown above the options
  onShowFinding,       // (finding) => jump to it; runs after the dialog closes
  branding = null,     // { profiles: [{ id, name }], activeId }: brand profile choice (Settings → Branding)
} = {}) {
  return new Promise((resolve) => {
    const formatOptions = (formats || []).map((f) => {
      if (typeof f === 'string') return { value: f, label: f };
      return {
        value: f.id || f.value || f.name,
        label: f.label || f.id || f.value || f.name,
        description: f.description || '',
        options: f.options || {},
        badge: f.badge || '',
      };
    });
    const formatInfo = (value) => formatOptions.find((f) => f.value === value) || {};
    // A list option can only hold text, so the badge goes in its label too.
    const formatSelect = makeSelect(defaultFormat, formatOptions.map((f) => ({ ...f, label: f.badge ? `${f.label} (${f.badge})` : f.label })));
    const formatDesc = el('div.muted.export-format-desc');
    const templateSelect = makeSelect('', [{ value: '', label: t('Default template') }]);
    const outDirInput = makeInput(defaultOutDir, 'text', { placeholder: t('Choose an output folder') });
    const optionsHost = el('div', { className: 'export-options' });
    // Branding: the active profile unless another (or none) is picked for this export.
    const brandProfiles = branding?.profiles || [];
    const brandChoice = makeSelect(brandProfiles.some((p) => p.id === branding?.activeId) ? branding.activeId : '',
      [{ value: '', label: t('No branding') }, ...brandProfiles.map((p) => ({ value: p.id, label: p.name }))]);
    brandChoice.setAttribute('aria-label', 'Branding');
    const brandNote = el('span.muted');
    const refreshBrandNote = () => {
      brandNote.textContent = formatSelect.value === 'json' ? t('JSON exports keep the raw data and aren’t branded.') : t('Change the default in Settings → Branding.');
    };

    // The effective option set shown to (and edited by) the user.
    let defaults = {};
    let current = {};

    const toColorValue = (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : '#000000');

    function optionControl(key, defVal, value, info) {
      const set = (v) => {
        current[key] = v;
        // Options that only apply when this one is set show or hide with it.
        if (Object.values(formatInfo(formatSelect.value).options || {}).some((o) => o.dependsOn === key)) renderOptions();
      };
      if (typeof defVal === 'boolean') {
        const input = el('input', { type: 'checkbox', checked: Boolean(value) });
        input.addEventListener('change', () => set(input.checked));
        return makeSwitch(input, info.label);
      }
      if (typeof defVal === 'number') {
        const scale = info.scale || 1;
        const input = makeInput(Math.round((value / scale) * 1000) / 1000, 'number', {
          step: info.step ?? 'any', min: info.min ?? '', max: info.max ?? '',
        });
        input.addEventListener('input', () => {
          if (input.value !== '') set(Math.round(Number(input.value) * scale * 1000) / 1000);
        });
        return info.unit ? el('div.row.export-number', {}, input, el('span.muted', {}, info.unit)) : input;
      }
      if (info.type === 'color') {
        const input = makeInput(toColorValue(value), 'color');
        input.addEventListener('input', () => set(input.value.toUpperCase()));
        return input;
      }
      if (info.type === 'textarea') {
        const input = el('textarea', { rows: 3, spellcheck: false, placeholder: info.placeholder || '' });
        input.value = value;
        input.addEventListener('input', () => set(input.value));
        return input;
      }
      if (info.type === 'file') {
        const input = makeInput(value, 'text', { readOnly: true, placeholder: t('None') });
        const clear = el('button', { type: 'button', disabled: !value,
          onClick: () => { input.value = ''; clear.disabled = true; set(''); } }, t('Clear'));
        const choose = el('button', { type: 'button', disabled: typeof onChooseImage !== 'function',
          onClick: async () => {
            const picked = await onChooseImage?.();
            if (picked) { input.value = picked; clear.disabled = false; set(picked); }
          } }, t('Choose…'));
        return el('div.row', {}, input, choose, clear);
      }
      const input = makeInput(value, 'text', { placeholder: info.placeholder || '' });
      input.addEventListener('input', () => set(input.value));
      return input;
    }

    function renderOptions() {
      clearNode(optionsHost);
      const meta = formatInfo(formatSelect.value).options || {};
      const entries = Object.entries(defaults)
        .filter(([key, v]) => ['boolean', 'number', 'string'].includes(typeof v) && !meta[key]?.hidden)
        .filter(([key]) => !meta[key]?.dependsOn || (current[meta[key].dependsOn] ?? defaults[meta[key].dependsOn]));
      if (!entries.length) {
        optionsHost.append(el('div.muted', {}, t('This format has no adjustable options.')));
        return;
      }
      for (const [key, defVal] of entries) {
        const info = meta[key] || {};
        const value = current[key] ?? defVal;
        const label = info.label || key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
        optionsHost.append(settingRow(label, info.hint || '', optionControl(key, defVal, value, { ...info, label })));
      }
    }

    async function refreshOptions() {
      defaults = (await onLoadDefaults?.(formatSelect.value, brandChoice.value)) || {};
      const saved = templateSelect.value
        ? (await onLoadTemplate?.(formatSelect.value, templateSelect.value)) || {}
        : {};
      current = { ...saved };
      renderOptions();
    }

    function refreshTemplates(list = templatesByFormat[formatSelect.value] || []) {
      clearNode(templateSelect);
      templateSelect.append(el('option', { value: '' }, t('Default template')));
      for (const name of list) templateSelect.append(el('option', { value: name }, name));
    }

    const refreshFormatDesc = () => {
      const info = formatInfo(formatSelect.value);
      formatDesc.replaceChildren(...(info.badge ? [betaBadge(info.badge), ' '] : []), info.description || '');
    };

    // Publish on the web: HTML exports can also go to the user's GitHub Pages
    // site (Settings → Accounts → GitHub), using the options chosen here.
    const publishInput = el('input', { type: 'checkbox', disabled: !webPublish?.ready });
    const publishDays = makeSelect(String(webPublish?.defaultExpiryDays || 7),
      (webPublish?.expiryDays || []).map((days) => ({ value: String(days), label: tn(days, '{count} day', '{count} days') })));
    const publishDaysRow = settingRow(t('Keep it online for'), t('The guide is removed from the web after this.'), publishDays);
    const publishWarning = el('p.gh-note', { role: 'note' },
      el('strong', {}, t('Published guides are public.')), ' ',
      t('Anyone with the link can open it, and anyone who looks at your GitHub repository can find it. Blur passwords and other private details before you export.'));
    const publishBox = el('fieldset.export-publish', {},
      el('legend', {}, t('Publish on the web')),
      settingRow(t('Publish on the web'),
        webPublish?.ready
          ? t('After exporting, also put this guide on your GitHub Pages site and get a link to share.')
          : t('Connect GitHub in Settings → Accounts → GitHub to publish guides on the web.'),
        makeSwitch(publishInput, t('Publish on the web'))),
      publishDaysRow,
      publishWarning);
    const publishing = () => Boolean(webPublish?.ready && publishInput.checked && (webPublish.formats || []).includes(formatSelect.value));
    function refreshPublish() {
      publishBox.hidden = !webPublish || !(webPublish.formats || []).includes(formatSelect.value);
      publishDaysRow.hidden = !publishing();
      publishWarning.hidden = !publishing();
      // Runs only after the footer buttons exist; leaves a busy button alone.
      if (!exportBtn.disabled) exportBtn.textContent = publishing() ? t('Export and publish') : t('Export');
    }
    publishInput.addEventListener('change', () => refreshPublish());

    // Confluence and Wiki.js: publishing makes the page for you, so point to
    // it. The export still works for people who upload by hand.
    const publishInsteadBtn = el('button', { type: 'button' });
    const publishInsteadNote = el('p.gh-note.export-publish-instead', { role: 'note' });
    function refreshPublishInstead() {
      const site = publishTargets[formatSelect.value];
      publishInsteadNote.hidden = !site || typeof onPublishInstead !== 'function';
      if (publishInsteadNote.hidden) return;
      publishInsteadBtn.textContent = t('Publish to {site}…', { site });
      publishInsteadNote.replaceChildren(
        el('span', {}, el('strong', {}, t('Publishing to {site} is easier.', { site })), ' ',
          t('Share → Publish to {site}… creates the page for you, uploads its screenshots and updates the same page when you publish again. Export only if you’d rather upload the files yourself.', { site })),
        publishInsteadBtn);
    }
    publishInsteadBtn.addEventListener('click', () => {
      const format = formatSelect.value;
      close();
      resolve(false);
      onPublishInstead(format);
    });

    formatSelect.addEventListener('change', () => { refreshFormatDesc(); refreshPublishInstead(); refreshTemplates(); refreshOptions(); refreshPublish(); refreshBrandNote(); });
    // The brand's colors are the options' defaults.
    brandChoice.addEventListener('change', () => refreshOptions());
    refreshBrandNote();
    refreshPublishInstead();
    refreshFormatDesc();
    templateSelect.addEventListener('change', () => refreshOptions());
    refreshTemplates();
    refreshOptions();

    const effectiveOptions = () => {
      // only keep values that differ from defaults, so templates stay minimal
      const out = {};
      for (const [k, v] of Object.entries(current)) {
        if (v !== undefined && v !== defaults[k]) out[k] = v;
      }
      return out;
    };

    const saveTplBtn = el('button', {
      type: 'button',
      onClick: async () => {
        const name = await promptText({ title: t('Save template'), label: t('Template name'), value: templateSelect.value || '' });
        if (!name || !name.trim()) return;
        await onSaveTemplate?.(formatSelect.value, name.trim(), effectiveOptions());
        const list = await onManageTemplates?.(formatSelect.value, null);
        refreshTemplates(list || []);
        templateSelect.value = name.trim();
      },
    }, t('Save as template…'));

    const manageBtn = el('button', {
      type: 'button',
      onClick: async () => {
        const list = await onManageTemplates?.(formatSelect.value, 'manage');
        refreshTemplates(list || []);
        refreshOptions();
      },
    }, t('Manage…'));

    const body = el('div.export-dialog', {},
      qualityPanel(quality, (finding) => { close(); resolve(false); onShowFinding?.(finding); }),
      labeledRow(t('Format'), el('div.export-format', {}, formatSelect, formatDesc, publishInsteadNote)),
      labeledRow(t('Template'), el('div.row', {}, templateSelect, saveTplBtn, manageBtn)),
      branding ? labeledRow(t('Branding'), el('div.row', {}, brandChoice, brandNote)) : null,
      labeledRow(t('Output folder'), el('div.row', {}, outDirInput, el('button', {
        type: 'button',
        disabled: typeof onChooseDir !== 'function',
        onClick: async () => {
          if (typeof onChooseDir !== 'function') return;
          const chosen = await onChooseDir(formatSelect.value);
          if (chosen) outDirInput.value = chosen;
        },
      }, t('Choose…')))),
      el('fieldset', {}, el('legend', {}, t('Options')), optionsHost),
      publishBox,
    );

    const payload = () => ({
      format: formatSelect.value,
      templateName: templateSelect.value || null,
      options: effectiveOptions(),
      outDir: outDirInput.value.trim() || null,
      publish: publishing() ? { days: Number(publishDays.value) } : null,
      brandProfileId: branding ? brandChoice.value : undefined,
    });

    const cancelBtn = el('button', { onClick: () => { close(); resolve(false); } }, t('Cancel'));
    const previewBtn = el('button', {
      onClick: async () => {
        if (typeof onPreview !== 'function') return;
        setButtonLoading(previewBtn, true, t('Preview…'));
        try {
          await onPreview(payload()); // keep dialog open so settings can be tweaked
        } finally {
          setButtonLoading(previewBtn, false);
        }
      },
    }, t('Preview'));
    const exportBtn = el('button.primary', {
      onClick: async () => {
        if (typeof onExport !== 'function') return;
        cancelBtn.disabled = true;
        previewBtn.disabled = true;
        setButtonLoading(exportBtn, true, t('Exporting…'));
        try {
          const ok = await onExport(payload());
          if (ok !== false) {
            close();
            resolve(true);
            return;
          }
        } finally {
          cancelBtn.disabled = false;
          previewBtn.disabled = false;
          setButtonLoading(exportBtn, false);
          refreshPublish();
        }
      },
    }, t('Export'));
    refreshPublish();

    const { close } = openModal({
      title: t('Export'),
      body,
      footer: [cancelBtn, previewBtn, exportBtn],
      wide: true,
      onClose: () => resolve(false),
    });
  });
}

/** Template management list: rename / duplicate / delete / import / export. */
function showTemplateManager({ format, names = [], onRename, onDuplicate, onDelete, onImport, onExport }) {
  return new Promise((resolve) => {
    let list = [...names];
    const rows = el('div', { className: 'card-list' });

    function renderRows() {
      clearNode(rows);
      if (!list.length) {
        rows.append(el('div.muted', {}, t('No templates saved for this format yet.')));
        return;
      }
      for (const name of list) {
        rows.append(el('div.row', { style: { justifyContent: 'space-between', gap: '8px' } },
          el('span', {}, name),
          el('div.row', {},
            el('button', {
              type: 'button',
              onClick: async () => {
                const next = await promptText({ title: t('Rename template'), label: t('Name'), value: name });
                if (next && next.trim() && next.trim() !== name) {
                  list = await onRename(name, next.trim());
                  renderRows();
                }
              },
            }, t('Rename')),
            el('button', { type: 'button', onClick: async () => { list = await onDuplicate(name); renderRows(); } }, t('Duplicate')),
            el('button', { type: 'button', onClick: async () => { await onExport(name); } }, t('Share…')),
            el('button.danger', { type: 'button', onClick: async () => { list = await onDelete(name); renderRows(); } }, t('Delete')),
          ),
        ));
      }
    }

    const { close } = openModal({
      title: `Templates — ${format}`,
      body: el('div', {},
        el('div.row', { style: { marginBottom: '10px' } },
          el('button', { type: 'button', onClick: async () => { list = await onImport(); renderRows(); } }, t('Import .sfglt…')),
          el('span.muted', {}, t('Templates are shareable as .sfglt files.')),
        ),
        rows,
      ),
      footer: [el('button.primary', { onClick: () => { close(); resolve(list); } }, t('Done'))],
      wide: true,
      onClose: () => resolve(list),
    });
    renderRows();
  });
}

function showLinkedGuideDialog({ guide, lock, onSave, onForceSave, onOpenArchive } = {}) {
  return new Promise((resolve) => {
    const linked = guide.linkedSource || {};
    const conflict = lock && !lock.acquired;
    const conflictInfo = lock && lock.conflict ? lock.conflict : {};
    const lockInfo = conflict
      ? t('Locked by {user}@{host}', { user: conflictInfo.user || t('another user'), host: conflictInfo.host || t('another host') })
      : t('No active conflict');

    const body = el('div', { className: 'linked-guide' },
      el('div', { className: 'card-list' },
        el('div.row', {}, el('span.muted', {}, t('Archive')), el('strong', {}, linked.path || t('Not linked'))),
        el('div.row', {}, el('span.muted', {}, t('Opened')), el('span', {}, fmtDate(linked.openedAt) || t('Unknown'))),
        el('div.row', {}, el('span.muted', {}, t('Last saved')), el('span', {}, fmtDate(linked.lastSavedAt) || t('Never'))),
        el('div.row', {}, el('span.muted', {}, t('Lock')), el('span', {}, lockInfo)),
      ),
      conflict ? el('div', { className: 'warn-banner' }, t('Another editor has the archive locked. You can force-save if you intend to overwrite it.')) : null,
    );

    const { close } = openModal({
      title: t('Linked Guide'),
      body,
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, t('Close')),
        el('button', {
          onClick: async () => {
            await onOpenArchive?.(guide);
          },
        }, t('Show file')),
        conflict ? el('button.primary', {
          onClick: async () => {
            await onForceSave?.(guide);
            close();
            resolve(true);
          },
        }, t('Force save')) : el('button.primary', {
          onClick: async () => {
            await onSave?.(guide);
            close();
            resolve(true);
          },
        }, t('Save now')),
      ],
      wide: true,
      onClose: () => resolve(false),
    });
  });
}

/** "Sep 22, 2026, 3:35 AM · auto" from a snapshot file name. */
function snapshotLabel(name) {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-(.+?))?\.(?:zip|snapshot)$/);
  if (!match) return name;
  const [, day, h, m, sec, ms, label] = match;
  const when = new Date(`${day}T${h}:${m}:${sec}.${ms}Z`).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' });
  return label ? `${when} · ${label.replace(/_/g, ' ')}` : when;
}

function showBackupsDialog({ snapshots = [], onCreate, onRestore, onCompare } = {}) {
  return new Promise((resolve) => {
    let list = [...snapshots];
    const rows = el('div', { className: 'card-list' });

    function renderRows() {
      clearNode(rows);
      if (!list.length) {
        rows.append(el('div.muted', {}, t('No snapshots yet. Automatic snapshots are created as you work; create one manually any time.')));
        return;
      }
      for (const name of list) {
        const compareBtn = onCompare ? el('button', {
          type: 'button',
          title: t('See what changed between this snapshot and the guide now'),
          onClick: async () => {
            setButtonLoading(compareBtn, true, t('Comparing…'));
            let restored = false;
            try {
              restored = await onCompare(name);
            } finally {
              if (compareBtn.isConnected) setButtonLoading(compareBtn, false);
            }
            if (restored) { close(); resolve(true); }
          },
        }, t('Compare')) : null;
        rows.append(el('div.row', { style: { justifyContent: 'space-between', gap: '10px' } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: '1' }, title: name }, snapshotLabel(name)),
          compareBtn,
          el('button', {
            type: 'button',
            onClick: async () => {
              const restored = await onRestore?.(name);
              if (restored) close();
            },
          }, t('Restore')),
        ));
      }
    }

    const createBtn = el('button.primary', {
      type: 'button',
      onClick: async () => {
        const refreshed = await onCreate?.();
        if (Array.isArray(refreshed)) {
          list = refreshed;
          renderRows();
        }
      },
    }, t('Create snapshot'));

    const { close } = openModal({
      title: t('Backups & snapshots'),
      body: el('div', {},
        el('div.row', { style: { marginBottom: '10px' } }, createBtn,
          el('span.muted', {}, t('Compare shows what changed since a snapshot. Restores are undoable — the current state is snapshotted first.'))),
        rows,
      ),
      footer: [el('button', { onClick: () => { close(); resolve(true); } }, t('Close'))],
      wide: true,
      onClose: () => resolve(true),
    });
    renderRows();
  });
}

function showPlaceholdersDialog({ title = 'Placeholders', hint = '', values = {}, onSave } = {}) {
  return new Promise((resolve) => {
    const rowsHost = el('div', { className: 'placeholder-rows' });
    const rows = [];
    const addRow = (key = '', value = '') => {
      const keyInput = makeInput(key, 'text', { placeholder: t('Name') });
      const valueInput = makeInput(value, 'text', { placeholder: t('Value') });
      const row = el('div.placeholder-row', {}, keyInput, valueInput,
        el('button.icon', {
          type: 'button', title: t('Remove'),
          onClick: () => { row.remove(); rows.splice(rows.indexOf(row), 1); },
        }, '−'));
      rows.push(row);
      rowsHost.append(row);
    };
    Object.entries(values || {}).forEach(([k, v]) => addRow(k, v));
    if (!Object.keys(values || {}).length) addRow();

    const { close } = openModal({
      title,
      body: el('div', {},
        hint ? el('div.muted', { style: { marginBottom: '10px' } }, hint) : null,
        rowsHost,
        el('div.row', { style: { marginTop: '8px' } },
          el('button', { type: 'button', onClick: () => addRow() }, t('Add placeholder'))),
      ),
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, t('Cancel')),
        el('button.primary', {
          onClick: async () => {
            const next = rows.reduce((acc, row) => {
              const inputs = row.querySelectorAll('input');
              const key = inputs[0].value.trim();
              if (key) acc[key] = inputs[1].value;
              return acc;
            }, {});
            await onSave?.(next);
            close();
            resolve(true);
          },
        }, t('Save')),
      ],
      onClose: () => resolve(false),
    });
  });
}

/**
 * Optional document metadata (author, co-authors, organization, description)
 * shown at the top of the guide, below the title, and surfaced on the PDF
 * cover page and the top of other export formats.
 */
function showGuideInfoDialog({ values = {}, reviewDefaultDays, onSave, onCloudSnapshots, onDeleteCloudSnapshots } = {}) {
  return new Promise((resolve) => {
    const versionInput = makeInput(values.softwareVersion || '', 'text', { placeholder: t('e.g. Windows 11 24H2'), maxLength: 200 });
    const verifiedInput = makeInput(review.normalizeDateOnly(values.lastVerified), 'date', { max: review.toDateOnly(Date.now()) });
    const reviewDays = review.normalizeReviewDays(values.reviewAfterDays);
    const defaultDays = review.normalizeReviewDays(reviewDefaultDays) ?? review.DEFAULT_REVIEW_DAYS;
    const reviewSelect = makeSelect(reviewDays === null ? '' : String(reviewDays), [
      { value: '', label: defaultDays > 0 ? t('Use the default ({interval})', { interval: intervalText(defaultDays) }) : t('Use the default (off)') },
      ...review.REVIEW_INTERVALS.map((i) => ({ value: String(i.days), label: t('After {interval}', { interval: intervalText(i.days) }) })),
      // A custom interval set elsewhere (an agent, an older import) stays selectable.
      ...(reviewDays > 0 && !review.REVIEW_INTERVALS.some((i) => i.days === reviewDays)
        ? [{ value: String(reviewDays), label: t('After {interval}', { interval: intervalText(reviewDays) }) }] : []),
      { value: '0', label: t('Never') },
    ]);
    const reviewHint = el('div.muted', { style: { marginTop: '-4px', marginBottom: '12px' } });
    const readReviewDays = () => (reviewSelect.value === '' ? null : Number(reviewSelect.value));
    // Saving restarts the clock, so the preview counts from now.
    const updateReviewHint = () => {
      const status = review.reviewStatus({
        updatedAt: new Date().toISOString(),
        metadata: { lastVerified: verifiedInput.value, reviewAfterDays: readReviewDays() },
      }, defaultDays);
      reviewHint.textContent = status
        ? t('After you save, “May need review” shows in the library on {date} unless the guide is saved or verified again first.',
          { date: new Date(status.due).toLocaleDateString(dateLocale, { dateStyle: 'medium' }) })
        : t('This guide is never flagged for review.');
    };
    const todayBtn = el('button', {
      type: 'button',
      onClick: () => { verifiedInput.value = review.toDateOnly(Date.now()); updateReviewHint(); },
    }, t('Today'));
    verifiedInput.addEventListener('input', updateReviewHint);
    reviewSelect.addEventListener('change', updateReviewHint);
    updateReviewHint();
    const authorInput = makeInput(values.author || '', 'text', { placeholder: t('e.g. Jane Doe') });
    const coAuthorsInput = makeInput(values.coAuthors || '', 'text', { placeholder: t('e.g. Alex Lee, Sam Patel') });
    const organizationInput = makeInput(values.organization || '', 'text', { placeholder: t('e.g. Acme Corp') });
    const descriptionInput = el('textarea', {
      rows: 4,
      placeholder: t('A short summary of this guide.'),
    }, values.description || '');
    const shareInput = el('input', { type: 'checkbox', checked: values.sharingEnabled !== false });

    const { close } = openModal({
      title: t('Guide information'),
      body: el('div', {},
        el('div.muted', { style: { marginBottom: '10px' } },
          t('All fields are optional. They appear below the title on the guide and on the PDF cover page.')),
        labeledRow(t('Author'), authorInput),
        labeledRow(t('Co-authors'), coAuthorsInput),
        labeledRow(t('Organization'), organizationInput),
        labeledRow(t('Description'), descriptionInput, { stacked: true }),
        el('div.muted', { style: { marginTop: '-4px' } },
          t('Shown on the first page of the PDF and at the top of other export formats.')),
        el('h3', { style: { margin: '14px 0 6px' } }, t('Review')),
        labeledRow(t('Software version'), versionInput),
        labeledRow(t('Last verified'), el('div.row', {}, verifiedInput, todayBtn)),
        labeledRow(t('Review again'), reviewSelect),
        reviewHint,
        el('label.cloud-enable', {}, shareInput, ' ', t('Include this guide in cloud sync')),
        el('div.muted', { style: { marginTop: '-4px' } },
          t('When off, this guide stays only on this device.')),
      ),
      footer: [
        el('button', { type: 'button', onClick: () => onCloudSnapshots?.() }, t('Cloud snapshots')),
        el('button', { type: 'button', className: 'danger', onClick: () => onDeleteCloudSnapshots?.() }, t('Remove cloud copies')),
        el('button', { onClick: () => { close(); resolve(false); } }, t('Cancel')),
        el('button.primary', {
          onClick: async () => {
            await onSave?.({
              author: authorInput.value.trim(),
              coAuthors: coAuthorsInput.value.trim(),
              organization: organizationInput.value.trim(),
              softwareVersion: versionInput.value.trim(),
              lastVerified: review.normalizeDateOnly(verifiedInput.value),
              reviewAfterDays: readReviewDays(),
              description: descriptionInput.value.trim(),
              sharingEnabled: shareInput.checked,
            });
            close();
            resolve(true);
          },
        }, t('Save')),
      ],
      onClose: () => resolve(false),
    });
  });
}

function showCloudSnapshotsDialog({ snapshots = [], onRestore } = {}) {
  return new Promise((resolve) => {
    const list = snapshots.length
      ? el('div', {}, ...snapshots.map((snapshot, index) => el('div.form-row', {},
        el('div', {}, index === 0 ? t('Current cloud snapshot') : t('Previous snapshot {number}', { number: index }), snapshot.createdTime ? el('div.muted', {}, new Date(snapshot.createdTime).toLocaleString(dateLocale)) : null),
        index === 0 ? el('span.muted', {}, t('Current')) : el('button', { type: 'button', onClick: async () => { await onRestore?.(snapshot); close(); resolve(true); } }, t('Restore')),
      )))
      : el('div.muted', {}, t('No cloud snapshots are available for this guide.'));
    const { close } = openModal({
      title: t('Cloud snapshots'), body: el('div', {},
        el('div.muted', { style: { marginBottom: '10px' } }, t('The current snapshot and up to two previous snapshots are retained.')), list),
      footer: [el('button.primary', { onClick: () => { close(); resolve(false); } }, t('Close'))],
      onClose: () => resolve(false),
    });
  });
}

const SHORTCUTS = [
  [t('Capture & steps'), [
    ['Ctrl+S', t('Save (writes linked archive when guide is linked)')],
    ['Ctrl+/', t('Quick actions palette')],
    ['Ctrl+H', t('Find and replace across the guide')],
    ['PageUp / PageDown', t('Previous / next step')],
    ['Alt+↑ / Alt+↓', t('Move step (and its substeps) up / down')],
    ['Ctrl+Delete', t('Delete current step')],
    ['Ctrl+Z / Ctrl+Shift+Z', t('Undo / redo (including step moves, deleting steps and AI writes)')],
    ['Ctrl+V', t('Paste annotation, or clipboard image as new step')],
  ]],
  [t('Canvas tools'), [
    ['S R O L A T', t('Select · Rectangle · Oval · Line · Arrow · Text')],
    ['G N B H M U C', t('Tooltip · Number · Blur · Highlight · Magnify · Cursor · Crop')],
    ['Ctrl+C', t('Copy selected annotation (in step-select mode, paste it onto many steps)')],
    ['Delete', t('Delete selected annotation')],
    ['Esc', t('Deselect annotation')],
    ['Arrows / Shift+Arrows', t('Nudge selection by 1 px / 10 px')],
  ]],
  [t('View'), [
    ['Ctrl+= / Ctrl+-', t('Zoom in / out')],
    ['Ctrl+0', t('Fit image to window')],
  ]],
  [t('Compare with a snapshot'), [
    ['N / Alt+↓', t('Next change')],
    ['P / Alt+↑', t('Previous change')],
    ['V', t('Mark the current change as viewed and go to the next one')],
    ['Esc', t('Close the comparison')],
  ]],
];

function showShortcutsDialog() {
  return new Promise((resolve) => {
    const sections = SHORTCUTS.map(([heading, items]) => el('div', {},
      el('h3', { style: { margin: '8px 0 6px' } }, heading),
      el('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        ...items.map(([keys, what]) => el('tr', {},
          el('td', { style: { padding: '3px 14px 3px 0', whiteSpace: 'nowrap' } }, el('kbd', {}, keys)),
          el('td', { style: { padding: '3px 0' } }, what),
        )),
      ),
    ));
    const { close } = openModal({
      title: t('Keyboard shortcuts'),
      body: el('div', {}, ...sections),
      footer: [el('button.primary', { onClick: () => { close(); resolve(true); } }, t('Close'))],
      onClose: () => resolve(true),
    });
  });
}

function showInfoDialog(title, bodyText) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title,
      body: el('div', {}, bodyText),
      footer: [el('button.primary', { onClick: () => { close(); resolve(true); } }, t('OK'))],
      onClose: () => resolve(false),
    });
  });
}

function showRecordingReminder({
  actionLabel = t('Continue'),
  headline = t('StepForge will hide after you continue.'),
} = {}) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title: t('Before recording starts'),
      body: el('div.recording-notice', {},
        el('div.recording-notice__badge', {}, t('Recording tip')),
        el('div.recording-notice__title', {}, headline),
        el('div.recording-notice__text', {},
          document.body.classList.contains('platform-linux')
            ? t('To stop, use StepForge REC in the GNOME top panel, or restore StepForge from the dock.')
            : t('When you want to pause or stop, use the red tray icon in the system tray.'),
        ),
      ),
      footer: [
        el('button.primary', {
          onClick: () => { close(); resolve(true); },
        }, actionLabel),
      ],
      onClose: () => resolve(false),
    });
  });
}

window.StepForgeDialogs = {
  snapshotLabel,
  promptText,
  showMoveStepDialog,
  showQuickActions,
  showFindReplace,
  showSettingsDialog,
  makeUpdateCheck,
  storageWarning,
  showExportDialog,
  showLinkedGuideDialog,
  showInfoDialog,
  showBackupsDialog,
  showPlaceholdersDialog,
  showGuideInfoDialog,
  showCloudSnapshotsDialog,
  showShortcutsDialog,
  showTemplateManager,
  showRecordingReminder,
};
})();
