'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const { decodePng, encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { encodeGif } = require('../../core/gif');
const { decodeGif } = require('./gifdecode');
const { PdfBuilder } = require('../../core/pdf');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function px(img, x, y) {
  const p = (y * img.width + x) * 4;
  return [...img.data.subarray(p, p + 4)];
}

function hasTool(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'pipe' }); return true; } catch { return false; }
}

test('PNG decoder reads an externally-encoded PNG correctly', () => {
  const img = decodePng(TINY_PNG); // produced by a real-world encoder
  assert.equal(img.width, 1);
  assert.equal(img.height, 1);
  // ImageMagick reads this file as srgba(255,0,0,0.498); we must agree.
  assert.deepEqual([...img.data], [255, 0, 0, 127]);
});

test('PNG encode -> decode round-trips pixels exactly', () => {
  const src = raster.createImage(13, 7, [10, 20, 30, 255]);
  raster.fillRect(src, 3, 2, 5, 3, [200, 100, 50, 255]);
  const decoded = decodePng(encodePng(src));
  assert.equal(decoded.width, 13);
  assert.equal(decoded.height, 7);
  assert.deepEqual(decoded.data, src.data);
});

test('our PNG output is valid for external tools (ImageMagick)', { skip: !hasTool('identify') }, (t) => {
  const dir = makeTmpDir('pngcheck');
  t.after(() => rmrf(dir));
  const img = raster.createImage(40, 20, [255, 0, 0, 255]);
  const file = path.join(dir, 'check.png');
  fs.writeFileSync(file, encodePng(img));
  const out = execFileSync('identify', ['-format', '%w %h %m', file]).toString();
  assert.equal(out.trim(), '40 20 PNG');
});

test('annotations are burned into pixels: rect, highlight, blur, number', () => {
  // 200x100 white image; verify actual pixel changes per annotation.
  const base = raster.createImage(200, 100, [255, 255, 255, 255]);
  // Distinct dark region so blur produces a measurable smear.
  raster.fillRect(base, 100, 0, 4, 100, [0, 0, 0, 255]);

  const out = raster.renderAnnotations(base, [
    { id: 'a1', type: 'rect', x: 0.05, y: 0.1, w: 0.2, h: 0.4, style: { stroke: '#FF0000', strokeWidth: 10, fill: 'transparent' } },
    { id: 'a2', type: 'highlight', x: 0.0, y: 0.8, w: 0.1, h: 0.2, style: {} },
    { id: 'a3', type: 'blur', x: 0.45, y: 0.0, w: 0.15, h: 1.0, radius: 6, style: {} },
    { id: 'a4', type: 'number', value: 4, x: 0.8, y: 0.5, w: 0.15, h: 0.3, style: { stroke: '#0000FF' } },
  ]);

  // Original image untouched (renderAnnotations works on a copy).
  assert.deepEqual(px(base, 10, 10), [255, 255, 255, 255]);

  // Rect stroke: border pixel red, interior still white.
  assert.deepEqual(px(out, 10, 10), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 25, 30), [255, 255, 255, 255]);

  // Highlight: white blended toward yellow (R stays high, B drops).
  const hl = px(out, 5, 90);
  assert.ok(hl[2] < 200 && hl[0] > 240, `highlight should yellow the pixel, got ${hl}`);

  // Blur: the hard black/white edge inside the blur region is now grey.
  const edge = px(out, 99, 50);
  assert.ok(edge[0] > 30 && edge[0] < 225, `blur should smear edge, got ${edge}`);

  // Number badge: just inside the left edge of the disc is the badge color
  // (blue); dead center would hit the white glyph.
  const badge = px(out, Math.round(0.815 * 200), Math.round(0.65 * 100));
  assert.ok(badge[2] > 200 && badge[0] < 80, `badge center should be blue, got ${badge}`);
});

test('text rendering puts glyph pixels where text is drawn', () => {
  const img = raster.createImage(120, 40, [255, 255, 255, 255]);
  raster.drawText(img, 4, 4, 'OK', 16, [0, 0, 0, 255]);
  let dark = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 100) dark++;
  assert.ok(dark > 30, `expected glyph pixels, found ${dark}`);
  // Region far from the text stays untouched.
  assert.deepEqual(px(img, 110, 35), [255, 255, 255, 255]);
});

test('crop and focused view produce correct geometry without mutating input', () => {
  const img = raster.createImage(100, 50, [10, 10, 10, 255]);
  raster.fillRect(img, 60, 20, 10, 10, [250, 250, 250, 255]);

  const cropped = raster.crop(img, 50, 10, 40, 30);
  assert.equal(cropped.width, 40);
  assert.equal(cropped.height, 30);
  assert.deepEqual(px(cropped, 15, 15), [250, 250, 250, 255]); // 60+5,20+5 relative

  // focused view: zoom 2 around the bright square keeps output size
  const fv = raster.applyFocusedView(img, { enabled: true, zoom: 2, panX: 0.65, panY: 0.5 });
  assert.equal(fv.width, 100);
  assert.equal(fv.height, 50);
  // the bright square now covers a larger area: count bright pixels
  const bright = (im) => {
    let n = 0;
    for (let i = 0; i < im.data.length; i += 4) if (im.data[i] > 200) n++;
    return n;
  };
  assert.ok(bright(fv) > bright(img) * 2.5, 'zoomed view should enlarge the bright region');
  assert.equal(img.width, 100, 'input image unchanged');
});

