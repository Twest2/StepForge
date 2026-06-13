'use strict';

(() => {

const api = window.stepforge;
const dialogs = window.StepForgeDialogs || {};

class StepForgeApp {
  constructor() {
    this.view = document.getElementById('view');
    this.topbarContext = document.getElementById('topbar-context');
    this.searchInput = document.getElementById('global-search');
    this.captureStatus = document.getElementById('capture-status');
    this.homeBtn = document.getElementById('btn-home');

    this.state = {
      view: 'welcome',
      query: '',
      folderFilter: 'all',
      library: { guides: [], folders: [], guideFolders: {} },
      trash: [],
      settings: null,
      info: null,
      selectMode: false,
      selectedGuides: new Set(),
      selectedTrash: new Set(),
    };
    this.editorMeta = null;
    this.libraryRenderToken = 0;

    this.view.innerHTML = `
      <div id="welcome-host"></div>
      <div id="library-host" class="hidden"></div>
      <div id="editor-host" class="hidden"></div>
    `;
    this.welcomeHost = document.getElementById('welcome-host');
    this.libraryHost = document.getElementById('library-host');
    this.editorHost = document.getElementById('editor-host');

    this.editor = new GuideEditor({
      root: this.editorHost,
      onMetaChange: (meta) => this.onEditorMeta(meta),
      onToast: (msg, opts) => toast(msg, opts),
      onBack: async (reason) => {
        if (reason === 'new') {
          await this.createGuide();
          return;
        }
        await this.showLibrary();
      },
    });

    this.searchInput.addEventListener('input', debounce(() => {
      this.state.query = this.searchInput.value.trim();
      if (this.state.view === 'library') this.renderLibrary();
    }, 80));

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.state.view === 'library') this.openQuickActions();
      }
      if (e.key === 'Escape') {
        this.searchInput.value = '';
        this.state.query = '';
        if (this.state.view === 'library') this.renderLibrary();
      }
    });

    this.homeBtn.addEventListener('click', () => {
      if (this.state.view !== 'welcome') this.showWelcome();
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/' && !e.shiftKey) {
        e.preventDefault();
        this.openQuickActions();
      }
    });

    api.capture.onAdded((payload) => this.onCaptureAdded(payload));
    api.capture.onState((payload) => this.updateCaptureState(payload));
  }

  async onCaptureAdded(payload) {
    if (!payload || !payload.guideId) return;
    this.updateCaptureState(await api.capture.state());
    if (this.state.view === 'editor' && this.editor.guideId === payload.guideId) {
      await this.editor.reload(payload.step && payload.step.stepId ? payload.step.stepId : this.editor.selectedStepId);
      return;
    }
    await this.refreshLibrary();
  }

  async init() {
    this.renderWelcome();
    try {
      await this.refreshData();
      this.updateCaptureState(await api.capture.state());
    } catch (err) {
      console.error(err);
    }
  }

  async refreshData() {
    const [info, settings, library, trash] = await Promise.all([
      api.app.info(),
      api.settings.all(),
      api.library.list(),
      api.library.trashList(),
    ]);
    this.state.info = info;
    this.state.settings = settings;
    this.state.library = {
      guides: library.guides || [],
      folders: library.folders?.folders || [],
      guideFolders: library.folders?.guideFolders || {},
    };
    this.state.trash = trash;
  }

  async refreshLibrary({ keepFilter = true } = {}) {
    const folderFilter = keepFilter ? this.state.folderFilter : 'all';
    await this.refreshData();
    if (!this.folderExists(folderFilter) && !['all', 'favorites', 'trash'].includes(folderFilter)) {
      this.state.folderFilter = 'all';
    }
    if (this.state.view === 'library') this.renderLibrary();
    else this.renderTopbar();
  }

  folderExists(folderId) {
    return (this.state.library.folders || []).some((f) => f.id === folderId);
  }

  setView(view) {
    this.state.view = view;
    this.welcomeHost.classList.toggle('hidden', view !== 'welcome');
    this.libraryHost.classList.toggle('hidden', view !== 'library');
    this.editorHost.classList.toggle('hidden', view !== 'editor');
    this.searchInput.classList.toggle('hidden', view !== 'library');
    this.renderTopbar();
    // The capture bar is editor-only; re-evaluate its visibility now that
    // the view changed.
    this.updateCaptureState(this.captureState);
  }

  showWelcome() {
    this.editor.setActive(false);
    this.setView('welcome');
    this.renderWelcome();
  }

  renderWelcome() {
    this.setView('welcome');
    clearNode(this.welcomeHost);
    this.welcomeHost.append(
      el('div.welcome', {},
        el('div.welcome-title', {},
          el('h1', {}, 'StepForge'),
          el('p.muted', {}, 'Capture, annotate, and export step-by-step guides — fully offline.'),
        ),
        el('div.welcome-actions', {},
          el('button.welcome-btn.primary', {
            type: 'button',
            onClick: () => this.startNewCapture(),
          },
          el('span.welcome-btn-label', {}, 'New Capture'),
          el('span.welcome-btn-hint', {}, 'Start a guide and capture your screen'),
          ),
          el('button.welcome-btn', {
            type: 'button',
            onClick: () => this.openExistingWorkspace(),
          },
          el('span.welcome-btn-label', {}, 'Existing Workspace'),
          el('span.welcome-btn-hint', {}, 'Browse your guide library'),
          ),
          el('button.welcome-btn', {
            type: 'button',
            onClick: () => this.openSettings(),
          },
          el('span.welcome-btn-label', {}, 'Settings'),
          el('span.welcome-btn-hint', {}, 'Theme, capture, and export options'),
          ),
        ),
      ),
    );
  }

  async startNewCapture() {
    const guide = await api.library.create({ title: 'Untitled capture' });
    await this.refreshData();
    await this.openGuide(guide.guideId);
    await this.armCaptureSession(guide.guideId);
  }

  async openExistingWorkspace() {
    await this.refreshData();
    this.state.query = '';
    this.searchInput.value = '';
    this.state.folderFilter = 'all';
    await this.showLibrary();
  }

  async showLibrary(reason = null) {
    this.editor.setActive(false);
    this.setView('library');
    if (reason === 'new') {
      await this.createGuide();
      return;
    }
    this.renderLibrary();
  }

  async openGuide(guideId, stepId = null) {
    this.setView('editor');
    this.editor.setActive(true);
    await this.editor.open(guideId, stepId);
    this.renderTopbar();
  }

  // Start a paused session, optionally show a reminder, and continue once
  // the user acknowledges it.
  async armCaptureSession(guideId, reminder = null) {
    const state = await api.capture.session({ action: 'start', guideId });
    this.updateCaptureState(state);
    if (!reminder) return state;
    const acknowledged = await dialogs.showRecordingReminder(reminder);
    if (!acknowledged) return state;
    const next = await api.capture.session({ action: 'resume', guideId });
    this.updateCaptureState(next);
    return next;
  }

  // Opens a guide and arms (paused) capture for it, so the red REC bar pops
  // up right away with a "Start recording" option to resume capturing steps.
  async openGuideAndArmCapture(guideId, stepId = null) {
    await this.openGuide(guideId, stepId);
    // Don't restart (and reset the count of) a session already running for this guide.
    if (this.captureState?.active && this.captureState.guideId === guideId) return;
    await this.armCaptureSession(guideId);
  }

  onEditorMeta(meta) {
    this.editorMeta = meta;
    if (this.state.view === 'editor') this.renderTopbar();
    this.updateCaptureState(this.captureState || null);
  }

  updateCaptureState(state) {
    this.captureState = state || { active: false };
    clearNode(this.captureStatus);
    // The capture bar only makes sense alongside the editor it's recording
    // into — hide it everywhere else (e.g. the library) even if a session
    // is still active in the background.
    if (!this.captureState.active || this.state.view !== 'editor') {
      this.captureStatus.classList.add('hidden');
      return;
    }
    this.captureStatus.classList.remove('hidden');
    const s = this.captureState;
    const send = (payload) => api.capture.session(payload).then((next) => this.updateCaptureState(next));

    // What is currently triggering captures, so the user knows what to do.
    const notStarted = s.paused && !s.count;
    const trigger = notStarted ? 'ready'
      : s.paused ? 'paused'
        : s.clickCapture ? 'on click'
          : s.intervalSec > 0 ? `every ${s.intervalSec}s`
            : 'hotkey only';

    // Cycle interval auto-capture: off -> 3s -> 5s -> 10s -> off.
    const nextInterval = { 0: 3, 3: 5, 5: 10, 10: 0 }[s.intervalSec ?? 0] ?? 3;
    const autoBtn = el('button', {
      type: 'button',
      title: 'Automatically capture a step on a timer',
      onClick: () => send({ action: 'interval', intervalSec: nextInterval }),
    }, s.intervalSec > 0 ? `Auto ${s.intervalSec}s` : 'Auto off');

    const pauseBtn = el('button', {
      type: 'button',
      title: notStarted ? 'StepForge tucks away and starts capturing' : '',
      onClick: async () => {
        if (notStarted) {
          const acknowledged = await dialogs.showRecordingReminder();
          if (!acknowledged) return;
        }
        send({ action: s.paused ? 'resume' : 'pause' });
      },
    }, notStarted ? 'Start recording' : s.paused ? 'Resume' : 'Pause');

    const finishBtn = el('button', {
      type: 'button',
      onClick: () => send({ action: 'finish' }),
    }, 'Finish');

    this.captureStatus.append(
      el('span', { title: `Capture session — ${trigger}` }, `REC ${s.count || 0} · ${trigger}`),
      autoBtn,
      pauseBtn,
      finishBtn,
    );
  }

  renderTopbar() {
    clearNode(this.topbarContext);
    if (this.state.view === 'welcome') return;
    if (this.state.view === 'library') {
      this.topbarContext.append(
        el('button', { type: 'button', onClick: () => this.createGuide() }, 'New'),
        el('button', { type: 'button', onClick: () => this.importArchive('copy') }, 'Import'),
        el('button', { type: 'button', onClick: () => this.importArchive('linked') }, 'Linked'),
        el('button', { type: 'button', onClick: () => this.openSettings() }, 'Settings'),
      );
      return;
    }

    const guide = this.editorMeta?.guide;
    this.topbarContext.append(
      el('button', { type: 'button', onClick: () => this.showLibrary() }, 'Back'),
      el('button.primary', {
        type: 'button',
        title: 'Capture a screenshot step',
        onClick: (e) => this.editor.openCaptureMenu(e),
      }, 'Capture ▾'),
      el('button', { type: 'button', onClick: () => this.editor.saveAll() }, 'Save'),
      el('button', { type: 'button', onClick: () => this.editor.openExportDialog() }, 'Export'),
      el('button', { type: 'button', title: 'Share this guide as a .sfgz file', onClick: () => this.editor.shareAsFile() }, 'Share'),
      el('button', {
        type: 'button',
        onClick: (e) => {
          const rect = e.target.getBoundingClientRect();
          contextMenu(rect.left, rect.bottom + 4, [
            { label: 'Rename guide…', action: () => this.renameGuide() },
            { label: 'Guide placeholders…', action: () => this.editor.openGuidePlaceholders() },
            { label: 'Backups & snapshots…', action: () => this.editor.openBackupsDialog() },
            { label: guide && guide.linkedSource ? 'Linked guide…' : 'Linked guide (not linked)', action: () => this.editor.openLinkedGuide() },
            'sep',
            { label: 'Keyboard shortcuts…', action: () => this.editor.openShortcutsHelp() },
            { label: 'Quick actions  (Ctrl+/)', action: () => this.editor.openQuickActions() },
            { label: 'Settings…', action: () => this.openSettings() },
          ]);
        },
      }, 'More ▾'),
      el('span.muted', { style: { marginLeft: '8px' } }, guide ? `${guide.title} · ${this.editorMeta?.stepCount || 0} steps` : ''),
    );
  }

  async renderLibrary() {
    this.setView('library');
    this.editor.setActive(false);
    clearNode(this.libraryHost);
    const q = this.state.query.trim();
    const folderLabel = this.filterLabel();
    // Selecting only makes sense for the guide grid and the trash — drop out
    // of select mode for search results.
    const canSelect = !q;
    if (!canSelect && this.state.selectMode) {
      this.state.selectMode = false;
      this.state.selectedGuides = new Set();
      this.state.selectedTrash = new Set();
    }
    const body = el('div.library', {},
      el('aside.lib-side', {},
        el('h3', {}, 'Library'),
        this.libraryNavItem('all', 'All guides', this.state.library.guides.length),
        this.libraryNavItem('favorites', 'Favorites', this.state.library.guides.filter((g) => g.favorite).length),
        this.libraryNavItem('trash', 'Trash', this.state.trash.length),
        el('h3', {}, 'Folders'),
        ...this.renderFolderItems(this.state.library.folders || [], null, 0),
        el('div', { style: { marginTop: '8px' } },
          el('button', { type: 'button', onClick: () => this.createFolder() }, 'Add folder'),
        ),
      ),
      el('main.lib-main', {},
        el('div.lib-actions', {},
          el('button.primary', { type: 'button', onClick: () => this.createGuide() }, 'New guide'),
          el('button', { type: 'button', onClick: () => this.importArchive('copy') }, 'Import archive'),
          el('button', { type: 'button', onClick: () => this.importArchive('linked') }, 'Open linked'),
          el('button', { type: 'button', onClick: () => this.openQuickActions() }, 'Quick actions'),
          canSelect ? el('button', {
            type: 'button',
            className: this.state.selectMode ? 'primary' : '',
            onClick: () => this.toggleSelectMode(),
          }, 'Select') : null,
        ),
        el('div.row', { style: { justifyContent: 'space-between', marginBottom: '14px' } },
          el('div', {},
            el('div', { style: { fontWeight: 650 } }, folderLabel),
            q ? el('div.muted', {}, `Search: ${q}`) : el('div.muted', {}, `${this.state.library.guides.length} guides`),
          ),
          el('div.muted', {}, this.state.info ? `StepForge ${this.state.info.version}` : ''),
        ),
        this.domBulkBar = el('div', {}),
        this.domLibraryResults = el('div', {}),
      ),
    );
    this.libraryHost.append(body);

    if (q) {
      await this.renderSearchResults();
    } else if (this.state.folderFilter === 'trash') {
      this.renderTrashView();
    } else {
      this.renderGuideGrid();
    }
    this.renderBulkBar();
    this.renderTopbar();
  }

  setFolderFilter(folderFilter) {
    this.state.folderFilter = folderFilter;
    this.state.selectMode = false;
    this.state.selectedGuides = new Set();
    this.state.selectedTrash = new Set();
    this.renderLibrary();
  }

  libraryNavItem(id, label, count) {
    const props = {
      className: `nav-item${this.state.folderFilter === id ? ' active' : ''}`,
      onClick: () => this.setFolderFilter(id),
    };
    if (!['all', 'favorites', 'trash'].includes(id)) {
      props.onContextMenu = (e) => this.folderContextMenu(e, id);
    }
    return el('div.nav-item', props,
    el('span', {}, label),
    el('span.count', {}, count));
  }

  renderFolderItems(folders, parentId = null, depth = 0) {
    const out = [];
    const children = folders
      .filter((folder) => (folder.parentId || null) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of children) {
      const count = Object.entries(this.state.library.guideFolders || {})
        .filter(([, fid]) => fid === folder.id).length;
      out.push(el('div.nav-item', {
        className: `nav-item${this.state.folderFilter === folder.id ? ' active' : ''}`,
        style: { paddingLeft: `${8 + depth * 12}px` },
        onClick: () => this.setFolderFilter(folder.id),
        onContextMenu: (e) => this.folderContextMenu(e, folder.id),
      },
      el('span', {}, folder.name),
      el('span.count', {}, count)));
      out.push(...this.renderFolderItems(folders, folder.id, depth + 1));
    }
    return out;
  }

  folderContextMenu(event, folderId) {
    event.preventDefault();
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    if (!folder) return;
    contextMenu(event.clientX, event.clientY, [
      { label: 'Rename folder', action: () => this.renameFolder(folderId) },
      { label: 'Delete folder', danger: true, action: () => this.deleteFolder(folderId) },
    ]);
  }

  filterLabel() {
    if (this.state.folderFilter === 'all') return 'All guides';
    if (this.state.folderFilter === 'favorites') return 'Favorites';
    if (this.state.folderFilter === 'trash') return 'Trash';
    const folder = (this.state.library.folders || []).find((f) => f.id === this.state.folderFilter);
    return folder ? folder.name : 'All guides';
  }

  scopeGuide(guide) {
    if (this.state.folderFilter === 'all') return true;
    if (this.state.folderFilter === 'favorites') return Boolean(guide.favorite);
    if (this.state.folderFilter === 'trash') return false;
    return (this.state.library.guideFolders || {})[guide.guideId] === this.state.folderFilter;
  }

  async renderSearchResults() {
    const token = ++this.libraryRenderToken;
    const results = await api.search.query({ q: this.state.query });
    if (token !== this.libraryRenderToken) return;
    const guidesById = new Map(this.state.library.guides.map((g) => [g.guideId, g]));
    const filtered = results.filter((r) => {
      const guide = guidesById.get(r.guideId);
      if (!guide) return false;
      return this.scopeGuide(guide);
    });
    clearNode(this.domLibraryResults);
    if (!filtered.length) {
      this.domLibraryResults.append(el('div.empty-state', {}, el('div.big', {}, 'Search'), 'No results for this query.'));
      return;
    }
    this.domLibraryResults.append(
      el('div.guide-grid', {},
        ...filtered.map((result) => {
          const guide = guidesById.get(result.guideId);
          const isStep = Boolean(result.stepId);
          return this.resultCard(result, guide, isStep);
        }),
      ),
    );
  }

  renderGuideGrid() {
    const guides = this.state.library.guides.filter((guide) => this.scopeGuide(guide));
    clearNode(this.domLibraryResults);
    if (!guides.length) {
      this.domLibraryResults.append(
        el('div.empty-state', {},
          el('div.big', {}, '∅'),
          this.state.folderFilter === 'trash'
            ? 'Trash is empty.'
            : 'No guides in this section yet.',
        ),
      );
      return;
    }
    this.domLibraryResults.append(el('div.guide-grid', {}, ...guides.map((guide) => this.guideCard(guide))));
  }

  renderTrashView() {
    clearNode(this.domLibraryResults);
    if (!this.state.trash.length) {
      this.domLibraryResults.append(el('div.empty-state', {}, el('div.big', {}, 'Trash'), 'Nothing deleted yet.'));
      return;
    }
    const selectMode = this.state.selectMode;
    const items = this.state.trash.map((name) => {
      const selected = this.state.selectedTrash.has(name);
      return el('div.guide-card', {
        className: `guide-card${selected ? ' selected' : ''}`,
        onClick: () => {
          if (selectMode) this.toggleTrashSelection(name);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          if (selectMode) return;
          contextMenu(e.clientX, e.clientY, [
            { label: 'Restore', action: () => this.restoreTrashItem(name) },
            { label: 'Empty trash', danger: true, action: () => this.purgeTrashItem() },
          ]);
        },
      },
      el('h4', {}, name),
      el('div.meta', {}, 'Deleted guide archive'));
    });
    this.domLibraryResults.append(el('div.guide-grid', {}, ...items));
  }

  guideCard(guide) {
    const folderId = (this.state.library.guideFolders || {})[guide.guideId] || null;
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    const badgeText = guide.linkedSource ? 'Linked' : guide.favorite ? 'Favorite' : 'Local';
    const selectMode = this.state.selectMode;
    const selected = this.state.selectedGuides.has(guide.guideId);
    const description = (guide.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const card = el('div.guide-card', {
      className: `guide-card${selected ? ' selected' : ''}`,
      onClick: () => {
        if (selectMode) this.toggleGuideSelection(guide.guideId);
        else this.openGuideAndArmCapture(guide.guideId);
      },
      onContextMenu: (e) => {
        e.preventDefault();
        if (selectMode) return;
        this.guideContextMenu(e, guide);
      },
    },
    el('div.fav', {
      className: `fav${guide.favorite ? ' on' : ''}`,
      onClick: async (e) => {
        e.stopPropagation();
        if (selectMode) return;
        await api.library.setFavorite({ guideId: guide.guideId, favorite: !guide.favorite });
        await this.refreshLibrary();
      },
    }, '★'),
    el('h4', {}, guide.title || 'Untitled guide'),
    el('div.meta', {},
      el('span.badge', {}, badgeText),
      el('span', {}, `${guide.stepCount || 0} steps`),
      folder ? el('span', {}, folder.name) : null,
      guide.locked ? el('span.badge', {}, 'Locked') : null,
    ),
    description ? el('div.snippet', {}, description) : null,
    el('div.muted', {}, fmtDate(guide.updatedAt)));
    return card;
  }

  resultCard(result, guide, isStep) {
    return el('div.guide-card', {
      onClick: () => this.openGuideAndArmCapture(result.guideId, result.stepId || null),
    },
    el('h4', {}, isStep ? `${guide.title} · ${result.title}` : result.title),
    el('div.meta', {},
      el('span.badge', {}, isStep ? 'Step' : 'Guide'),
      el('span', {}, guide.favorite ? 'Favorite' : 'Local'),
    ),
    el('div.muted', {}, result.snippet || ''));
  }

  guideContextMenu(event, guide) {
    const currentFolderId = (this.state.library.guideFolders || {})[guide.guideId] || null;
    const folderItems = (this.state.library.folders || [])
      .filter((folder) => folder.id !== currentFolderId)
      .map((folder) => ({
        label: `Move to ${folder.name}`,
        action: () => this.moveGuideToFolder(guide.guideId, folder.id),
      }));
    if (currentFolderId) folderItems.push({ label: 'Move to no folder', action: () => this.moveGuideToFolder(guide.guideId, null) });
    const moveItems = folderItems.length ? ['sep', ...folderItems] : [];
    contextMenu(event.clientX, event.clientY, [
      { label: 'Open guide', action: () => this.openGuideAndArmCapture(guide.guideId) },
      { label: 'Rename guide…', action: () => this.renameGuide(guide) },
      { label: guide.favorite ? 'Unfavorite' : 'Favorite', action: () => this.toggleFavorite(guide) },
      { label: 'Duplicate guide', action: () => this.duplicateGuide(guide.guideId) },
      { label: 'Export', action: () => this.openGuideExport(guide.guideId) },
      ...moveItems,
      'sep',
      { label: 'Delete guide', danger: true, action: () => this.deleteGuide(guide.guideId) },
    ]);
  }

  toggleSelectMode() {
    this.state.selectMode = !this.state.selectMode;
    this.state.selectedGuides = new Set();
    this.state.selectedTrash = new Set();
    this.renderLibrary();
  }

  toggleGuideSelection(guideId) {
    if (this.state.selectedGuides.has(guideId)) this.state.selectedGuides.delete(guideId);
    else this.state.selectedGuides.add(guideId);
    this.renderGuideGrid();
    this.renderBulkBar();
  }

  selectAllGuides() {
    const guides = this.state.library.guides.filter((guide) => this.scopeGuide(guide));
    this.state.selectedGuides = new Set(guides.map((g) => g.guideId));
    this.renderGuideGrid();
    this.renderBulkBar();
  }

  clearSelection() {
    this.state.selectedGuides = new Set();
    this.renderGuideGrid();
    this.renderBulkBar();
  }

  toggleTrashSelection(name) {
    if (this.state.selectedTrash.has(name)) this.state.selectedTrash.delete(name);
    else this.state.selectedTrash.add(name);
    this.renderTrashView();
    this.renderBulkBar();
  }

  selectAllTrash() {
    this.state.selectedTrash = new Set(this.state.trash);
    this.renderTrashView();
    this.renderBulkBar();
  }

  clearTrashSelection() {
    this.state.selectedTrash = new Set();
    this.renderTrashView();
    this.renderBulkBar();
  }

  async bulkRestoreTrash() {
    const names = [...this.state.selectedTrash];
    if (!names.length) return;
    await Promise.all(names.map((name) => api.library.trashRestore({ name })));
    this.state.selectedTrash = new Set();
    await this.refreshLibrary();
  }

  async bulkPurgeTrash() {
    const names = [...this.state.selectedTrash];
    if (!names.length) return;
    const ok = await confirmDialog(`Permanently delete ${names.length} item${names.length === 1 ? '' : 's'}? This cannot be undone.`, { danger: true, okLabel: 'Delete forever' });
    if (!ok) return;
    await api.library.trashPurge({ names });
    this.state.selectedTrash = new Set();
    await this.refreshLibrary();
  }

  renderBulkBar() {
    if (!this.domBulkBar) return;
    clearNode(this.domBulkBar);
    if (!this.state.selectMode) return;
    if (this.state.folderFilter === 'trash') {
      const n = this.state.selectedTrash.size;
      const allSelected = this.state.trash.length > 0 && n === this.state.trash.length;
      this.domBulkBar.append(
        el('div.bulk-bar', {},
          el('span', {}, n ? `${n} selected` : 'Select items to act on them'),
          el('span.spacer', {}),
          el('button', {
            type: 'button',
            onClick: () => (allSelected ? this.clearTrashSelection() : this.selectAllTrash()),
          }, allSelected ? 'Clear selection' : 'Select all'),
          el('button', { type: 'button', disabled: !n, onClick: () => this.bulkRestoreTrash() }, 'Restore'),
          el('button.danger', { type: 'button', disabled: !n, onClick: () => this.bulkPurgeTrash() }, 'Delete forever'),
        ),
      );
      return;
    }
    const guides = this.state.library.guides.filter((guide) => this.scopeGuide(guide));
    const n = this.state.selectedGuides.size;
    const allSelected = guides.length > 0 && n === guides.length;
    this.domBulkBar.append(
      el('div.bulk-bar', {},
        el('span', {}, n ? `${n} selected` : 'Select guides to act on them'),
        el('span.spacer', {}),
        el('button', {
          type: 'button',
          onClick: () => (allSelected ? this.clearSelection() : this.selectAllGuides()),
        }, allSelected ? 'Clear selection' : 'Select all'),
        el('button', { type: 'button', disabled: !n, onClick: () => this.bulkSetFavorite(true) }, 'Favorite'),
        el('button', { type: 'button', disabled: !n, onClick: () => this.bulkSetFavorite(false) }, 'Unfavorite'),
        el('button', { type: 'button', disabled: !n, onClick: (e) => this.openBulkMoveMenu(e) }, 'Move to folder ▾'),
        el('button.danger', { type: 'button', disabled: !n, onClick: () => this.bulkDelete() }, 'Delete'),
      ),
    );
  }

  openBulkMoveMenu(event) {
    const rect = event.target.getBoundingClientRect();
    const folderItems = (this.state.library.folders || []).map((folder) => ({
      label: folder.name,
      action: () => this.bulkMoveToFolder(folder.id),
    }));
    contextMenu(rect.left, rect.bottom + 4, [
      { label: 'No folder', action: () => this.bulkMoveToFolder(null) },
      ...(folderItems.length ? ['sep', ...folderItems] : []),
    ]);
  }

  async bulkSetFavorite(favorite) {
    const ids = [...this.state.selectedGuides];
    if (!ids.length) return;
    await Promise.all(ids.map((guideId) => api.library.setFavorite({ guideId, favorite })));
    await this.refreshLibrary();
  }

  async bulkMoveToFolder(folderId) {
    const ids = [...this.state.selectedGuides];
    if (!ids.length) return;
    await Promise.all(ids.map((guideId) => api.folders.moveGuide({ guideId, folderId })));
    await this.refreshLibrary();
  }

  async bulkDelete() {
    const ids = [...this.state.selectedGuides];
    if (!ids.length) return;
    const ok = await confirmDialog(`Delete ${ids.length} guide${ids.length === 1 ? '' : 's'}? They'll move to Trash.`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    await Promise.all(ids.map((guideId) => api.library.delete({ guideId })));
    this.state.selectedGuides = new Set();
    await this.refreshLibrary();
  }

  async createGuide() {
    const title = await dialogs.promptText({
      title: 'New Guide',
      label: 'Title',
      value: 'Untitled guide',
      placeholder: 'Untitled guide',
    });
    if (title == null) return;
    const guide = await api.library.create({ title: title.trim() || 'Untitled guide' });
    await this.refreshLibrary();
    await this.openGuide(guide.guideId);
  }

  async createFolder() {
    const name = await dialogs.promptText({ title: 'New folder', label: 'Folder name', value: '' });
    if (name == null || !name.trim()) return;
    await api.folders.create({ name: name.trim(), parentId: null });
    await this.refreshLibrary();
  }

  async renameFolder(folderId) {
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    if (!folder) return;
    const name = await dialogs.promptText({ title: 'Rename folder', label: 'Folder name', value: folder.name });
    if (name == null || !name.trim()) return;
    await api.folders.rename({ folderId, name: name.trim() });
    await this.refreshLibrary();
  }

  async deleteFolder(folderId) {
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    if (!folder) return;
    const ok = await confirmDialog(`Delete the folder “${folder.name}”? Guides stay in the library.`);
    if (!ok) return;
    await api.folders.delete({ folderId });
    await this.refreshLibrary();
  }

  async moveGuideToFolder(guideId, folderId) {
    await api.folders.moveGuide({ guideId, folderId });
    await this.refreshLibrary();
  }

  async toggleFavorite(guide) {
    await api.library.setFavorite({ guideId: guide.guideId, favorite: !guide.favorite });
    await this.refreshLibrary();
  }

  async duplicateGuide(guideId) {
    await api.library.duplicate({ guideId });
    await this.refreshLibrary();
  }

  async deleteGuide(guideId) {
    const guide = this.state.library.guides.find((g) => g.guideId === guideId);
    if (!guide) return;
    const ok = await confirmDialog(`Delete “${guide.title}”?`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    await api.library.delete({ guideId });
    await this.refreshLibrary();
  }

  async restoreTrashItem(name) {
    await api.library.trashRestore({ name });
    await this.refreshLibrary();
  }

  async purgeTrashItem() {
    const ok = await confirmDialog('Permanently empty the trash?', { danger: true, okLabel: 'Empty trash' });
    if (!ok) return;
    await api.library.trashPurge();
    await this.refreshLibrary();
  }

  async openGuideExport(guideId) {
    const previous = this.editor.guideId;
    await this.openGuide(guideId);
    await this.editor.openExportDialog();
    if (previous && previous !== guideId) {
      // keep the newly opened guide active
    }
  }

  async renameGuide(guide = this.editorMeta?.guide) {
    if (!guide) return;
    const title = await dialogs.promptText({ title: 'Rename guide', label: 'Title', value: guide.title });
    if (title == null || !title.trim()) return;
    const fullGuide = (await api.guide.get({ guideId: guide.guideId })).guide;
    fullGuide.title = title.trim();
    await api.guide.save({ guide: fullGuide });
    if (this.state.view === 'editor' && this.editor.guideId === fullGuide.guideId) {
      await this.editor.reload(this.editor.selectedStepId);
    }
    await this.refreshLibrary();
    if (this.state.view === 'editor') this.renderTopbar();
  }

  async importArchive(mode = 'copy') {
    const result = await api.archive.open({ mode });
    if (!result || !result.ok) return;
    await this.refreshLibrary();
    await this.openGuide(result.guide.guideId);
  }

  async openSettings() {
    const settings = await api.settings.all();
    const placeholders = await api.settings.globalPlaceholders();
    await dialogs.showSettingsDialog({
      settings,
      placeholders,
      onSave: async (next) => {
        await api.settings.set({ keyPath: 'appearance', value: next.appearance });
        await api.settings.set({ keyPath: 'spellcheck', value: next.spellcheck });
        await api.settings.set({ keyPath: 'capture', value: next.capture });
        await api.settings.set({ keyPath: 'editor', value: next.editor });
        await api.settings.set({ keyPath: 'exports', value: next.exports });
        await api.settings.set({ keyPath: 'backups', value: next.backups });
        await api.settings.setGlobalPlaceholders(next.placeholders || {});
        this.state.settings = await api.settings.all();
      },
    });
    await this.refreshData();
    this.renderTopbar();
    if (this.state.view === 'library') this.renderLibrary();
  }

  async openQuickActions() {
    if (this.state.view === 'editor') {
      await this.editor.openQuickActions();
      return;
    }
    const commands = [
      { kind: 'cmd', label: 'New guide', description: 'Create a blank guide', action: () => this.createGuide() },
      { kind: 'cmd', label: 'Import archive', description: 'Open a .sfgz guide archive', action: () => this.importArchive('copy') },
      { kind: 'cmd', label: 'Open linked archive', description: 'Import a linked guide from .sfgz', action: () => this.importArchive('linked') },
      { kind: 'cmd', label: 'Settings', description: 'Open application settings', action: () => this.openSettings() },
      { kind: 'cmd', label: 'Refresh library', description: 'Reload guides and folders', action: () => this.refreshLibrary() },
    ];
    await dialogs.showQuickActions({
      commands,
      searchFn: async (query) => {
        const results = await api.search.query({ q: query });
        return results.map((result) => ({
          kind: result.stepId ? 'step' : 'guide',
          label: result.stepId ? `${result.title}` : result.title,
          description: result.snippet || '',
          action: () => this.openGuideAndArmCapture(result.guideId, result.stepId || null),
        }));
      },
    });
  }
}

window.StepForgeApp = StepForgeApp;

function boot() {
  const app = new StepForgeApp();
  app.init();
  window.stepforgeApp = app;
}

boot();
})();
