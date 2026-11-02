'use strict';

const path = require('node:path');
const os = require('node:os');
const { supportsCaptureExclusion, verifyCaptureExclusion } = require('./windows-capture-exclusion');
const { installWindowSecurity, isAppPageUrl } = require('./security');

const SIZE = { width: 460, height: 48 };
// Verifiers that already saw Windows exclude a bar. The result holds for the
// life of the process, so later recordings skip the slow PowerShell check.
const confirmedVerifiers = new WeakSet();

function recordingControlsMode(platform, value) {
  return platform === 'win32' && value !== 'tray' ? 'floating' : 'tray';
}

function barBounds(position, displays, primary) {
  const fits = (area) => position && Number.isFinite(position.x) && Number.isFinite(position.y)
    && position.x >= area.x && position.y >= area.y
    && position.x + SIZE.width <= area.x + area.width && position.y + SIZE.height <= area.y + area.height;
  if (displays.some((display) => fits(display.workArea || display.bounds))) {
    return { x: Math.round(position.x), y: Math.round(position.y), ...SIZE };
  }
  const area = primary.workArea || primary.bounds;
  return { x: Math.round(area.x + (area.width - SIZE.width) / 2), y: area.y + 12, ...SIZE };
}

class RecordingControls {
  constructor({ settings, getState, onPause, onFinish, onGesture, onUnavailable,
    electron = require('electron'), platform = process.platform, release = os.release(),
    verify = verifyCaptureExclusion, log = console.warn }) {
    Object.assign(this, { settings, getState, onPause, onFinish, onGesture, onUnavailable, electron, platform, release, verify, log });
    this.win = null;
    this.started = false;
    this.ready = false;
    this.closed = false;
    this.suspended = 0;
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    try {
      if (!supportsCaptureExclusion(this.platform, this.release)) throw new Error('Windows 10 build 19041 or later is required for capture exclusion');
      const { BrowserWindow, screen, nativeTheme, ipcMain } = this.electron;
      const bounds = barBounds(this.settings.get('capture.recordingBarPosition'), screen.getAllDisplays(), screen.getPrimaryDisplay());
      const win = this.win = new BrowserWindow({
        ...bounds, title: 'StepForge', show: false, opacity: 0, frame: false, resizable: false,
        minimizable: false, maximizable: false, fullscreenable: false,
        focusable: false, skipTaskbar: true, alwaysOnTop: true,
        roundedCorners: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff',
        webPreferences: {
          preload: path.join(__dirname, 'recording-controls-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
      });
      win.setContentProtection(true);
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      installWindowSecurity(win, 'recordingControls');
      this.onAction = (event, action) => {
        if (event.sender !== win.webContents || !event.senderFrame || event.senderFrame.parent
          || !isAppPageUrl(event.senderFrame.url, 'recordingControls')) return;
        if (!['gesture', 'pause', 'finish'].includes(action)) return;
        this.onGesture();
        if (action === 'pause') this.onPause();
        if (action === 'finish') this.onFinish();
      };
      ipcMain.on('recording-controls:action', this.onAction);
      this.onTheme = () => this.update();
      nativeTheme.on('updated', this.onTheme);
      this.onDisplays = () => this.reposition();
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, this.onDisplays);
      win.on('moved', () => {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.savePosition(), 200);
      });
      win.on('closed', () => { if (!this.closed) this.unavailable(new Error('control window closed')); });
      win.webContents.on('render-process-gone', () => this.unavailable(new Error('control renderer exited')));
      await win.loadFile(path.join(__dirname, 'renderer', 'recording-controls.html'));
      if (this.closed) return;
      // Chromium applies exclusion when the native window is first shown.
      // Keep it transparent and click-through until Windows confirms it.
      win.showInactive();
      if (!confirmedVerifiers.has(this.verify)) {
        if (!await this.verify(win)) throw new Error('Windows did not confirm WDA_EXCLUDEFROMCAPTURE');
        confirmedVerifiers.add(this.verify);
      }
      if (this.closed) return;
      if (this.suspended) win.hide();
      win.setIgnoreMouseEvents(false);
      win.setOpacity(1);
      this.ready = true;
      this.update();
    } catch (error) {
      if (!this.closed) this.unavailable(error);
    }
  }

  unavailable(error) {
    if (this.closed) return;
    this.log(`[stepforge] floating recording controls unavailable; using tray icon: ${error.message}`);
    this.destroy();
    this.onUnavailable();
  }

  update() {
    if (!this.ready || !this.win || this.win.isDestroyed()) return;
    const { app, nativeTheme } = this.electron;
    this.win.webContents.send('recording-controls:state', {
      ...this.getState(), dark: nativeTheme.shouldUseDarkColors,
      language: this.settings.get('language'), systemLocales: app.getPreferredSystemLanguages(),
    });
    if (!this.suspended && !this.win.isVisible()) this.win.showInactive();
  }

  contains(point) {
    if (!this.ready || !point || !this.win || this.win.isDestroyed() || !this.win.isVisible()) return false;
    const b = this.win.getBounds();
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  }

  suspend() {
    this.suspended += 1;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.suspended -= 1;
      this.update();
    };
  }

  reposition() {
    if (!this.win || this.win.isDestroyed()) return;
    const { screen } = this.electron;
    this.win.setBounds(barBounds(this.win.getBounds(), screen.getAllDisplays(), screen.getPrimaryDisplay()));
  }

  savePosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const { x, y } = this.win.getBounds();
    try {
      this.settings.set('capture.recordingBarPosition', { x, y });
    } catch (error) {
      this.log(`[stepforge] could not save recording bar position: ${error.message}`);
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.saveTimer);
    if (this.ready) this.savePosition();
    const { ipcMain, nativeTheme, screen } = this.electron;
    if (this.onAction) ipcMain.removeListener('recording-controls:action', this.onAction);
    if (this.onTheme) nativeTheme.removeListener('updated', this.onTheme);
    if (this.onDisplays) for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, this.onDisplays);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { RecordingControls, recordingControlsMode, barBounds };
