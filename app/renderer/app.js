'use strict';

(() => {

const api = window.stepforge;
const dialogs = window.StepForgeDialogs || {};
const review = window.StepForgeReview;

/** "just now", "5 min ago", "3 hr ago", "yesterday", "4 days ago", else a short date. */
function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{count} min ago', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('{count} hr ago', { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t('yesterday');
  if (days < 7) return tn(days, '{count} day ago', '{count} days ago');
  return new Date(then).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: new Date(then).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The "May need review" pill's tooltip: why the guide is flagged. */
function reviewBadgeTitle(status) {
  const since = new Date(status.since).toLocaleDateString(dateLocale, { dateStyle: 'medium' });
  const what = status.sinceKind === 'verified' ? t('Last verified {date}', { date: since }) : t('Last saved {date}', { date: since });
  return t('{since}, over {interval} ago. Open the guide to check it still matches the software, or right-click → Mark as verified.',
    { since: what, interval: intervalText(status.days) });
}

/** "Deleted for good in 12 days", from the trash settings; null when kept. */
function trashCountdown(item, library = {}) {
  const days = library.trashDays ?? 30;
  const deleted = Date.parse(item.deletedAt);
  if (!(days > 0) || !Number.isFinite(deleted)) return null;
  const left = Math.ceil((Math.max(deleted, library.trashEmptyingSince || 0) + days * DAY_MS - Date.now()) / DAY_MS);
  if (left <= 1) return t('Deleted for good within a day');
  return tn(left, 'Deleted for good in {count} day', 'Deleted for good in {count} days');
}

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
    this.cloudStatus = document.getElementById('cloud-status');
    // Opens the settings of whichever service is syncing.
    this.cloudStatus.addEventListener('click', () => this.openSettings(!this.cloudProvider || this.cloudProvider === 'google' ? 'drive' : this.cloudProvider));
    api.cloud.onStatus((status) => this.renderCloudStatus(status));
    api.cloud.onLibraryChanged(() => this.refreshLibrary().catch(console.error));
    api.cloud.onSettingsChanged((payload) => this.onSettingsSynced(payload?.changes).catch(console.error));
    api.cloud.status().then((status) => this.renderCloudStatus(status)).catch(console.error);
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
      // Export → Confluence/Wiki.js recommends publishing instead.
      onPublish: (format) => (format === 'confluence'
        ? this.publishToConfluence(this.editor.guideId, this.editor.guide?.title)
        : this.publishToWikiJs(this.editor.guideId, this.editor.guide?.title)),
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
    api.capture.onStepUpdated((payload) => this.onStepUpdated(payload));
    if (api.capture.onDiagnostic) api.capture.onDiagnostic((payload) => this.onCaptureDiagnostic(payload));
    api.guide.onChangedByAgent((payload) => this.onGuideChangedByAgent(payload));
    api.branding.onChangedByAgent(() => this.onBrandingChangedByAgent());
  }

  /**
   * Global placeholders, branding or language arrived from another
   * computer: pick up the active brand profile, and draw the PNG copies any
   * new SVG or JPG images need.
   */
  async onSettingsSynced(changes = []) {
    this.state.settings = await api.settings.all();
    this.editor.setSettings(this.state.settings);
    await ensurePendingBrandRasters(api);
    // When language switching is available, apply a synced choice through
    // its handler, saving open edits before it reloads the window.
    if (changes.includes('language') && api.app?.setLanguage && await this.flushEditorBeforeNavigation()) {
      await api.app?.setLanguage?.({ language: this.state.settings.language });
    }
  }

  /**
   * An AI agent changed brand profiles: pick up the active profile (its
   * annotation colors), and draw the PNG copies new SVG or JPG images need.
   */
  async onBrandingChangedByAgent() {
    try {
      this.state.settings = await api.settings.all();
      this.editor.setSettings(this.state.settings);
    } catch { /* the next refresh picks it up */ }
    toast(t('An AI agent updated your brand profiles.'));
    await ensurePendingBrandRasters(api);
  }

  /** An AI agent changed a guide: show it without losing the user's unsaved edits. */
  async onGuideChangedByAgent(payload) {
    if (!payload || !payload.guideId) return;
    const open = this.state.view === 'editor' && this.editor.guideId === payload.guideId;
    if (payload.deleted) {
      if (open) {
        // Saving now would write into a guide that is in the Trash.
        this.editor.saveStepDebounced.cancel();
        this.editor.saveGuideDebounced.cancel();
        this.editor.pendingSave = false;
        this.editor.pendingGuideSave = false;
        await this.showLibrary();
        toast('An AI agent moved this guide to the Trash. You can restore it from there.', { ms: 6000 });
      } else if (this.state.view === 'library') {
        await this.refreshLibrary();
      }
      return;
    }
    if (open) {
      await this.editor.reloadAfterOutsideChange();
      toast(t('An AI agent updated this guide.'));
    } else if (this.state.view === 'library') {
      await this.refreshLibrary();
    }
  }

  async onStepUpdated(payload) {
    if (!payload || !payload.guideId || !payload.step) return;
    if (this.state.view === 'editor' && this.editor.guideId === payload.guideId) {
      const currentStep = this.editor.currentStep;
      if (currentStep && currentStep.stepId === payload.step.stepId) {
        await this.editor.reload(payload.step.stepId);
        toast(payload.reason === 'redaction'
          ? tn(payload.added, 'Blurred {count} possible private detail in this step.', 'Blurred {count} possible private details in this step.')
          : t('Documentation generated.'));
      }
    }
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
    // Images an agent added while StepForge was closed.
    void ensurePendingBrandRasters(api);
  }

  async refreshData() {
    const [info, settings, library, trash] = await Promise.all([
      api.app.info(),
      api.settings.all(),
      api.library.list(),
      api.library.trashItems(),
    ]);
    this.state.info = info;
    document.body.classList.toggle('platform-linux', info.platform === 'linux');
    this.state.settings = settings;
    this.state.library = {
      guides: library.guides || [],
      folders: library.folders?.folders || [],
      guideFolders: library.folders?.guideFolders || {},
    };
    this.state.trash = trash;
    this.editor.setSettings(settings);
    if (this.state.view === 'welcome') this.renderWelcome();
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

  async flushEditorBeforeNavigation() {
    if (this.editor.pendingSave || this.editor.pendingGuideSave) {
      try {
        await this.editor.saveAll();
      } catch (err) {
        toast(err.message, { error: true });
        return false;
      }
      if (this.editor.pendingSave || this.editor.pendingGuideSave) return false;
    }
    return true;
  }

  async showWelcome() {
    if (!await this.flushEditorBeforeNavigation()) return;
    this.editor.setActive(false);
    this.setView('welcome');
    this.renderWelcome();
    try {
      await this.refreshLibrary();
    } catch (err) {
      console.error(err);
    }
  }

  renderWelcome() {
    this.setView('welcome');
    clearNode(this.welcomeHost);
    this.welcomeHost.append(
      el('div.welcome', {},
        el('div.welcome-title', {},
          el('h1', {}, 'StepForge'),
          el('p.muted', {}, t('Capture, annotate, and export step-by-step guides.')),
        ),
        this.renderRecentGuides(),
        el('div.welcome-actions', {},
          el('button.welcome-btn.primary', {
            type: 'button',
            onClick: () => this.startNewCapture(),
          },
          el('span.welcome-btn-label', {}, t('New Capture')),
          el('span.welcome-btn-hint', {}, t('Start a guide and capture your screen')),
          ),
          el('button.welcome-btn', {
            type: 'button',
            onClick: () => this.openExistingWorkspace(),
          },
          el('span.welcome-btn-label', {}, t('Existing Workspace')),
          el('span.welcome-btn-hint', {}, t('Browse your guide library')),
          ),
          el('button.welcome-btn', {
            type: 'button',
            onClick: () => this.openSettings(),
          },
          el('span.welcome-btn-label', {}, t('Settings')),
          el('span.welcome-btn-hint', {}, t('Theme, capture, and export options')),
          ),
        ),
      ),
    );
  }

  renderRecentGuides() {
    // The library already returns guides in descending updatedAt order.
    const guides = this.state.library.guides.slice(0, 3);
    if (!guides.length) return null;
    return el('section.welcome-recent', { 'aria-labelledby': 'recent-guides-heading' },
      el('h2#recent-guides-heading', {}, t('Recent guides')),
      el('ul', {}, guides.map((guide) => el('li', {},
        el('button.welcome-recent-guide', {
          type: 'button',
          title: guide.title,
          onClick: () => this.openGuideAndArmCapture(guide.guideId),
        },
        el('span.welcome-recent-details', {},
          el('span.welcome-recent-title', {}, guide.title),
          el('span.muted', {}, `${guide.stepCount} ${guide.stepCount === 1 ? 'step' : 'steps'} • ${fmtDate(guide.updatedAt)}`),
        ),
        el('span.muted', { 'aria-hidden': 'true' }, '›'),
        ),
      ))),
    );
  }

  async startNewCapture() {
    const guide = await api.library.create({ title: t('Untitled capture'), captureDraft: true });
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
    if (!await this.flushEditorBeforeNavigation()) return;
    this.editor.setActive(false);
    this.setView('library');
    if (reason === 'new') {
      await this.createGuide();
      return;
    }
    await this.refreshData();
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

  renderCloudStatus(status) {
    // Cloud sync is opt-in: only users who are signed in with sync on see it.
    this.cloudStatus.classList.toggle('hidden', !(status.connected && status.enabled));
    this.cloudProvider = status.provider || 'google';
    const short = status.providerShort || 'Drive';
    const name = status.providerLabel || 'Google Drive';
    const labels = { synced: t('synced'), syncing: t('syncing…'), pending: t('pending'), error: t('needs attention') };
    const transfer = status.transfer ? describeTransfer(status.transfer) : null;
    this.cloudStatus.textContent = transfer ? `${short}: ${transfer.arrow} ${transfer.compact}` : labels[status.phase] ? `${short}: ${labels[status.phase]}` : name;
    this.cloudStatus.title = transfer?.detail || status.error || status.message || t('{service} settings', { service: name });
    this.cloudStatus.classList.toggle('transferring', Boolean(transfer));
    this.cloudStatus.style.setProperty('--transfer-progress', `${transfer?.percent || 0}%`);
    this.cloudStatus.setAttribute('aria-label', this.cloudStatus.title);
  }

  onEditorMeta(meta) {
    api.cloud.setEditorDirty(Boolean(meta?.dirty));
    this.editorMeta = meta;
    if (this.state.view === 'editor') this.renderTopbar();
    this.updateCaptureState(this.captureState || null);
  }

  /** Problems the recorder reports while it runs. Only ones the user can act on are shown. */
  onCaptureDiagnostic(payload) {
    if (payload && payload.kind === 'window-mode-unavailable' && payload.reason) {
      toast(payload.reason, { error: true });
    }
  }

  updateCaptureState(state) {
    this.captureState = state || { active: false };
    clearNode(this.captureStatus);
    // The capture bar is editor-only — hide it everywhere else (library, welcome).
    if (this.state.view !== 'editor') {
      this.captureStatus.classList.add('hidden');
      return;
    }
    this.captureStatus.classList.remove('hidden');
    const s = this.captureState;

    // No active session: show a button to start a new one for the open guide.
    if (!s.active) {
      this.captureStatus.append(
        el('span', {}, t('Recording - stopped')),
        el('button', {
          type: 'button',
          onClick: () => this.armCaptureSession(this.editor.guideId),
        }, t('New recording')),
      );
      return;
    }

    const send = (payload) => api.capture.session(payload).then((next) => this.updateCaptureState(next));

    // What is currently triggering captures, so the user knows what to do.
    const notStarted = s.paused && !s.count;
    const trigger = s.gnomeRequired && s.warmingUp ? t('waiting for screen sharing')
      : notStarted ? t('ready')
      : s.paused ? t('paused')
        : s.clickCapture ? t('on click')
          : s.intervalSec > 0 ? t('every {seconds}s', { seconds: s.intervalSec })
            : t('hotkey only');

    const pauseBtn = el('button', {
      type: 'button',
      title: notStarted ? t('StepForge tucks away and starts capturing') : '',
      onClick: async () => {
        if (notStarted) {
          const acknowledged = await dialogs.showRecordingReminder();
          if (!acknowledged) return;
        }
        send({ action: s.paused ? 'resume' : 'pause' });
      },
    }, s.paused ? t('Start recording') : t('Stop recording'));

    this.captureStatus.append(
      el('span', { title: t('Capture session — {trigger}', { trigger }) }, t('Recording - {trigger}', { trigger })),
      // Settings says Window but this desktop can only record the full screen:
      // say so before the first capture, since other windows will be in it.
      // Native append() prints null as "null", so leave the note out instead.
      ...(s.modeNote ? [el('span.capture-mode-note', { title: s.modeNote }, t('Full screen (window capture unavailable)'))] : []),
      pauseBtn,
    );
  }

  renderTopbar() {
    clearNode(this.topbarContext);
    if (this.state.view === 'welcome') return;
    if (this.state.view === 'library') {
      // Library actions live in the library header; only app-wide ones here.
      this.topbarContext.append(el('button', { type: 'button', onClick: () => this.openSettings() }, t('Settings')));
      return;
    }

    const guide = this.editorMeta?.guide;
    this.topbarContext.append(
      el('button', { type: 'button', onClick: () => this.showLibrary() }, t('Library')),
      el('button.primary', {
        type: 'button',
        title: t('Capture a screenshot step'),
        onClick: (e) => this.editor.openCaptureMenu(e),
      }, t('Capture ▾')),
      el('button', { type: 'button', onClick: () => this.editor.saveAll() }, t('Save')),
      el('button', { type: 'button', onClick: () => this.editor.openExportDialog() }, t('Export')),
      el('button', {
        type: 'button',
        title: t('Share this guide as a file or on the web'),
        onClick: (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          contextMenu(rect.left, rect.bottom + 4, [
            { label: t('Save as a .sfgz file…'), action: () => this.editor.shareAsFile() },
            { label: t('Publish to the web…'), action: () => this.publishToWeb(guide?.guideId || this.editor.guideId, guide?.title) },
            { label: t('Publish to Confluence…'), badge: 'Beta', action: () => this.publishToConfluence(guide?.guideId || this.editor.guideId, guide?.title) },
            { label: t('Publish to Wiki.js…'), badge: 'Beta', action: () => this.publishToWikiJs(guide?.guideId || this.editor.guideId, guide?.title) },
          ]);
        },
      }, t('Share ▾')),
      el('button', {
        type: 'button',
        className: this.editorMeta?.aiProgress ? 'ai-busy' : '',
        title: this.editorMeta?.aiProgress ? t('AI is writing. Click to stop.') : t('Let AI write this guide'),
        onClick: (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          contextMenu(rect.left, rect.bottom + 4, this.editor.aiMenuItems());
        },
      }, this.editorMeta?.aiProgress ? `AI · ${this.editorMeta.aiProgress}` : t('AI ▾')),
      el('button', {
        type: 'button',
        onClick: (e) => {
          const rect = e.target.getBoundingClientRect();
          contextMenu(rect.left, rect.bottom + 4, [
            { label: t('Rename guide…'), action: () => this.renameGuide() },
            { label: t('Guide information…'), action: () => this.editor.openGuideInfo() },
            { label: t('Guide placeholders…'), action: () => this.editor.openGuidePlaceholders() },
            { label: t('Backups & snapshots…'), action: () => this.editor.openBackupsDialog() },
            { label: t('Find private details…'), action: () => this.editor.findPrivateDetails() },
            { label: guide && guide.linkedSource ? t('Linked guide…') : t('Linked guide (not linked)'), action: () => this.editor.openLinkedGuide() },
            'sep',
            { label: t('Keyboard shortcuts…'), action: () => this.editor.openShortcutsHelp() },
            { label: t('Quick actions  (Ctrl+/)'), action: () => this.editor.openQuickActions() },
            { label: t('Settings…'), action: () => this.openSettings() },
          ]);
        },
      }, t('More ▾')),
      el('span.muted', { style: { marginLeft: '8px' } }, guide ? `${guide.title} · ${this.editorMeta?.stepCount || 0} steps` : ''),
    );
  }

  async renderLibrary() {
    this.setView('library');
    this.editor.setActive(false);
    clearNode(this.libraryHost);
    const q = this.state.query.trim();
    const trash = this.state.folderFilter === 'trash';
    // Selecting only makes sense for the guide grid and the trash — drop out
    // of select mode for search results.
    const canSelect = !q;
    if (!canSelect && this.state.selectMode) {
      this.state.selectMode = false;
      this.state.selectedGuides = new Set();
      this.state.selectedTrash = new Set();
    }
    const count = trash ? this.state.trash.length : this.state.library.guides.filter((guide) => this.scopeGuide(guide)).length;
    const subtitle = q ? t('Results for “{query}”', { query: q })
      : trash ? tn(count, '{count} deleted guide', '{count} deleted guides') : tn(count, '{count} guide', '{count} guides');
    const folders = this.renderFolderItems(this.state.library.folders || [], null, 0);
    const body = el('div.library', {},
      el('aside.lib-side', {},
        el('div.lib-side-section', {},
          this.libraryNavItem('all', t('All guides'), this.state.library.guides.length),
          this.libraryNavItem('favorites', t('Favorites'), this.state.library.guides.filter((g) => g.favorite).length),
        ),
        el('div.lib-side-head', {},
          el('h3', {}, t('Folders')),
          el('button.icon.lib-add-folder', { type: 'button', title: t('New folder'), 'aria-label': t('New folder'), onClick: () => this.createFolder() }, '+'),
        ),
        el('div.lib-side-section', {}, ...(folders.length ? folders : [el('div.lib-side-empty', {}, t('No folders yet'))])),
        el('div.lib-side-footer', {}, this.libraryNavItem('trash', t('Trash'), this.state.trash.length)),
      ),
      el('main.lib-main', {},
        el('header.lib-header', {},
          el('div.lib-title', {},
            el('h2', {}, this.filterLabel()),
            el('div.muted', {}, subtitle),
          ),
          el('div.lib-header-actions', {},
            canSelect && count ? el('button', {
              type: 'button',
              className: this.state.selectMode ? 'primary' : '',
              'aria-pressed': String(this.state.selectMode),
              onClick: () => this.toggleSelectMode(),
            }, t('Select')) : null,
            trash && count && !this.state.selectMode ? el('button.danger', { type: 'button', onClick: () => this.purgeTrashItem() }, t('Empty trash')) : null,
            trash ? null : el('button', { type: 'button', onClick: (e) => this.openImportMenu(e) }, t('Import ▾')),
            trash ? null : el('button.primary', { type: 'button', onClick: () => this.createGuide() }, t('New guide')),
          ),
        ),
        this.domBulkBar = el('div', {}),
        this.domLibraryResults = el('div', {}),
      ),
    );
    this.libraryHost.append(body);

    if (q) {
      await this.renderSearchResults();
    } else if (trash) {
      this.renderTrashView();
    } else {
      this.renderGuideGrid();
    }
    this.renderBulkBar();
    this.renderTopbar();
  }

  openImportMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom + 4, [
      { label: t('Import a copy of a guide (.sfgz)…'), action: () => this.importArchive('copy') },
      { label: t('Open a linked guide (.sfgz)…'), action: () => this.importArchive('linked') },
    ]);
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
      { label: t('Rename folder'), action: () => this.renameFolder(folderId) },
      { label: t('Delete folder'), danger: true, action: () => this.deleteFolder(folderId) },
    ]);
  }

  filterLabel() {
    if (this.state.folderFilter === 'all') return t('All guides');
    if (this.state.folderFilter === 'favorites') return t('Favorites');
    if (this.state.folderFilter === 'trash') return t('Trash');
    const folder = (this.state.library.folders || []).find((f) => f.id === this.state.folderFilter);
    return folder ? folder.name : t('All guides');
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
      this.domLibraryResults.append(el('div.empty-state', {}, el('div.big', {}, t('Search')), t('No results for this query.')));
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

  visibleGuides() {
    return this.state.library.guides.filter((guide) => this.scopeGuide(guide));
  }

  emptyState(title, text, action = null) {
    return el('div.empty-state', {}, el('div.empty-title', {}, title), el('div', {}, text), action);
  }

  renderGuideGrid() {
    const guides = this.visibleGuides();
    clearNode(this.domLibraryResults);
    if (!guides.length) {
      const filter = this.state.folderFilter;
      this.domLibraryResults.append(filter === 'all'
        ? this.emptyState(t('No guides yet'), t('Create a guide and start capturing steps, or import one someone shared with you.'),
          el('button.primary', { type: 'button', onClick: () => this.createGuide() }, t('New guide')))
        : filter === 'favorites'
          ? this.emptyState(t('No favorites'), t('Star a guide to keep it here.'))
          : this.emptyState(t('This folder is empty'), t('Right-click a guide, or select guides, to move them here.')));
      return;
    }
    this.domLibraryResults.append(el('div.guide-grid', {}, ...guides.map((guide) => this.guideCard(guide))));
  }

  renderTrashView() {
    clearNode(this.domLibraryResults);
    if (!this.state.trash.length) {
      const days = this.state.settings?.library?.trashDays ?? 30;
      this.domLibraryResults.append(this.emptyState(t('Trash is empty'), days > 0
        ? tn(days, 'Deleted guides stay here for {count} day, then are deleted for good. Change this in Settings → General.',
          'Deleted guides stay here for {count} days, then are deleted for good. Change this in Settings → General.')
        : t('Deleted guides stay here until you empty the trash.')));
      return;
    }
    const selectMode = this.state.selectMode;
    const items = this.state.trash.map((item) => {
      const selected = this.state.selectedTrash.has(item.name);
      const countdown = trashCountdown(item, this.state.settings?.library);
      return el('div.guide-card.trash-card', {
        className: `guide-card trash-card${selected ? ' selected' : ''}${selectMode ? ' selecting' : ''}`,
        onClick: () => {
          if (selectMode) this.toggleTrashSelection(item.name);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          if (selectMode) return;
          contextMenu(e.clientX, e.clientY, [
            { label: t('Restore'), action: () => this.restoreTrashItem(item.name) },
            'sep',
            { label: t('Empty trash'), danger: true, action: () => this.purgeTrashItem() },
          ]);
        },
      },
      selectMode ? this.selectionCheck(selected, (e) => {
        e.stopPropagation();
        this.toggleTrashSelection(item.name);
      }) : null,
      el('h4', {}, item.title),
      countdown ? el('div.trash-countdown', {}, countdown) : null,
      el('div.card-footer', {},
        el('span', {}, `${item.stepCount} step${item.stepCount === 1 ? '' : 's'}`),
        item.deletedAt ? el('span', {}, t('Deleted {when}', { when: timeAgo(item.deletedAt) })) : null,
        el('button.card-restore', { type: 'button', onClick: (e) => { e.stopPropagation(); this.restoreTrashItem(item.name); } }, t('Restore'))));
    });
    this.domLibraryResults.append(el('div.guide-grid', {}, ...items));
  }

  selectionCheck(selected, onClick) {
    return el('button.select-check', {
      type: 'button',
      className: `select-check${selected ? ' on' : ''}`,
      role: 'checkbox',
      'aria-checked': String(selected),
      'aria-label': selected ? t('Deselect') : t('Select'),
      title: selected ? t('Deselect') : t('Select'),
      onClick,
    }, selected ? '✓' : '');
  }

  guideCard(guide) {
    const folderId = (this.state.library.guideFolders || {})[guide.guideId] || null;
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    // The folder is only worth showing when the view isn't already that folder.
    const showFolder = folder && this.state.folderFilter !== folder.id;
    const selectMode = this.state.selectMode;
    const selected = this.state.selectedGuides.has(guide.guideId);
    const description = (guide.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const steps = guide.stepCount || 0;
    const reviewState = review.reviewStatus(guide, this.state.settings?.library?.reviewAfterDays);
    return el('div.guide-card', {
      className: `guide-card${selected ? ' selected' : ''}${selectMode ? ' selecting' : ''}`,
      title: selectMode ? '' : t('Open guide · Ctrl-click to select'),
      onClick: (e) => {
        // Ctrl/Cmd-click starts or extends a selection; Shift-click selects a range.
        if (selectMode || e.ctrlKey || e.metaKey || e.shiftKey) this.selectGuideFromClick(guide.guideId, e);
        else this.openGuideAndArmCapture(guide.guideId);
      },
      onContextMenu: (e) => {
        e.preventDefault();
        if (selectMode) return;
        this.guideContextMenu(e, guide);
      },
    },
    selectMode ? this.selectionCheck(selected, (e) => {
      e.stopPropagation();
      this.selectGuideFromClick(guide.guideId, e, { toggle: true });
    }) : null,
    el('button.fav', {
      type: 'button',
      className: `fav${guide.favorite ? ' on' : ''}`,
      title: guide.favorite ? t('Remove from favorites') : t('Add to favorites'),
      'aria-label': guide.favorite ? t('Remove from favorites') : t('Add to favorites'),
      'aria-pressed': String(Boolean(guide.favorite)),
      onClick: async (e) => {
        e.stopPropagation();
        if (selectMode) return;
        await api.library.setFavorite({ guideId: guide.guideId, favorite: !guide.favorite });
        await this.refreshLibrary();
      },
    }, '★'),
    el('h4', {}, guide.title || t('Untitled guide')),
    description ? el('div.snippet', {}, description) : null,
    el('div.card-footer', {},
      el('span', {}, `${steps} step${steps === 1 ? '' : 's'}`),
      showFolder ? el('span.card-folder', {}, folder.name) : null,
      guide.linkedSource ? el('span.badge', { title: t('Saved to a linked .sfgz file') }, t('Linked')) : null,
      guide.locked ? el('span.badge', { title: t('Open on another device') }, t('Locked')) : null,
      reviewState?.overdue ? el('span.badge.review-badge', { title: reviewBadgeTitle(reviewState) }, t('May need review')) : null,
      el('span.card-updated', { title: fmtDate(guide.updatedAt) }, timeAgo(guide.updatedAt))));
  }

  resultCard(result, guide, isStep) {
    return el('div.guide-card', {
      onClick: () => this.openGuideAndArmCapture(result.guideId, result.stepId || null),
    },
    isStep ? el('div.card-eyebrow', {}, guide.title) : null,
    el('h4', {}, result.title || guide.title),
    result.snippet ? el('div.snippet', {}, result.snippet) : null,
    el('div.card-footer', {}, el('span.badge', {}, isStep ? t('Step') : t('Guide'))));
  }

  guideContextMenu(event, guide) {
    const currentFolderId = (this.state.library.guideFolders || {})[guide.guideId] || null;
    const folderItems = (this.state.library.folders || [])
      .filter((folder) => folder.id !== currentFolderId)
      .map((folder) => ({
        label: t('Move to {folder}', { folder: folder.name }),
        action: () => this.moveGuideToFolder(guide.guideId, folder.id),
      }));
    if (currentFolderId) folderItems.push({ label: t('Move to no folder'), action: () => this.moveGuideToFolder(guide.guideId, null) });
    const moveItems = folderItems.length ? ['sep', ...folderItems] : [];
    contextMenu(event.clientX, event.clientY, [
      { label: t('Open guide'), action: () => this.openGuideAndArmCapture(guide.guideId) },
      { label: t('Rename guide…'), action: () => this.renameGuide(guide) },
      { label: guide.favorite ? t('Unfavorite') : t('Favorite'), action: () => this.toggleFavorite(guide) },
      { label: t('Mark as verified'), action: () => this.markVerified([guide.guideId]) },
      { label: t('Duplicate guide'), action: () => this.duplicateGuide(guide.guideId) },
      { label: t('Export'), action: () => this.openGuideExport(guide.guideId) },
      { label: t('Publish to the web…'), action: () => this.publishToWeb(guide.guideId, guide.title) },
      { label: t('Publish to Confluence…'), badge: 'Beta', action: () => this.publishToConfluence(guide.guideId, guide.title) },
      { label: t('Publish to Wiki.js…'), badge: 'Beta', action: () => this.publishToWikiJs(guide.guideId, guide.title) },
      ...moveItems,
      'sep',
      { label: t('Delete guide'), danger: true, action: () => this.deleteGuide(guide.guideId) },
    ]);
  }

  toggleSelectMode() {
    this.state.selectMode = !this.state.selectMode;
    this.state.selectedGuides = new Set();
    this.state.selectedTrash = new Set();
    this.lastSelectedGuide = null;
    this.renderLibrary();
  }

  /** Card click in select mode (or with Ctrl/Cmd/Shift): toggle, or select a Shift range. */
  selectGuideFromClick(guideId, event = {}, { toggle = false } = {}) {
    const entering = !this.state.selectMode;
    this.state.selectMode = true;
    const order = this.visibleGuides().map((g) => g.guideId);
    const anchor = order.indexOf(this.lastSelectedGuide);
    if (event.shiftKey && !toggle && anchor >= 0) {
      const at = order.indexOf(guideId);
      for (const id of order.slice(Math.min(anchor, at), Math.max(anchor, at) + 1)) this.state.selectedGuides.add(id);
    } else if (this.state.selectedGuides.has(guideId)) {
      this.state.selectedGuides.delete(guideId);
    } else {
      this.state.selectedGuides.add(guideId);
    }
    this.lastSelectedGuide = guideId;
    if (entering) this.renderLibrary();
    else { this.renderGuideGrid(); this.renderBulkBar(); }
  }

  toggleGuideSelection(guideId) {
    this.selectGuideFromClick(guideId, {}, { toggle: true });
  }

  selectAllGuides() {
    this.state.selectedGuides = new Set(this.visibleGuides().map((g) => g.guideId));
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
    this.state.selectedTrash = new Set(this.state.trash.map((item) => item.name));
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
    const ok = await confirmDialog(tn(names.length, 'Permanently delete {count} item? This cannot be undone.', 'Permanently delete {count} items? This cannot be undone.'), { danger: true, okLabel: t('Delete forever') });
    if (!ok) return;
    await api.library.trashPurge({ names });
    this.state.selectedTrash = new Set();
    await this.refreshLibrary();
  }

  renderBulkBar() {
    if (!this.domBulkBar) return;
    clearNode(this.domBulkBar);
    if (!this.state.selectMode) return;
    const bar = (n, total, allSelected, onToggleAll, actions) => el('div.bulk-bar', { role: 'toolbar', 'aria-label': t('Selection actions') },
      el('span.bulk-count', {}, n ? t('{count} of {total} selected', { count: n, total }) : t('Click guides to select them')),
      el('button.link', { type: 'button', onClick: onToggleAll }, allSelected ? t('Clear') : t('Select all')),
      el('span.spacer', {}),
      ...actions);
    if (this.state.folderFilter === 'trash') {
      const n = this.state.selectedTrash.size;
      const total = this.state.trash.length;
      const allSelected = total > 0 && n === total;
      this.domBulkBar.append(bar(n, total, allSelected, () => (allSelected ? this.clearTrashSelection() : this.selectAllTrash()), [
        el('button', { type: 'button', disabled: !n, onClick: () => this.bulkRestoreTrash() }, t('Restore')),
        el('button.danger', { type: 'button', disabled: !n, onClick: () => this.bulkPurgeTrash() }, t('Delete forever')),
      ]));
      return;
    }
    const guides = this.visibleGuides();
    const n = this.state.selectedGuides.size;
    const allSelected = guides.length > 0 && n === guides.length;
    const selected = guides.filter((g) => this.state.selectedGuides.has(g.guideId));
    const allFavorite = selected.length > 0 && selected.every((g) => g.favorite);
    this.domBulkBar.append(bar(n, guides.length, allSelected, () => (allSelected ? this.clearSelection() : this.selectAllGuides()), [
      el('button', { type: 'button', disabled: !n, onClick: () => this.bulkSetFavorite(!allFavorite) }, allFavorite ? t('Unfavorite') : t('Favorite')),
      el('button', { type: 'button', disabled: !n, onClick: (e) => this.openBulkMoveMenu(e) }, t('Move to ▾')),
      el('button', { type: 'button', disabled: !n, title: t('Record that these guides still match the software today'), onClick: () => this.markVerified([...this.state.selectedGuides]) }, t('Mark as verified')),
      el('button.danger', { type: 'button', disabled: !n, onClick: () => this.bulkDelete() }, t('Delete')),
    ]));
  }

  openBulkMoveMenu(event) {
    const rect = event.target.getBoundingClientRect();
    const folderItems = (this.state.library.folders || []).map((folder) => ({
      label: folder.name,
      action: () => this.bulkMoveToFolder(folder.id),
    }));
    contextMenu(rect.left, rect.bottom + 4, [
      { label: t('No folder'), action: () => this.bulkMoveToFolder(null) },
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
    const ok = await confirmDialog(tn(ids.length,
      'Delete {count} guide? It moves to Trash. If it syncs to the cloud, it is also removed from your other devices, with one cloud recovery snapshot retained.',
      'Delete {count} guides? They’ll move to Trash. Guides that sync to the cloud are also removed from your other devices, with one cloud recovery snapshot retained.'), { danger: true, okLabel: t('Delete') });
    if (!ok) return;
    await Promise.all(ids.map((guideId) => api.library.delete({ guideId })));
    this.state.selectedGuides = new Set();
    await this.refreshLibrary();
  }

  async createGuide() {
    const title = await dialogs.promptText({
      title: t('New Guide'),
      label: t('Title'),
      value: t('Untitled guide'),
      placeholder: t('Untitled guide'),
    });
    if (title == null) return;
    const guide = await api.library.create({ title: title.trim() || t('Untitled guide'), captureDraft: !title.trim() || title.trim() === t('Untitled guide') });
    await this.refreshLibrary();
    // Arm a (paused) capture session like every other open path, so the
    // "Start recording" bar appears and actually controls this new guide.
    // Without this, a guide created from the library opened with no session,
    // so Start recording had nothing to resume (or resumed a stale one).
    await this.openGuideAndArmCapture(guide.guideId);
  }

  async createFolder() {
    const name = await dialogs.promptText({ title: t('New folder'), label: t('Folder name'), value: '' });
    if (name == null || !name.trim()) return;
    await api.folders.create({ name: name.trim(), parentId: null });
    await this.refreshLibrary();
  }

  async renameFolder(folderId) {
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    if (!folder) return;
    const name = await dialogs.promptText({ title: t('Rename folder'), label: t('Folder name'), value: folder.name });
    if (name == null || !name.trim()) return;
    await api.folders.rename({ folderId, name: name.trim() });
    await this.refreshLibrary();
  }

  async deleteFolder(folderId) {
    const folder = (this.state.library.folders || []).find((f) => f.id === folderId);
    if (!folder) return;
    const ok = await confirmDialog(t('Delete the folder “{folder}”? Guides stay in the library.', { folder: folder.name }));
    if (!ok) return;
    await api.folders.delete({ folderId });
    await this.refreshLibrary();
  }

  async moveGuideToFolder(guideId, folderId) {
    await api.folders.moveGuide({ guideId, folderId });
    await this.refreshLibrary();
  }

  async markVerified(guideIds) {
    if (!guideIds.length) return;
    await api.library.markVerified({ guideIds });
    await this.refreshLibrary();
    toast(guideIds.length === 1 ? t('Marked as verified today.') : t('{count} guides marked as verified today.', { count: guideIds.length }));
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
    const ok = await confirmDialog(t('Delete “{title}”? It moves to Trash. If it syncs to the cloud, it is also removed from your other devices and one cloud recovery snapshot is retained.', { title: guide.title }), { danger: true, okLabel: t('Delete') });
    if (!ok) return;
    await api.library.delete({ guideId });
    await this.refreshLibrary();
  }

  async restoreTrashItem(name) {
    await api.library.trashRestore({ name });
    await this.refreshLibrary();
  }

  async purgeTrashItem() {
    const ok = await confirmDialog(t('Permanently empty the trash?'), { danger: true, okLabel: t('Empty trash') });
    if (!ok) return;
    await api.library.trashPurge();
    await this.refreshLibrary();
  }

  /** Publish a guide to the user's GitHub Pages site (Settings → Accounts → GitHub). */
  async publishToWeb(guideId, title) {
    if (!guideId) return;
    // Publish what the user sees, including edits still waiting to be saved.
    if (this.state.view === 'editor' && this.editor.guideId === guideId) await this.editor.saveAll();
    let finding = null;
    await showPublishToWebDialog({
      api,
      guideId,
      guideTitle: title || t('Untitled guide'),
      onOpenAccounts: () => this.openSettings('github'),
      onShowFinding: (picked) => { finding = picked; },
    });
    // Checking for private details may have added blurs to the open guide.
    if (this.state.view === 'editor' && this.editor.guideId === guideId) await this.editor.reload();
    if (finding) await this.showQualityFinding(guideId, finding);
  }

  /** Publish a guide as a Confluence page (Settings → Accounts → Confluence). */
  async publishToConfluence(guideId, title) {
    if (!guideId) return;
    const inEditor = this.state.view === 'editor' && this.editor.guideId === guideId;
    if (inEditor) await this.editor.saveAll();
    let finding = null;
    const changed = await showPublishToConfluenceDialog({
      api,
      guideId,
      guideTitle: title || t('Untitled guide'),
      onOpenAccounts: () => this.openSettings('confluence'),
      onShowFinding: (picked) => { finding = picked; },
    });
    // Checking for private details may have added blurs to the open guide.
    if (changed && inEditor) await this.editor.reload();
    if (finding) await this.showQualityFinding(guideId, finding);
  }

  /** Publish a guide as a Wiki.js page (Settings → Accounts → Wiki.js). */
  async publishToWikiJs(guideId, title) {
    if (!guideId) return;
    const inEditor = this.state.view === 'editor' && this.editor.guideId === guideId;
    if (inEditor) await this.editor.saveAll();
    let finding = null;
    const changed = await showPublishToWikiJsDialog({
      api,
      guideId,
      guideTitle: title || t('Untitled guide'),
      onOpenAccounts: () => this.openSettings('wikijs'),
      onShowFinding: (picked) => { finding = picked; },
    });
    // Checking for private details may have added blurs to the open guide.
    if (changed && inEditor) await this.editor.reload();
    if (finding) await this.showQualityFinding(guideId, finding);
  }

  /** Open a guide (publishing also works from the library) at a quality-check finding. */
  async showQualityFinding(guideId, finding) {
    if (this.state.view !== 'editor' || this.editor.guideId !== guideId) await this.openGuide(guideId);
    await this.editor.showQualityFinding(finding);
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
    const title = await dialogs.promptText({ title: t('Rename guide'), label: t('Title'), value: guide.title });
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

  async openSettings(section) {
    const settings = await api.settings.all();
    const placeholders = await api.settings.globalPlaceholders();
    let newLanguage = null;
    await dialogs.showSettingsDialog({
      api,
      settings,
      placeholders,
      section,
      // Shared guides → "Edited since you shared it" publishes like the toolbar does.
      onPublishToWeb: (guideId, title) => this.publishToWeb(guideId, title),
      // Update now closes StepForge; save the open guide first.
      flushEdits: () => this.flushEditorBeforeNavigation(),
      onSave: async (next) => {
        await api.settings.set({ keyPath: 'appearance', value: next.appearance });
        await api.settings.set({ keyPath: 'spellcheck', value: next.spellcheck });
        await api.settings.set({ keyPath: 'capture', value: next.capture });
        await api.settings.set({ keyPath: 'editor', value: next.editor });
        await api.settings.set({ keyPath: 'ai', value: next.ai });
        await api.settings.set({ keyPath: 'redaction', value: next.redaction });
        await api.settings.set({ keyPath: 'exports', value: next.exports });
        await api.settings.set({ keyPath: 'branding', value: next.branding });
        await api.settings.set({ keyPath: 'backups', value: next.backups });
        await api.settings.set({ keyPath: 'library', value: next.library });
        await api.settings.setGlobalPlaceholders(next.placeholders || {});
        this.state.settings = await api.settings.all();
        if (next.language !== settings.language) newLanguage = next.language;
      },
    });
    // A new language reloads the window in it, so open edits are saved first.
    if (newLanguage && await this.flushEditorBeforeNavigation()) {
      const result = await api.app.setLanguage({ language: newLanguage });
      if (result.reloaded) return;
    }
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
      { kind: 'cmd', label: t('New guide'), description: t('Create a blank guide'), action: () => this.createGuide() },
      { kind: 'cmd', label: t('Import archive'), description: t('Open a .sfgz guide archive'), action: () => this.importArchive('copy') },
      { kind: 'cmd', label: t('Open linked archive'), description: t('Import a linked guide from .sfgz'), action: () => this.importArchive('linked') },
      { kind: 'cmd', label: t('Settings'), description: t('Open application settings'), action: () => this.openSettings() },
      { kind: 'cmd', label: t('Refresh library'), description: t('Reload guides and folders'), action: () => this.refreshLibrary() },
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

// Links never navigate this window. http(s)/mailto links from guide content
// open externally via the scheme-validated main-process handler; internal
// step:/# links are handled by their own click handlers; everything else is
// inert. The main process additionally denies all navigation, so this is the
// user-experience half of a two-layer guarantee.
document.addEventListener('click', (e) => {
  const anchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!anchor) return;
  const href = anchor.getAttribute('href') || '';
  if (/^(https?|mailto):/i.test(href)) {
    e.preventDefault();
    api.shell.openExternal({ url: href });
    return;
  }
  // Ensure a stray href can never navigate the privileged window.
  if (!href.startsWith('#')) e.preventDefault();
}, true);

function boot() {
  // index.html's own text, in the interface language.
  document.documentElement.lang = uiLanguage;
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.title);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.placeholder);
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.getAttribute('aria-label')));
  const app = new StepForgeApp();
  app.init();
  window.stepforgeApp = app;
}

boot();
})();
