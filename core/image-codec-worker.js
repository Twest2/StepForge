'use strict';
// A plain Node helper isolates libvips from Linux Electron's global GLib symbols.
const { createImageCodec } = require('./image-codec');
(async () => {
  const [operation, options] = process.argv.slice(2);
  if (!['encode', 'decode'].includes(operation)) throw new Error('Unknown image operation.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const codec = createImageCodec();
  const input = Buffer.concat(chunks);
  const result = operation === 'encode' ? await codec.encodeWebp(input, JSON.parse(options || '{}')) : await codec.decodeToPng(input);
  if (result) process.stdout.write(result);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
