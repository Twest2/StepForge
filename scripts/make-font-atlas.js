'use strict';

/**
 * Regenerate core/fonts/sans-*.png + .json, the anti-aliased glyph atlases the
 * software rasterizer (core/raster.js) uses to draw text into exported
 * images. Run with Electron so the fonts are rasterized by Chromium:
 *
 *   npx electron scripts/make-font-atlas.js
 *
 * Needs the Lato TTFs (SIL Open Font License) at FONT_DIR.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { encodePng } = require('../core/png');

const FONT_DIR = process.env.LATO_DIR || '/usr/share/fonts/truetype/lato';
const OUT_DIR = path.join(__dirname, '..', 'core', 'fonts');
const SIZE = 64;
const FACES = [
  { id: 'regular', file: 'Lato-Regular.ttf' },
  { id: 'bold', file: 'Lato-Bold.ttf' },
];

function charset() {
  const codes = [];
  for (let c = 32; c <= 126; c++) codes.push(c);
  for (let c = 160; c <= 255; c++) codes.push(c);
  for (const ch of '‘’“”…–—•→←✓€') codes.push(ch.codePointAt(0));
  return codes;
}

function rasterize(fontUrl, codes, size) {
  /* eslint-disable no-undef */
  return (async () => {
    const face = new FontFace('Atlas', `url(${fontUrl})`);
    await face.load();
    document.fonts.add(face);
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${size}px Atlas`;
    const ref = probe.measureText('Hg');
    const ascent = Math.ceil(ref.fontBoundingBoxAscent);
    const descent = Math.ceil(ref.fontBoundingBoxDescent);
    const cellH = ascent + descent;
    const glyphs = {};
    const cells = [];
    for (const code of codes) {
      const ch = String.fromCodePoint(code);
      const m = probe.measureText(ch);
      const left = Math.floor(-m.actualBoundingBoxLeft) - 1;
      const right = Math.ceil(m.actualBoundingBoxRight) + 1;
      cells.push({ code, ch, left, w: Math.max(1, right - left), advance: m.width });
    }
    const atlasW = 1024;
    let x = 0, y = 0;
    for (const cell of cells) {
      if (x + cell.w > atlasW) { x = 0; y += cellH; }
      cell.x = x; cell.y = y;
      x += cell.w;
    }
    const atlasH = y + cellH;
    const canvas = document.createElement('canvas');
    canvas.width = atlasW; canvas.height = atlasH;
    const ctx = canvas.getContext('2d');
    ctx.font = `${size}px Atlas`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    for (const cell of cells) {
      ctx.fillText(cell.ch, cell.x - cell.left, cell.y + ascent);
      glyphs[cell.code] = [cell.x, cell.y, cell.w, cell.left, Math.round(cell.advance * 100) / 100];
    }
    const alpha = Array.from(ctx.getImageData(0, 0, atlasW, atlasH).data.filter((_, i) => i % 4 === 3));
    return { size, ascent, descent, width: atlasW, height: atlasH, glyphs, alpha };
  })();
  /* eslint-enable no-undef */
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const face of FACES) {
    const fontUrl = `data:font/ttf;base64,${fs.readFileSync(path.join(FONT_DIR, face.file)).toString('base64')}`;
    const result = await win.webContents.executeJavaScript(
      `(${rasterize.toString()})(${JSON.stringify(fontUrl)}, ${JSON.stringify(charset())}, ${SIZE})`,
    );
    const { alpha, ...meta } = result;
    const data = Buffer.alloc(meta.width * meta.height * 4);
    for (let i = 0; i < alpha.length; i++) {
      data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = alpha[i];
    }
    fs.writeFileSync(path.join(OUT_DIR, `sans-${face.id}.png`), encodePng({ width: meta.width, height: meta.height, data }));
    fs.writeFileSync(path.join(OUT_DIR, `sans-${face.id}.json`), `${JSON.stringify(meta)}\n`);
    console.log(`sans-${face.id}: ${meta.width}x${meta.height}, ${Object.keys(meta.glyphs).length} glyphs`);
  }
  app.quit();
});
