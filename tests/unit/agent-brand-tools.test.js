'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { BrandingStore } = require('../../core/branding');
const { encodePng, decodePng } = require('../../core/png');
const { createImage, fillRect } = require('../../core/raster');
const { createAgentTools, INSTRUCTIONS } = require('../../core/agent-tools');
const { recordAgentChange, recordBrandingChange, agentChangesSince } = require('../../core/agent-changes');

const ROOT = path.resolve(__dirname, '..', '..');

function makeLibrary(t, agents = { enabled: true, screenshots: true, branding: true }) {
  const dir = makeTmpDir('agent-brand');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  new Settings(store.settingsDir).set('ai.agents', agents);
  const changes = [];
  const tools = createAgentTools({
    store,
    agentSettings: () => new Settings(store.settingsDir).get('ai.agents'),
    onBrandingChange: (change) => changes.push(change),
  });
  const call = async (name, args = {}) => tools.find((tool) => tool.name === name).handler(args);
  const json = (result) => {
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const error = (result) => {
    assert.equal(result.isError, true, 'expected a tool error');
    return result.content[0].text;
  };
  const file = (name, data) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, data);
    return p;
  };
  return { dir, store, call, json, error, file, changes, branding: new BrandingStore(store.settingsDir) };
}

/** A minimal TrueType file: just a `name` table naming the family (as in branding.test.js). */
function ttfNamed(family) {
  const str = Buffer.from(family, 'utf16le').swap16();
  const name = Buffer.alloc(18 + str.length);
  name.writeUInt16BE(1, 2); // one record
  name.writeUInt16BE(18, 4); // string storage offset
  name.writeUInt16BE(3, 6); // Windows
  name.writeUInt16BE(1, 8); // Unicode BMP
  name.writeUInt16BE(0x409, 10); // en-US
  name.writeUInt16BE(1, 12); // family
  name.writeUInt16BE(str.length, 14);
  str.copy(name, 18);
  const head = Buffer.alloc(28);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write('name', 12, 'latin1');
  head.writeUInt32BE(28, 20);
  head.writeUInt32BE(name.length, 24);
  return Buffer.concat([head, name]);
}

const BRAND_TOOLS = ['list_brand_profiles', 'get_brand_profile', 'create_brand_profile', 'update_brand_profile', 'set_brand_file', 'set_active_brand_profile'];

