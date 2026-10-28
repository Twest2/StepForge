'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { colorsFromPixels, contrastOnWhite } = require('../../core/brand-palette');
const { buildBrandCssPrompt, normalizeBrandCss, STYLE_REFERENCE } = require('../../core/ai-brand-css');
const { TextIntelService, BRAND_CSS_REQUEST } = require('../../app/text-intel');

/** RGBA pixels: each [r, g, b, a, count] repeated count times. */
function pixels(...fills) {
  const data = new Uint8ClampedArray(fills.reduce((n, f) => n + f[4], 0) * 4);
  let i = 0;
  for (const [r, g, b, a, count] of fills) {
    for (let k = 0; k < count; k += 1) { data[i++] = r; data[i++] = g; data[i++] = b; data[i++] = a; }
  }
  return data;
}

const hexRgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });

// ---- Pick colors from logo (core/brand-palette.js) ------------------------------

test('logo colors: the main color is Primary, a second hue is Accent, a dark neutral is Text; white is background', () => {
  const colors = colorsFromPixels(pixels(
    [255, 255, 255, 255, 5000], // background
    [37, 99, 235, 255, 2000], // blue mark
    [249, 115, 22, 255, 600], // orange dot
    [20, 20, 20, 255, 300], // dark wordmark
  ));
  assert.equal(colors.primary, '#2563EB');
  assert.notEqual(colors.accent, colors.primary, 'the logo’s second color, not the first again');
  assert.ok(hexRgb(colors.accent).r > hexRgb(colors.accent).b, 'the orange');
  assert.equal(colors.text, '#141414');
});

test('logo colors: Accent and Text are darkened until they read on white; Primary stays the brand color', () => {
  const colors = colorsFromPixels(pixels([250, 204, 21, 255, 1500], [0, 0, 0, 0, 3000]));
  assert.equal(colors.primary, '#FACC15', 'yellow, exactly');
  assert.ok(contrastOnWhite(hexRgb(colors.accent)) >= 4.5, 'links pass WCAG AA');
  assert.ok(contrastOnWhite(hexRgb(colors.text)) >= 7, 'body text passes AAA');
});

test('logo colors: one color, black and white, and nothing usable', () => {
  const navy = colorsFromPixels(pixels([0, 0, 0, 0, 5000], [16, 42, 90, 255, 1500]));
  assert.equal(navy.primary, '#102A5A');
  assert.equal(navy.accent, '#102A5A', 'already readable, so the same color');
  assert.equal(colorsFromPixels(pixels([0, 0, 0, 0, 5000], [0, 0, 0, 255, 1500])).primary, '#000000');
  assert.equal(colorsFromPixels(pixels([255, 255, 255, 255, 5000])), null, 'a white logo');
  assert.equal(colorsFromPixels(pixels([0, 0, 0, 0, 100])), null, 'fully transparent');
  assert.equal(colorsFromPixels(new Uint8ClampedArray(0)), null);
});

test('logo colors: anti-aliased edges and specks don’t become brand colors', () => {
  const colors = colorsFromPixels(pixels(
    [255, 255, 255, 255, 4000],
    [220, 38, 38, 255, 2000], // red
    [228, 50, 50, 255, 300], // the same red, a shade off
    [16, 185, 129, 255, 20], // a green speck: under 1%
  ));
  assert.equal(hexRgb(colors.primary).r > 200 && hexRgb(colors.primary).g < 60, true);
  assert.ok(hexRgb(colors.accent).g < 100, 'no green accent from a speck');
});

// ---- Write with AI (core/ai-brand-css.js) ----------------------------------------

