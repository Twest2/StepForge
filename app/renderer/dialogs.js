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
    title: 'Clear shortcut',
    onClick: (e) => {
      e.stopPropagation();
      current = '';
      render();
    },
  }, '×');

  const wrap = el('div.hotkey-input', { tabindex: '0', role: 'button', title: 'Click, then press a key combination' },
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
      keys.replaceChildren(el('span.hotkey-placeholder', {}, 'Press a key combination…'));
      clearBtn.hidden = true;
      return;
    }
    if (!current) {
      keys.replaceChildren(el('span.hotkey-placeholder', {}, 'Click to set shortcut'));
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

async function promptText({ title, label = 'Value', value = '', placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    const field = multiline
      ? el('textarea', { rows: 6, placeholder }, value)
      : el('input', { type: 'text', value, placeholder });

    const { close } = openModal({
      title,
      body: labeledRow(label, field, { stacked: multiline }),
      footer: [
        el('button', { onClick: () => { close(); resolve(null); } }, 'Cancel'),
        el('button.primary', { onClick: () => { close(); resolve(field.value); } }, 'OK'),
      ],
      onClose: () => resolve(null),
    });

    field.addEventListener('keydown', (e) => {
      if (!multiline && e.key === 'Enter') {
        e.preventDefault();
        close();
        resolve(field.value);
      }
    });

    setTimeout(() => field.focus(), 0);
  });
}

function showQuickActions({ query = '', commands = [], searchFn, onOpenItem, onClose } = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      type: 'search',
      value: query,
      placeholder: 'Search guides, steps, and commands',
      autocomplete: 'off',
      spellcheck: false,
    });
    const results = el('div.qa-results');
    const hint = el('div.muted', {}, 'Type to search, arrows to move, Enter to open.');
    let items = [];
    let active = 0;

    function renderItems() {
      clearNode(results);
      if (!items.length) {
        results.append(el('div.muted', { style: { padding: '8px 2px' } }, 'No matches.'));
        return;
      }
      items.forEach((item, idx) => {
        results.append(el('div.qa-item', {
          className: `qa-item${idx === active ? ' active' : ''}`,
          onMouseenter: () => { active = idx; renderItems(); },
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
      title: 'Quick Actions',
      body: el('div.quick-actions', {},
        input,
        hint,
        results,
      ),
      wide: true,
      footer: [
        el('button', { onClick: () => { close(); resolve(null); } }, 'Close'),
      ],
      onClose: () => {
        if (onClose) onClose();
        resolve(null);
      },
    });

    const debounced = debounce(refresh, 60);
    input.addEventListener('input', debounced);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderItems(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderItems(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); resolve(null); }
    });

    refresh();
    setTimeout(() => input.focus(), 0);
  });
}

