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
    const captureHotkey = makeInput(settings.capture?.hotkeyCapture || '', 'text');
    const pauseHotkey = makeInput(settings.capture?.hotkeyPauseResume || '', 'text');
    const focusedDefault = el('input', { type: 'checkbox', checked: Boolean(settings.editor?.focusedViewDefaultForNewSteps) });
    const previewCount = makeInput(settings.exports?.previewStepCount ?? 3, 'number', { min: 1, step: 1 });
    const openFolder = el('input', { type: 'checkbox', checked: Boolean(settings.exports?.openFolderAfterExport) });
    const captureOutside = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.captureOutsideClicks) });
    const confirmSimple = el('input', { type: 'checkbox', checked: Boolean(settings.capture?.confirmSimpleCapture) });
    const keepLast = makeInput(settings.backups?.keepLast ?? 10, 'number', { min: 0, step: 1 });

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
} = {}) {
  return new Promise((resolve) => {
    const formatOptions = (formats || []).map((f) => {
      if (typeof f === 'string') return { value: f, label: f };
      return { value: f.id || f.value || f.name, label: f.label || f.id || f.value || f.name };
    });
    const formatSelect = makeSelect(defaultFormat, formatOptions);
    const templateSelect = makeSelect('', [{ value: '', label: 'Default template' }]);
    const outDirInput = makeInput(defaultOutDir, 'text', { placeholder: 'Choose an output folder' });
    const info = el('div.muted', {}, 'Templates are optional. If no template is selected, exporter defaults are used.');

    function refreshTemplates() {
      const list = templatesByFormat[formatSelect.value] || [];
      clearNode(templateSelect);
      templateSelect.append(el('option', { value: '' }, 'Default template'));
      for (const name of list) templateSelect.append(el('option', { value: name }, name));
    }

    formatSelect.addEventListener('change', refreshTemplates);
    refreshTemplates();

    const body = el('div.export-dialog', {},
      labeledRow('Format', formatSelect),
      labeledRow('Template', templateSelect),
      labeledRow('Output folder', el('div.row', {}, outDirInput, el('button', {
        type: 'button',
        disabled: typeof onChooseDir !== 'function',
        onClick: async () => {
          if (typeof onChooseDir !== 'function') return;
          const chosen = await onChooseDir(formatSelect.value);
          if (chosen) outDirInput.value = chosen;
        },
      }, 'Choose…'))),
      info,
    );

    const { close } = openModal({
      title: 'Export',
      body,
      footer: [
        el('button', { onClick: () => { close(); resolve(false); } }, 'Cancel'),
        el('button', {
          onClick: async () => {
            if (typeof onPreview !== 'function') return;
            const ok = await onPreview({
              format: formatSelect.value,
              templateName: templateSelect.value || null,
              outDir: outDirInput.value.trim() || null,
            });
            if (ok !== false) {
              close();
              resolve(true);
            }
          },
        }, 'Preview'),
        el('button.primary', {
          onClick: async () => {
            if (typeof onExport !== 'function') return;
            const ok = await onExport({
              format: formatSelect.value,
              templateName: templateSelect.value || null,
              outDir: outDirInput.value.trim() || null,
            });
            if (ok !== false) {
              close();
              resolve(true);
            }
          },
        }, 'Export'),
      ],
      wide: true,
      onClose: () => resolve(false),
    });
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

window.StepForgeDialogs = {
  promptText,
  showQuickActions,
  showSettingsDialog,
  showExportDialog,
  showLinkedGuideDialog,
  showInfoDialog,
};
})();