test('the CSS prompt has the request, the brand, the style reference and the CSS so far', () => {
  const { systemPrompt, prompt } = buildBrandCssPrompt({
    request: 'Square step numbers',
    css: 'body { font-size: 15px; }',
    profile: { colors: { primary: '#0B6E4F', accent: '#0A5C42', text: '#18212B' }, fonts: { heading: { name: 'Georgia' }, body: { name: '' } } },
  });
  assert.match(systemPrompt, /JSON/);
  assert.match(prompt, /The change to make: Square step numbers/);
  assert.match(prompt, /primary #0B6E4F, accent #0A5C42, text #18212B/);
  assert.match(prompt, /headings Georgia, body \(default\)/);
  assert.ok(prompt.includes(STYLE_REFERENCE));
  assert.match(prompt, /\.step-num/);
  assert.match(prompt, /body \{ font-size: 15px; \}/);
  assert.match(prompt, /No @import/);

  const long = buildBrandCssPrompt({ request: 'x'.repeat(2000), css: 'a{}'.repeat(5000) }).prompt;
  assert.ok(!long.includes('x'.repeat(501)), 'the request is capped');
  assert.ok(long.includes('/* … */'), 'long CSS is cut, and says so');
});

test('the model’s CSS is cleaned: fences, markup and outside requests go; broken CSS is refused', () => {
  assert.equal(normalizeBrandCss({ css: '```css\n.step-num { border-radius: 4px; }\n```' }), '.step-num { border-radius: 4px; }');
  const cleaned = normalizeBrandCss({
    css: '@import url("https://fonts.example.com/x.css");\n</style><script>alert(1)</script>\n.doc-header { background: url(https://example.com/bg.png) no-repeat; }\n.a { background: url("data:image/png;base64,AA=="); }',
  });
  assert.ok(!/@import|https?:|<|script/.test(cleaned.replace('data:image', '')), cleaned);
  assert.match(cleaned, /background: none no-repeat/);
  assert.match(cleaned, /url\("data:image\/png;base64,AA=="\)/, 'embedded images are fine');

  assert.throws(() => normalizeBrandCss({ css: '' }), /didn’t write any CSS/);
  assert.throws(() => normalizeBrandCss({ title: 'hi' }), /didn’t write any CSS/);
  assert.throws(() => normalizeBrandCss({ css: '.a { color: red;' }), /cut off/);
  assert.throws(() => normalizeBrandCss({ css: '.a { color: red; }}' }), /cut off/);
  assert.throws(() => normalizeBrandCss({ css: `.a { color: red; }${' '.repeat(20001)}.b{}` }), /more CSS/);
});

function makeSettings(ai = {}) {
  const data = { ai: { enabled: true, timeoutMs: 60000, ...ai, ollama: { host: 'http://127.0.0.1:11434', model: 'gemma3:4b', ...(ai.ollama || {}) } } };
  return { get: (key) => key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), data) };
}

function makeService(t, ai, fetchImpl) {
  const root = makeTmpDir('brand-ai');
  t.after(() => rmrf(root));
  return new TextIntelService({ store: { settingsDir: root }, settings: makeSettings(ai), dataDir: root, fetchImpl });
}

test('AI status: offered only when AI is on and Ollama has the chosen model; no request while AI is off', async (t) => {
  let calls = 0;
  const tags = (models) => async (url) => {
    calls += 1;
    const { pathname } = new URL(url);
    if (pathname === '/api/tags') return { ok: true, json: async () => ({ models: models.map((name) => ({ name })) }) };
    if (pathname === '/api/show') return { ok: true, json: async () => ({ capabilities: [] }) };
    throw new Error(`unexpected fetch: ${pathname}`);
  };
  assert.deepEqual(await makeService(t, { enabled: false }, tags(['gemma3:4b'])).aiStatus(), { ready: false });
  assert.equal(calls, 0, 'AI off: Ollama isn’t contacted');
  assert.deepEqual(await makeService(t, {}, tags(['gemma3:4b'])).aiStatus(), { ready: true, model: 'gemma3:4b' });
  assert.deepEqual(await makeService(t, {}, tags(['llama3.2:1b'])).aiStatus(), { ready: false }, 'model not installed');
  assert.deepEqual(await makeService(t, {}, async () => { throw new Error('ECONNREFUSED'); }).aiStatus(), { ready: false }, 'Ollama not running');
});

test('Write with AI asks Ollama for JSON and returns cleaned CSS; failures come back as a reason', async (t) => {
  const bodies = [];
  let reply = JSON.stringify({ css: '.step-num { border-radius: 4px; }' });
  const service = makeService(t, {}, async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/chat');
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ message: { content: reply } }) };
  });
  const ok = await service.generateBrandCss({ request: 'Square step numbers', css: '', profile: { colors: { primary: '#0B6E4F' } } });
  assert.deepEqual(ok, { ok: true, css: '.step-num { border-radius: 4px; }' });
  assert.equal(bodies[0].model, 'gemma3:4b');
  assert.equal(bodies[0].format, 'json');
  assert.match(bodies[0].messages[1].content, /Square step numbers/);

  reply = JSON.stringify({ css: '.a { color: red;' });
  assert.deepEqual(await service.generateBrandCss({ request: 'x' }), { ok: false, reason: 'The model’s CSS was cut off. Try again, or ask for a smaller change.' });
  reply = 'not json';
  assert.equal((await service.generateBrandCss({ request: 'x' })).ok, false);

  const off = makeService(t, { enabled: false }, async () => { throw new Error('must not be called'); });
  assert.deepEqual(await off.generateBrandCss({ request: 'x' }), { ok: false, reason: 'Turn on AI in Settings first.' });
});

test('Write with AI can be stopped by its own id, without touching guide requests', async (t) => {
  const service = makeService(t, {}, (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = service.generateBrandCss({ request: 'Bigger logo' });
  await new Promise((resolve) => setImmediate(resolve));
  service.cancelInflight('some-guide');
  assert.equal(service.inflight.size, 1, 'a guide’s cancel leaves it running');
  service.cancelInflight(BRAND_CSS_REQUEST);
  assert.deepEqual(await pending, { ok: false, reason: 'AI request cancelled.' });
});