function showSettingsDialog({
  api,
  settings,
  placeholders = {},
  onSave,
} = {}) {
  return new Promise((resolve) => {
    const form = el('form', { className: 'settings-form' });

    const appearance = makeSelect(settings.appearance || 'system', [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ]);
    const spellcheck = el('input', { type: 'checkbox', checked: Boolean(settings.spellcheck) });
    const delayMs = makeInput(settings.capture?.delayMs ?? 0, 'number', { min: 0, step: 50 });
    const captureMode = makeSelect(settings.capture?.mode || 'fullscreen', [
      { value: 'fullscreen', label: 'Fullscreen' },
      { value: 'window', label: 'Window' },
      { value: 'region', label: 'Region' },
    ]);
    const clickMarker = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.clickMarker) });
    const captureHotkey = makeHotkeyInput(settings.capture?.hotkeyCapture || '');
    const pauseHotkey = makeHotkeyInput(settings.capture?.hotkeyPauseResume || '');
    const focusedDefault = el('input', { type: 'checkbox', checked: Boolean(settings.editor?.focusedViewDefaultForNewSteps) });
    const previewCount = makeInput(settings.exports?.previewStepCount ?? 3, 'number', { min: 1, step: 1 });
    const openFolder = el('input', { type: 'checkbox', checked: Boolean(settings.exports?.openFolderAfterExport) });
    const captureOutside = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.captureOutsideClicks) });
    const confirmSimple = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.confirmSimpleCapture) });
    const keepLast = makeInput(settings.backups?.keepLast ?? 10, 'number', { min: 0, step: 1 });
    const aiEnabled = el('input', { type: 'checkbox', checked: Boolean(settings.ai?.enabled) });
    const aiAutoDoc = el('input', { type: 'checkbox', checked: Boolean(settings.ai?.autoDoc) });
    const ollamaHost = makeInput(settings.ai?.ollama?.host || 'http://127.0.0.1:11434');
    const ollamaModel = makeInput(settings.ai?.ollama?.model || 'llama3.2:1b');
    const aiStatus = el('div', { className: 'muted ai-status' }, 'AI stays local through Ollama. Vision-capable models can also inspect the screenshot attached to each step.');
    const testAiBtn = el('button', { type: 'button' }, 'Test connection');
    const persistOllamaModel = debounce(() => {
      const model = ollamaModel.value.trim();
      // Keep the last model choice even if the dialog is dismissed without a full save.
      void api.settings.set({ keyPath: 'ai.ollama.model', value: model }).catch(() => {});
    }, 250);

    const updateAiStatus = (message, { error = false } = {}) => {
      aiStatus.textContent = message;
      aiStatus.classList.toggle('error', Boolean(error));
    };

    const testAiConnection = async () => {
      setButtonLoading(testAiBtn, true, 'Testing…');
      updateAiStatus('Checking Ollama at the configured host…');
      try {
        const result = await api.ai.test({
          ollama: {
            host: ollamaHost.value.trim(),
            model: ollamaModel.value.trim(),
          },
        });
        if (!result.ok) {
          updateAiStatus(result.reason || 'Could not connect to Ollama.', { error: true });
          return;
        }
        if (result.installed) {
          updateAiStatus(result.vision
            ? `Connected to ${result.host} with ${result.model}. It can inspect screenshots.`
            : `Connected to ${result.host} with ${result.model}. This model is text-only, so StepForge will use OCR and metadata only.`);
        } else {
          updateAiStatus(`Connected to ${result.host}. Model ${result.model} is not installed yet.`, { error: true });
        }
      } catch (err) {
        updateAiStatus(err.message || 'Could not connect to Ollama.', { error: true });
      } finally {
        setButtonLoading(testAiBtn, false);
      }
    };
    ollamaModel.addEventListener('input', () => persistOllamaModel());
    ollamaModel.addEventListener('blur', () => persistOllamaModel.flush());

    const placeholderRows = el('div', { className: 'placeholder-rows' });
    const rows = [];
    const addPlaceholderRow = (key = '', value = '') => {
      const keyInput = makeInput(key);
      const valueInput = makeInput(value);
      const removeBtn = el('button.icon', {
        type: 'button',
        title: 'Remove placeholder',
        onClick: () => {
          row.remove();
          rows.splice(rows.indexOf(row), 1);
        },
      }, '−');
      const row = el('div.placeholder-row', {},
        keyInput,
        valueInput,
        removeBtn,
      );
      rows.push(row);
      placeholderRows.append(row);
      return row;
    };
    Object.entries(placeholders || {}).forEach(([k, v]) => addPlaceholderRow(k, v));

    const addPlaceholderBtn = el('button', {
      type: 'button',
      onClick: () => addPlaceholderRow(),
    }, 'Add placeholder');

    form.append(
      el('fieldset', {},
        el('legend', {}, 'Appearance'),
        labeledRow('Theme', appearance),
        labeledRow('Spellcheck', spellcheck),
        labeledRow('Open folder after export', openFolder),
      ),
      el('fieldset', {},
        el('legend', {}, 'Capture'),
        labeledRow('Default mode', captureMode),
        labeledRow('Delay (ms)', delayMs),
        labeledRow('Click marker', clickMarker),
        labeledRow('Capture outside clicks', captureOutside),
        labeledRow('Confirm simple capture', confirmSimple),
        labeledRow('Capture hotkey', captureHotkey),
        labeledRow('Pause / resume hotkey', pauseHotkey),
      ),
      el('fieldset', {},
        el('legend', {}, 'Editor'),
        labeledRow('Focused view for new steps', focusedDefault),
        labeledRow('Preview step count', previewCount),
      ),
      el('fieldset', {},
        el('legend', {}, 'Backups'),
        labeledRow('Keep last snapshots', keepLast),
      ),
      el('fieldset', {},
        el('legend', {}, 'AI'),
        labeledRow('Enable AI (experimental)', aiEnabled),
        labeledRow('Auto-document captures', aiAutoDoc),
        labeledRow('Ollama host', ollamaHost),
        labeledRow('Ollama model', ollamaModel),
        el('div.row', { style: { justifyContent: 'space-between' } },
          aiStatus,
          testAiBtn,
        ),
        el('div.muted', {},
          'When auto-document is on, each capture is automatically documented by AI. Turn it off to use AI manually only.',
        ),
      ),
      el('fieldset', {},
        el('legend', {}, 'Global placeholders'),
        placeholderRows,
        el('div.row', { style: { justifyContent: 'flex-start' } }, addPlaceholderBtn),
      ),
    );

    const { close } = openModal({
      title: 'Settings',
      body: form,
      wide: true,
      footer: [
        el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, 'Cancel'),
        el('button.primary', {
          type: 'submit',
          onClick: async (e) => {
            e.preventDefault();
            const next = {
              appearance: appearance.value,
              spellcheck: spellcheck.checked,
              capture: {
                ...settings.capture,
                delayMs: Number(delayMs.value || 0),
                mode: captureMode.value,
                clickMarker: clickMarker.checked,
                hotkeyCapture: captureHotkey.value.trim(),
                hotkeyPauseResume: pauseHotkey.value.trim(),
                captureOutsideClicks: captureOutside.checked,
                confirmSimpleCapture: confirmSimple.checked,
              },
              editor: {
                ...settings.editor,
                focusedViewDefaultForNewSteps: focusedDefault.checked,
              },
              exports: {
                ...settings.exports,
                previewStepCount: Number(previewCount.value || 3),
                openFolderAfterExport: openFolder.checked,
              },
              backups: {
                ...settings.backups,
                keepLast: Number(keepLast.value || 0),
              },
              ai: {
                ...settings.ai,
                enabled: aiEnabled.checked,
                autoDoc: aiAutoDoc.checked,
                ollama: {
                  ...(settings.ai?.ollama || {}),
                  host: ollamaHost.value.trim(),
                  model: ollamaModel.value.trim(),
                },
              },
              placeholders: rows.reduce((acc, row) => {
                const inputs = row.querySelectorAll('input');
                const key = inputs[0].value.trim();
                const value = inputs[1].value;
                if (key) acc[key] = value;
                return acc;
              }, {}),
            };
            await onSave(next);
            close();
            resolve(true);
          },
        }, 'Save'),
      ],
      onClose: () => resolve(false),
    });

    form.addEventListener('submit', (e) => e.preventDefault());
    testAiBtn.addEventListener('click', testAiConnection);
    aiEnabled.addEventListener('change', () => {
      updateAiStatus(
        aiEnabled.checked
          ? 'AI generation will be available once Ollama is reachable.'
          : 'AI generation is disabled. The settings are still saved for later.',
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
} = {}) {
  return new Promise((resolve) => {
    const formatOptions = (formats || []).map((f) => {
      if (typeof f === 'string') return { value: f, label: f };
      return { value: f.id || f.value || f.name, label: f.label || f.id || f.value || f.name };
    });
    const formatSelect = makeSelect(defaultFormat, formatOptions);
    const templateSelect = makeSelect('', [{ value: '', label: 'Default template' }]);
    const outDirInput = makeInput(defaultOutDir, 'text', { placeholder: 'Choose an output folder' });
    const optionsHost = el('div', { className: 'export-options' });

    // The effective option set shown to (and edited by) the user.
    let defaults = {};
    let current = {};

    function renderOptions() {
      clearNode(optionsHost);
      const entries = Object.entries(defaults)
        .filter(([, v]) => ['boolean', 'number', 'string'].includes(typeof v));
      if (!entries.length) {
        optionsHost.append(el('div.muted', {}, 'This format has no adjustable options.'));
        return;
      }
      for (const [key, defVal] of entries) {
        const value = current[key] ?? defVal;
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
        let control;
        if (typeof defVal === 'boolean') {
          control = el('input', { type: 'checkbox', checked: Boolean(value) });
          control.addEventListener('change', () => { current[key] = control.checked; });
        } else if (typeof defVal === 'number') {
          control = makeInput(value, 'number', { step: 'any' });
          control.addEventListener('input', () => { current[key] = Number(control.value); });
        } else {
          control = makeInput(value, 'text');
          control.addEventListener('input', () => { current[key] = control.value; });
        }
        optionsHost.append(labeledRow(label, control));
      }
    }

    async function refreshOptions() {
      defaults = (await onLoadDefaults?.(formatSelect.value)) || {};
      const saved = templateSelect.value
        ? (await onLoadTemplate?.(formatSelect.value, templateSelect.value)) || {}
        : {};
      current = { ...saved };
      renderOptions();
    }

    function refreshTemplates(list = templatesByFormat[formatSelect.value] || []) {
      clearNode(templateSelect);
      templateSelect.append(el('option', { value: '' }, 'Default template'));
      for (const name of list) templateSelect.append(el('option', { value: name }, name));
    }

    formatSelect.addEventListener('change', () => { refreshTemplates(); refreshOptions(); });
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
        const name = await promptText({ title: 'Save template', label: 'Template name', value: templateSelect.value || '' });
        if (!name || !name.trim()) return;
        await onSaveTemplate?.(formatSelect.value, name.trim(), effectiveOptions());
        const list = await onManageTemplates?.(formatSelect.value, null);
        refreshTemplates(list || []);
        templateSelect.value = name.trim();
      },
    }, 'Save as template…');

    const manageBtn = el('button', {
      type: 'button',
      onClick: async () => {
        const list = await onManageTemplates?.(formatSelect.value, 'manage');
        refreshTemplates(list || []);
        refreshOptions();
      },
    }, 'Manage…');

    const body = el('div.export-dialog', {},
      labeledRow('Format', formatSelect),
      labeledRow('Template', el('div.row', {}, templateSelect, saveTplBtn, manageBtn)),
      labeledRow('Output folder', el('div.row', {}, outDirInput, el('button', {
        type: 'button',
        disabled: typeof onChooseDir !== 'function',
        onClick: async () => {
          if (typeof onChooseDir !== 'function') return;
          const chosen = await onChooseDir(formatSelect.value);
          if (chosen) outDirInput.value = chosen;
        },
      }, 'Choose…'))),
      el('fieldset', {}, el('legend', {}, 'Options'), optionsHost),
    );

    const payload = () => ({
      format: formatSelect.value,
      templateName: templateSelect.value || null,
      options: effectiveOptions(),
      outDir: outDirInput.value.trim() || null,
    });

    const cancelBtn = el('button', { onClick: () => { close(); resolve(false); } }, 'Cancel');
    const previewBtn = el('button', {
      onClick: async () => {
        if (typeof onPreview !== 'function') return;
        setButtonLoading(previewBtn, true, 'Preview…');
        try {
          await onPreview(payload()); // keep dialog open so settings can be tweaked
        } finally {
          setButtonLoading(previewBtn, false);
        }
      },
    }, 'Preview');
    const exportBtn = el('button.primary', {
      onClick: async () => {
        if (typeof onExport !== 'function') return;
        cancelBtn.disabled = true;
        previewBtn.disabled = true;
        setButtonLoading(exportBtn, true, 'Exporting…');
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
        }
      },
    }, 'Export');

    const { close } = openModal({
      title: 'Export',
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
        rows.append(el('div.muted', {}, 'No templates saved for this format yet.'));
        return;
      }
      for (const name of list) {
        rows.append(el('div.row', { style: { justifyContent: 'space-between', gap: '8px' } },
          el('span', {}, name),
          el('div.row', {},
            el('button', {
              type: 'button',
              onClick: async () => {
                const next = await promptText({ title: 'Rename template', label: 'Name', value: name });
                if (next && next.trim() && next.trim() !== name) {
                  list = await onRename(name, next.trim());
                  renderRows();
                }
              },
            }, 'Rename'),
            el('button', { type: 'button', onClick: async () => { list = await onDuplicate(name); renderRows(); } }, 'Duplicate'),
            el('button', { type: 'button', onClick: async () => { await onExport(name); } }, 'Share…'),
            el('button.danger', { type: 'button', onClick: async () => { list = await onDelete(name); renderRows(); } }, 'Delete'),
          ),
        ));
      }
    }

    const { close } = openModal({
      title: `Templates — ${format}`,
      body: el('div', {},
        el('div.row', { style: { marginBottom: '10px' } },
          el('button', { type: 'button', onClick: async () => { list = await onImport(); renderRows(); } }, 'Import .sfglt…'),
          el('span.muted', {}, 'Templates are shareable as .sfglt files.'),
        ),
        rows,
      ),
      footer: [el('button.primary', { onClick: () => { close(); resolve(list); } }, 'Done')],
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
      ? `Locked by ${conflictInfo.user || 'another user'}@${conflictInfo.host || 'another host'}`
      : 'No active conflict';

    const body = el('div', { className: 'linked-guide' },
      el('div', { className: 'card-list' },
        el('div.row', {}, el('span.muted', {}, 'Archive'), el('strong', {}, linked.path || 'Not linked')),
        el('div.row', {}, el('span.muted', {}, 'Opened'), el('span', {}, fmtDate(linked.openedAt) || 'Unknown')),
        el('div.row', {}, el('span.muted', {}, 'Last saved'), el('span', {}, fmtDate(linked.lastSavedAt) || 'Never')),
        el('div.row', {}, el('span.muted', {}, 'Lock'), el('span', {}, lockInfo)),
      ),
      conflict ? el('div', { className: 'warn-banner' }, 'Another editor has the archive locked. You can force-save if you intend to overwrite it.') : null,
    );

    const { close } = openModal({
      title: 'Linked Guide',
      body,
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, 'Close'),
        el('button', {
          onClick: async () => {
            await onOpenArchive?.(guide);
          },
        }, 'Show file'),
        conflict ? el('button.primary', {
          onClick: async () => {
            await onForceSave?.(guide);
            close();
            resolve(true);
          },
        }, 'Force save') : el('button.primary', {
          onClick: async () => {
            await onSave?.(guide);
            close();
            resolve(true);
          },
        }, 'Save now'),
      ],
      wide: true,
      onClose: () => resolve(false),
    });
  });
}

