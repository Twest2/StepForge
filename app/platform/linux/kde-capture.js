'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const GnomeCaptureService = require('./gnome-capture');
const { PortalBackend } = require('./portal-backend');

// Plasma's panel, its tray and the menus they open belong to plasmashell. A
// click there may be the one that opens StepForge's tray menu or picks Pause
// or Finish in it, which must not become a step. Such a click waits until the
// next click elsewhere, a StepForge tray action (dropped), or this long (kept).
const PANEL_CLICK_HOLD_MS = 5000;

function runSpectacle(file) {
  return new Promise((resolve, reject) => {
    execFile('spectacle', ['--background', '--region', '--nonotify', '--output', file],
      { timeout: 125000 }, (error) => {
        if (error && error.code === 'ENOENT') {
          reject(new Error('Install Spectacle to select a region on KDE Plasma.'));
        } else if (error && !error.killed) {
          reject(new Error('Spectacle could not take the region screenshot.'));
        } else {
          resolve();
        }
      });
  });
}

/**
 * KDE Plasma 6 Wayland. The same consented portal stream and click pipeline
 * as GNOME (gnome-capture.js), with the click companion swapped for the KWin
 * script + input-device reader (kwin_companion.py), the Electron tray as the
 * recording controls, and Spectacle for region selection.
 */
class KdeCaptureService extends GnomeCaptureService {
  constructor(options) {
    super({
      backendFactory: () => new PortalBackend({ desktop: 'plasma' }),
      // The helper checks KWin and the input devices before the portal asks.
      ensureCompanion: async () => {},
      ...options,
    });
    this.armedClickSource = 'kwin-evdev';
    this.runSpectacle = options.runSpectacle || runSpectacle;
    this.panelHolds = [];
  }

  state() {
    return { ...super.state(), gnomeRequired: false, plasmaRequired: true, clickTiming: 'input-device' };
  }

  clickGate(event) {
    const onPanel = event.hitKind === 'panel' || /plasmashell/i.test(event.hitClass || '');
    if (!onPanel) {
      this.releasePanelClicks(true);
      return null;
    }
    return new Promise((resolve) => {
      const hold = { resolve };
      hold.timer = setTimeout(() => this.settleHold(hold, true), PANEL_CLICK_HOLD_MS);
      this.panelHolds.push(hold);
    });
  }

  settleHold(hold, keep) {
    clearTimeout(hold.timer);
    this.panelHolds = this.panelHolds.filter((entry) => entry !== hold);
    hold.resolve(keep);
  }

  releasePanelClicks(keep) {
    for (const hold of [...this.panelHolds]) this.settleHold(hold, keep);
  }

  noteUiStopGesture() {
    super.noteUiStopGesture();
    this.releasePanelClicks(false);
  }

  stopClickFrameBackend() {
    this.releasePanelClicks(false);
    super.stopClickFrameBackend();
  }

  // A click on the desktop or a panel has no window to cut out: keep the
  // screen and say so once, like the other desktops.
  async frameForClick(point, at, mode = 'fullscreen', windowRect = null) {
    const frame = await super.frameForClick(point, at, 'fullscreen');
    return mode === 'window' ? this.windowFrame(frame, windowRect) : frame;
  }

  async regionCapture(guideId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepforge-region-'));
    const file = path.join(dir, 'region.png');
    try {
      const png = await this.withWindowHidden(async () => {
        await this.runSpectacle(file);
        return fs.promises.readFile(file).catch(() => null);
      });
      if (!png) return { ok: false, reason: 'selection cancelled' };
      const size = this.imageFromPng(png).getSize();
      if (!size.width || !size.height) return { ok: false, reason: 'empty selection' };
      return await this.storeFrameAsStep(guideId, 'region', { mode: 'region', png, size, display: null, cursor: null });
    } catch (error) {
      return { ok: false, reason: error.message };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = KdeCaptureService;
module.exports.PANEL_CLICK_HOLD_MS = PANEL_CLICK_HOLD_MS;