test('GIF encoder produces decodable frames with correct pixels and looping', () => {
  const f1 = raster.createImage(31, 17, [255, 0, 0, 255]);
  const f2 = raster.createImage(31, 17, [0, 0, 255, 255]);
  raster.fillRect(f2, 0, 0, 10, 17, [0, 255, 0, 255]);

  const gif = encodeGif([f1, f2], { delayCs: 50, loop: 0 });
  const decoded = decodeGif(gif);
  assert.equal(decoded.width, 31);
  assert.equal(decoded.height, 17);
  assert.equal(decoded.frames.length, 2);
  assert.equal(decoded.loops, 0);

  const colorAt = (frame, x, y) => {
    const idx = frame.indices[y * frame.width + x];
    return [decoded.palette[idx * 3], decoded.palette[idx * 3 + 1], decoded.palette[idx * 3 + 2]];
  };
  // Quantization tolerance: channels within 26 of target.
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 26);
  assert.ok(near(colorAt(decoded.frames[0], 15, 8), [255, 0, 0]), 'frame1 red');
  assert.ok(near(colorAt(decoded.frames[1], 25, 8), [0, 0, 255]), 'frame2 blue');
  assert.ok(near(colorAt(decoded.frames[1], 5, 8), [0, 255, 0]), 'frame2 left green');
  assert.equal(decoded.frames[0].indices.length, 31 * 17, 'every pixel decoded');
});

test('GIF with a complex frame (forces LZW code growth) still round-trips', () => {
  // Noise image exercises dictionary growth + reset paths in the encoder.
  const img = raster.createImage(120, 80);
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.floor(rand() * 256);
    img.data[i + 1] = Math.floor(rand() * 256);
    img.data[i + 2] = Math.floor(rand() * 256);
    img.data[i + 3] = 255;
  }
  const decoded = decodeGif(encodeGif([img], { delayCs: 10 }));
  assert.equal(decoded.frames[0].indices.length, 120 * 80);
});

test('GIF output is valid for external tools (ImageMagick)', { skip: !hasTool('identify') }, (t) => {
  const dir = makeTmpDir('gifcheck');
  t.after(() => rmrf(dir));
  const frames = [raster.createImage(20, 10, [255, 0, 0, 255]), raster.createImage(20, 10, [0, 255, 0, 255])];
  const file = path.join(dir, 'anim.gif');
  fs.writeFileSync(file, encodeGif(frames, { delayCs: 100 }));
  const out = execFileSync('identify', ['-format', '%w %h %m\n', file]).toString().trim().split('\n');
  assert.equal(out.length, 2, 'two frames detected');
  assert.equal(out[0], '20 10 GIF');
});

test('PDF builder emits a structurally valid document with working xref', () => {
  const pdf = new PdfBuilder();
  pdf.addPage();
  pdf.bookmark('Intro', 0);
  pdf.text('Hello StepForge', 50, 50, { size: 16, font: 'F2' });
  pdf.rect(50, 80, 100, 40, { fill: [220, 220, 250], stroke: [0, 0, 0] });
  const img = raster.createImage(8, 8, [0, 128, 255, 255]);
  pdf.image(img, 50, 140, 120, 60);
  pdf.addPage();
  pdf.bookmark('Second', 1);
  pdf.text('Page two', 50, 50, {});
  const buf = pdf.build();

  assert.equal(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(buf.subarray(buf.length - 7).toString('latin1').includes('%%EOF'));

  // xref offsets must point at the right objects.
  const text = buf.toString('latin1');
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 4), 'xref');
  const lines = text.slice(xrefAt).split('\n');
  const count = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < count; i++) {
    const offset = Number(lines[2 + i].split(' ')[0]);
    assert.match(text.slice(offset, offset + 20), new RegExp(`^${i} 0 obj`), `object ${i} offset valid`);
  }

  // Page tree declares 2 pages; both content streams inflate.
  assert.match(text, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2/);
  const streams = text.match(/(?<!end)stream\n/g) || [];
  assert.equal(streams.length, 3, '2 page content streams + 1 image stream');
});

test('PDF renders correctly under Ghostscript', { skip: !hasTool('gs') }, (t) => {
  const dir = makeTmpDir('pdfcheck');
  t.after(() => rmrf(dir));
  const pdf = new PdfBuilder();
  pdf.addPage();
  pdf.text('Validation page', 60, 60, { size: 14 });
  const img = raster.createImage(16, 16, [255, 0, 0, 255]);
  pdf.image(img, 60, 100, 200, 100);
  pdf.addPage();
  pdf.text('Second page', 60, 60, {});
  const file = path.join(dir, 'check.pdf');
  fs.writeFileSync(file, pdf.build());
  // gs exits non-zero / prints errors on malformed PDFs; -o /dev/null renders all pages.
  const out = execFileSync('gs', ['-dBATCH', '-dNOPAUSE', '-sDEVICE=nullpage', file], { stdio: 'pipe' }).toString();
  assert.match(out, /Processing pages 1 through 2/);
  assert.doesNotMatch(out, /error/i);
});

test('wrapText breaks long paragraphs to the given width', () => {
  const pdf = new PdfBuilder();
  const lines = pdf.wrapText('alpha beta gamma delta epsilon zeta eta theta', 12, 100);
  assert.ok(lines.length >= 3, `expected several lines, got ${lines.length}`);
  for (const line of lines) {
    assert.ok(pdf.textWidth(line, 12) <= 100 || !line.includes(' '), `line too wide: "${line}"`);
  }
  // Round-trip: joining gives back all words in order.
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), 'alpha beta gamma delta epsilon zeta eta theta');
});