function showBackupsDialog({ snapshots = [], onCreate, onRestore } = {}) {
  return new Promise((resolve) => {
    let list = [...snapshots];
    const rows = el('div', { className: 'card-list' });

    function renderRows() {
      clearNode(rows);
      if (!list.length) {
        rows.append(el('div.muted', {}, 'No snapshots yet. Automatic snapshots are created as you work; create one manually any time.'));
        return;
      }
      for (const name of list) {
        rows.append(el('div.row', { style: { justifyContent: 'space-between', gap: '10px' } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
          el('button', {
            type: 'button',
            onClick: async () => {
              const restored = await onRestore?.(name);
              if (restored) close();
            },
          }, 'Restore'),
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
    }, 'Create snapshot');

    const { close } = openModal({
      title: 'Backups & snapshots',
      body: el('div', {},
        el('div.row', { style: { marginBottom: '10px' } }, createBtn,
          el('span.muted', {}, 'Restores are undoable — the current state is snapshotted first.')),
        rows,
      ),
      footer: [el('button', { onClick: () => { close(); resolve(true); } }, 'Close')],
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
      const keyInput = makeInput(key, 'text', { placeholder: 'Name' });
      const valueInput = makeInput(value, 'text', { placeholder: 'Value' });
      const row = el('div.placeholder-row', {}, keyInput, valueInput,
        el('button.icon', {
          type: 'button', title: 'Remove',
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
          el('button', { type: 'button', onClick: () => addRow() }, 'Add placeholder')),
      ),
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, 'Cancel'),
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
        }, 'Save'),
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
function showGuideInfoDialog({ values = {}, onSave } = {}) {
  return new Promise((resolve) => {
    const authorInput = makeInput(values.author || '', 'text', { placeholder: 'e.g. Jane Doe' });
    const coAuthorsInput = makeInput(values.coAuthors || '', 'text', { placeholder: 'e.g. Alex Lee, Sam Patel' });
    const organizationInput = makeInput(values.organization || '', 'text', { placeholder: 'e.g. Acme Corp' });
    const descriptionInput = el('textarea', {
      rows: 4,
      placeholder: 'A short summary of this guide.',
    }, values.description || '');

    const { close } = openModal({
      title: 'Guide information',
      body: el('div', {},
        el('div.muted', { style: { marginBottom: '10px' } },
          'All fields are optional. They appear below the title on the guide and on the PDF cover page.'),
        labeledRow('Author', authorInput),
        labeledRow('Co-authors', coAuthorsInput),
        labeledRow('Organization', organizationInput),
        labeledRow('Description', descriptionInput, { stacked: true }),
        el('div.muted', { style: { marginTop: '-4px' } },
          'Shown on the first page of the PDF and at the top of other export formats.'),
      ),
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, 'Cancel'),
        el('button.primary', {
          onClick: async () => {
            await onSave?.({
              author: authorInput.value.trim(),
              coAuthors: coAuthorsInput.value.trim(),
              organization: organizationInput.value.trim(),
              description: descriptionInput.value.trim(),
            });
            close();
            resolve(true);
          },
        }, 'Save'),
      ],
      onClose: () => resolve(false),
    });
  });
}

const SHORTCUTS = [
  ['Capture & steps', [
    ['Ctrl+S', 'Save (writes linked archive when guide is linked)'],
    ['Ctrl+/', 'Quick actions palette'],
    ['PageUp / PageDown', 'Previous / next step'],
    ['Alt+↑ / Alt+↓', 'Move step up / down'],
    ['Ctrl+Delete', 'Delete current step'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo (including step deletion)'],
    ['Ctrl+V', 'Paste annotation, or clipboard image as new step'],
  ]],
  ['Canvas tools', [
    ['S R O L A T', 'Select · Rectangle · Oval · Line · Arrow · Text'],
    ['G N B H M U C', 'Tooltip · Number · Blur · Highlight · Magnify · Cursor · Crop'],
    ['Ctrl+C', 'Copy selected annotation'],
    ['Delete', 'Delete selected annotation'],
    ['Esc', 'Deselect annotation'],
    ['Arrows / Shift+Arrows', 'Nudge selection by 1 px / 10 px'],
  ]],
  ['View', [
    ['Ctrl+= / Ctrl+-', 'Zoom in / out'],
    ['Ctrl+0', 'Fit image to window'],
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
      title: 'Keyboard shortcuts',
      body: el('div', {}, ...sections),
      footer: [el('button.primary', { onClick: () => { close(); resolve(true); } }, 'Close')],
      onClose: () => resolve(true),
    });
  });
}

function showInfoDialog(title, bodyText) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title,
      body: el('div', {}, bodyText),
      footer: [el('button.primary', { onClick: () => { close(); resolve(true); } }, 'OK')],
      onClose: () => resolve(false),
    });
  });
}

function showRecordingReminder({
  actionLabel = 'Continue',
  headline = 'StepForge will hide after you continue.',
} = {}) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title: 'Before recording starts',
      body: el('div.recording-notice', {},
        el('div.recording-notice__badge', {}, 'Recording tip'),
        el('div.recording-notice__title', {}, headline),
        el('div.recording-notice__text', {},
          'When you want to pause or stop, use the red tray icon in the system tray.',
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
  promptText,
  showQuickActions,
  showSettingsDialog,
  showExportDialog,
  showLinkedGuideDialog,
  showInfoDialog,
  showBackupsDialog,
  showPlaceholdersDialog,
  showGuideInfoDialog,
  showShortcutsDialog,
  showTemplateManager,
  showRecordingReminder,
};
})();
