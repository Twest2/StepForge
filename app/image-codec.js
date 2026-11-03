'use strict';

const { BrowserWindow } = require('electron');

/**
 * Chromium's own image codecs, run in a hidden window: canvas toBlob('image/webp')
 * encodes WebP, and createImageBitmap decodes WebP (and anything else Chromium
 * reads) to PNG. Requests are queued one at a time. The window is created on
 * first use and closed by close().
 */

const PAGE = `<!doctype html><meta charset="utf-8"><script>
const b64ToBlob = (b64, type) => {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};
const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).slice(fr.result.indexOf(',') + 1));
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});
const drawToCanvas = async (blob) => {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
};
window.encodeWebp = async (b64, quality) => {
  const canvas = await drawToCanvas(b64ToBlob(b64, 'image/png'));
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || blob.type !== 'image/webp') return null;
  return blobToB64(blob);
};
window.decodeToPng = async (b64, type) => {
  const canvas = await drawToCanvas(b64ToBlob(b64, type));
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blobToB64(blob);
};
</script>`;

function createChromiumImageCodec() {
  let win = null;
  let queue = Promise.resolve();

  const ensureWindow = async () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.on('closed', () => { win = null; });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    return win;
  };

  const run = (script) => {
    const next = queue.then(async () => {
      const w = await ensureWindow();
      return w.webContents.executeJavaScript(script);
    });
    queue = next.catch(() => {});
    return next;
  };

  return {
    /** PNG bytes of WebP (or any Chromium-readable image) data. */
    async decodeToPng(buffer) {
      const type = buffer.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : 'application/octet-stream';
      const out = await run(`window.decodeToPng(${JSON.stringify(buffer.toString('base64'))}, ${JSON.stringify(type)})`);
      if (!out) throw new Error('Chromium could not decode that image.');
      return Buffer.from(out, 'base64');
    },
    /** WebP bytes at `quality` (0-1), or null when Chromium can't encode it. */
    async encodeWebp(png, quality) {
      const out = await run(`window.encodeWebp(${JSON.stringify(png.toString('base64'))}, ${Number(quality)})`);
      return out ? Buffer.from(out, 'base64') : null;
    },
    close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createChromiumImageCodec };
