'use strict';
// A plain Node helper isolates libvips from Linux Electron's global GLib symbols.
const { createImageCodec } = require('./image-codec');
(async () => {
  const [operation, options] = process.argv.slice(2);
  if (!['encode', 'decode', 'crop', 'bitmap'].includes(operation)) throw new Error('Unknown image operation.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const codec = createImageCodec();
  const input = Buffer.concat(chunks);
  const opts = JSON.parse(options || '{}');
  const result = operation === 'encode' ? await codec.encodeWebp(input, opts)
    : operation === 'crop' ? await codec.cropPng(input, opts)
      : operation === 'bitmap' ? await codec.bitmapToPng(input, opts.width, opts.height)
        : await codec.decodeToPng(input);
  if (result) process.stdout.write(result);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