test('brand tools are off by default, and say which switch turns them on', async (t) => {
  assert.equal(new Settings(makeTmpDir('agent-brand-defaults')).get('ai.agents.branding'), false);
  const guidesOnly = makeLibrary(t, { enabled: true, screenshots: true });
  for (const name of BRAND_TOOLS) {
    assert.match(guidesOnly.error(await guidesOnly.call(name, { profile_id: 'brand-x', name: 'x' })), /Settings → AI → Let AI agents edit brand profiles/, name);
  }
  // The main switch still cuts off everything, brand tools included.
  const off = makeLibrary(t, { enabled: false, branding: true });
  assert.match(off.error(await off.call('list_brand_profiles')), /Let AI agents edit your guides/);
  assert.equal(guidesOnly.changes.length + off.changes.length, 0);
  assert.match(INSTRUCTIONS, /Let AI agents edit brand profiles/);
  assert.match(INSTRUCTIONS, /can't delete brand profiles/);
});

test('agents create and update profiles; only what they send changes, and nothing deletes one', async (t) => {
  const { call, json, error, changes, branding } = makeLibrary(t);
  assert.equal((await call('list_brand_profiles')).content[0].text, 'No brand profiles yet. Make one with create_brand_profile.');
  assert.match(error(await call('create_brand_profile', {})), /Give the profile a name/);

  const created = json(await call('create_brand_profile', {
    name: 'Acme', colors: { primary: '#0b6e4f' }, fonts: { heading: { name: 'Georgia' } }, footer: { text: '© Acme', page_numbers: false },
  }));
  assert.match(created.profile_id, /^brand-/);
  assert.deepEqual(created.colors, { primary: '#0B6E4F', accent: '#0EA5E9', text: '#18212B' }, 'defaults for what wasn’t sent');
  assert.deepEqual(created.footer, { text: '© Acme', page_numbers: false });
  assert.equal(created.active, false);
  assert.equal(created.logo, null);

  const updated = json(await call('update_brand_profile', {
    profile_id: created.profile_id, colors: { accent: '#C2410C' }, cover: 'band', css: '.step-num { border-radius: 4px; }',
    annotation_colors: { custom: true, shapes: '#0B6E4F' }, watermark: { enabled: true, opacity: 0.4 },
  }));
  assert.deepEqual(updated.colors, { primary: '#0B6E4F', accent: '#C2410C', text: '#18212B' });
  assert.equal(updated.fonts.heading.name, 'Georgia', 'kept');
  assert.equal(updated.footer.text, '© Acme', 'kept');
  assert.equal(updated.cover, 'band');
  assert.equal(updated.css, '.step-num { border-radius: 4px; }');
  assert.deepEqual(updated.annotation_colors, { custom: true, shapes: '#0B6E4F', numbers: '#1F6FEB', tooltips: '#111827' });
  assert.deepEqual(updated.watermark, { enabled: true, position: 'bottom-right', opacity: 0.4 });
  assert.equal(branding.get(created.profile_id).html.css, '.step-num { border-radius: 4px; }', 'saved where the app reads it');
  assert.deepEqual(changes, [{}, {}], 'the app is told about each change');

  const listed = json(await call('list_brand_profiles'));
  assert.deepEqual(listed.profiles.map((p) => p.name), ['Acme']);
  assert.equal(listed.active_profile_id, null);
});

test('bad input is refused with what’s wrong, never quietly dropped', async (t) => {
  const { call, json, error } = makeLibrary(t);
  const { profile_id: id } = json(await call('create_brand_profile', { name: 'Acme' }));
  const refused = async (args) => error(await call('update_brand_profile', { profile_id: id, ...args }));
  assert.match(await refused({ colors: { primary: 'blue' } }), /colors\.primary must be a color like #1F6FEB/);
  assert.match(await refused({ colors: { secondary: '#000000' } }), /colors has no field "secondary"/);
  assert.match(await refused({ cover: 'wavy' }), /cover must be one of: standard, band, centered/);
  assert.match(await refused({ html_color_scheme: 'dark' }), /html_color_scheme must be one of/);
  assert.match(await refused({ watermark: { opacity: 2 } }), /from 0\.05 to 1/);
  assert.match(await refused({ header: { logo: 'yes' } }), /header\.logo must be true or false/);
  assert.match(await refused({ name: '   ' }), /name can't be empty/);
  assert.match(await refused({ css: 'a{}'.repeat(70000) }), /css is too long: at most 200,000 characters/);
  assert.match(await refused({ logo: 'abc' }), /Unknown field "logo"/);
  assert.match(await refused({}), /at least one field/);
  assert.match(error(await call('update_brand_profile', { profile_id: 'brand-nope', name: 'x' })), /No brand profile with id "brand-nope"\. Call list_brand_profiles/);
  assert.match(error(await call('get_brand_profile', { profile_id: '../../app-settings' })), /No brand profile/);
  assert.equal(json(await call('get_brand_profile', { profile_id: id, include_logo: false })).colors.primary, '#2563EB', 'unchanged');
});

test('set_brand_file adds a logo, banner or font from a file, checks it like an upload, and can remove it', async (t) => {
  const { call, json, error, file, branding } = makeLibrary(t);
  const { profile_id: id } = json(await call('create_brand_profile', { name: 'Acme' }));
  const logo = createImage(900, 300, [0, 0, 0, 0]);
  fillRect(logo, 0, 0, 300, 300, [11, 110, 79, 255]);
  const logoFile = file('acme.png', encodePng(logo));

  const withLogo = json(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: logoFile }));
  assert.deepEqual(withLogo.logo, { file_name: 'acme.png', format: 'png', width: 900, height: 300 });
  const resolved = branding.resolve(id);
  assert.ok(resolved.logo.raster, 'a PNG is ready for every export at once');

  // get_brand_profile shows the logo, small, and how to style the HTML.
  const got = await call('get_brand_profile', { profile_id: id });
  const info = JSON.parse(got.content[0].text);
  assert.match(info.css_reference, /--brand-primary/);
  assert.match(info.css_reference, /\.step-num/);
  const image = got.content.find((c) => c.type === 'image');
  const shown = decodePng(Buffer.from(image.data, 'base64'));
  assert.deepEqual([shown.width, shown.height], [512, 171]);

  // An SVG is cleaned, used by HTML at once, and drawn as PNG by the app later.
  const svg = file('banner.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200"><script>alert(1)</script><rect width="1200" height="200" fill="#0B6E4F" onclick="x()"/></svg>');
  const banner = await call('set_brand_file', { profile_id: id, slot: 'banner', file_path: svg });
  assert.match(banner.content.at(-1).text, /HTML exports use this image now/);
  const stored = fs.readFileSync(branding.resolve(id).banner.file, 'utf8');
  assert.ok(!/script|onclick/.test(stored));
  assert.deepEqual(branding.pendingRasters().map((d) => d.mime), ['image/svg+xml'], 'the app will draw it');

  // A font file names the font when no name is set, and keeps a name that is.
  const withFont = json(await call('set_brand_file', { profile_id: id, slot: 'heading_font', file_path: file('brand.ttf', ttfNamed('Acme Sans')) }));
  assert.deepEqual(withFont.fonts.heading, { name: 'Acme Sans', file: { file_name: 'brand.ttf', family: 'Acme Sans' } });
  json(await call('update_brand_profile', { profile_id: id, fonts: { body: { name: 'Georgia' } } }));
  assert.equal(json(await call('set_brand_file', { profile_id: id, slot: 'body_font', file_path: file('body.ttf', ttfNamed('Acme Serif')) })).fonts.body.name, 'Georgia');

  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: 'acme.png' })), /full path/);
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: path.join(ROOT, 'nope.png') })), /There's no file at/);
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: ROOT })), /isn't a file/);
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: file('notes.png', 'just text') })), /Choose a PNG, JPG or SVG image/);
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'body_font', file_path: logoFile })), /Choose a WOFF2, WOFF, TTF or OTF font file/);
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'favicon', file_path: logoFile })), /slot must be one of: logo, banner, heading_font, body_font/);
  const big = file('big.png', Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: big })), /larger than 10 MB/);
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', file_path: logoFile, remove: true })), /not both/);

  const removed = json(await call('set_brand_file', { profile_id: id, slot: 'logo', remove: true }));
  assert.equal(removed.logo, null);
  assert.ok(removed.banner, 'only that slot');
});

test('set_active_brand_profile chooses what exports use, and tells the running app', async (t) => {
  const { store, call, json, error, changes } = makeLibrary(t);
  const { profile_id: id } = json(await call('create_brand_profile', { name: 'Acme' }));
  assert.match((await call('set_active_brand_profile', { profile_id: id })).content[0].text, /Exports now use “Acme”/);
  assert.equal(new Settings(store.settingsDir).get('branding.activeProfileId'), id);
  assert.deepEqual(changes.at(-1), { activeProfileId: id });
  assert.equal(json(await call('list_brand_profiles')).active_profile_id, id);
  assert.equal(json(await call('get_brand_profile', { profile_id: id, include_logo: false })).active, true);

  assert.match(error(await call('set_active_brand_profile', { profile_id: 'brand-nope' })), /No brand profile/);
  assert.equal(new Settings(store.settingsDir).get('branding.activeProfileId'), id, 'unchanged');
  assert.match((await call('set_active_brand_profile', { profile_id: '' })).content[0].text, /no branding/);
  assert.equal(new Settings(store.settingsDir).get('branding.activeProfileId'), '');
});

test('the app learns about brand changes, and the active profile an agent chose last', (t) => {
  const dir = makeTmpDir('agent-brand-changes');
  t.after(() => rmrf(dir));
  recordAgentChange(dir, 'g1', 1000);
  recordBrandingChange(dir, {}, 2000);
  assert.deepEqual(agentChangesSince(dir, 1500), { guideIds: [], branding: true, activeProfileId: undefined, latest: 2000 });
  recordBrandingChange(dir, { activeProfileId: 'brand-a' }, 3000);
  recordBrandingChange(dir, { activeProfileId: '' }, 4000);
  recordBrandingChange(dir, {}, 5000);
  assert.deepEqual(agentChangesSince(dir, 0), { guideIds: ['g1'], branding: true, activeProfileId: '', latest: 5000 });
  assert.equal(agentChangesSince(dir, 3500).activeProfileId, '');
});

test('the app applies an agent’s brand changes and draws the images they need', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  const watcher = main.slice(main.indexOf('function watchAgentChanges'), main.indexOf('function agentSetupCommand'));
  assert.match(watcher, /if \(changed\.branding\)/);
  assert.match(watcher, /settings\.set\('branding\.activeProfileId', id\)/, 'the running app saves the choice, not just the agent');
  assert.match(watcher, /sendToRenderer\('branding:changed-by-agent'/);
  assert.match(main, /h\('branding:pendingRasters', \(\) => branding\.pendingRasters\(\)\)/);
  const mcp = fs.readFileSync(path.join(ROOT, 'app/mcp.js'), 'utf8');
  assert.match(mcp, /onBrandingChange: \(change\) => recordBrandingChange\(store\.libraryDir, change\)/);
  const app = fs.readFileSync(path.join(ROOT, 'app/renderer/app.js'), 'utf8');
  assert.match(app, /api\.branding\.onChangedByAgent\(/);
  assert.equal((app.match(/ensurePendingBrandRasters\(api\)/g) || []).length, 2, 'on start, and when an agent changes a profile');
  const dialogs = fs.readFileSync(path.join(ROOT, 'app/renderer/dialogs.js'), 'utf8');
  assert.match(dialogs, /branding: agentsBranding\.checked/);
});


test('set_brand_file refuses inherited slot names and non-boolean removal without modifying the profile', async (t) => {
  const { call, json, error, changes } = makeLibrary(t);
  const { profile_id: id } = json(await call('create_brand_profile', { name: 'Acme' }));
  for (const slot of ['toString', '__proto__', 'constructor']) {
    assert.match(error(await call('set_brand_file', { profile_id: id, slot, remove: true })), /slot must be one of/);
  }
  assert.match(error(await call('set_brand_file', { profile_id: id, slot: 'logo', remove: 'true' })), /remove must be true or false/);
  assert.equal(changes.length, 1, 'only profile creation changed the library');
});
