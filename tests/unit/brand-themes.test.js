'use strict';

// Built-in brand themes (core/brand-themes.js): ready-made, read-only
// profiles that work everywhere a profile id does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { BrandingStore, normalizeProfile } = require('../../core/branding');
const { brandThemes, isThemeId } = require('../../core/brand-themes');
const { SharedSettings } = require('../../core/shared-settings');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

function brands(t) {
  const root = makeTmpDir('themes');
  t.after(() => rmrf(root));
  return { root, store: new BrandingStore(path.join(root, 'settings')) };
}

test('themes: seven named, described, read-only profiles with ids like any other', () => {
  const themes = brandThemes();
  assert.deepEqual(themes.map((theme) => theme.name), ['Slate', 'Ocean', 'Forest', 'Sunset', 'Compact', 'Midnight', 'Classic']);
  for (const theme of themes) {
    assert.match(theme.id, /^brand-theme-[a-z]+$/);
    assert.ok(isThemeId(theme.id));
    assert.ok(theme.description.length > 20, `${theme.name} says what it looks like`);
    // Every value is one normalizeProfile keeps as it is (nothing silently replaced).
    const normal = normalizeProfile(theme, { id: theme.id });
    assert.deepEqual(normal.colors, theme.colors, `${theme.name} colors`);
    assert.deepEqual(normal.screenshots, theme.screenshots, `${theme.name} screenshots`);
    assert.equal(normal.cover, theme.cover || 'standard', `${theme.name} cover`);
    assert.equal(normal.logo, null, 'themes have no files');
  }
  assert.equal(themes.find((theme) => theme.name === 'Compact').screenshots.layout, 'side-by-side');
  assert.equal(themes.find((theme) => theme.name === 'Midnight').html.colorScheme, 'auto');
});

test('themes: get and resolve like profiles, never listed, saved over or deleted', (t) => {
  const { store } = brands(t);
  assert.deepEqual(store.list(), [], 'list() is your profiles only');
  assert.equal(store.themes().length, 7);
  assert.ok(store.themes().every((theme) => theme.builtIn && theme.description));

  const ocean = store.get('brand-theme-ocean');
  assert.equal(ocean.name, 'Ocean');
  assert.equal(ocean.builtIn, true);
  assert.equal(ocean.cover, 'band');
  assert.equal(store.resolve('brand-theme-ocean').profile.colors.primary, '#1D4ED8');
  assert.equal(store.get('brand-theme-nope'), null);

  // Saving a theme (Customize) makes a new profile; the theme stays.
  const copy = store.save({ ...ocean, name: 'Ocean (custom)', colors: { ...ocean.colors, primary: '#000080' } });
  assert.notEqual(copy.id, ocean.id);
  assert.equal(copy.builtIn, undefined);
  assert.deepEqual(store.list().map((p) => p.name), ['Ocean (custom)']);
  assert.equal(store.get('brand-theme-ocean').colors.primary, '#1D4ED8');
  assert.ok(!fs.existsSync(path.join(store.profilesDir, 'brand-theme-ocean.json')));

  assert.throws(() => store.remove('brand-theme-ocean'), /Built-in themes can’t be deleted/);
  // Duplicate works from a theme too.
  assert.equal(store.duplicate('brand-theme-slate').name, 'Slate copy');
});

test('themes: settings sync keeps a theme as the active profile and never writes one as a file', (t) => {
  const { store } = brands(t);
  store.replaceProfiles([{ ...store.get('brand-theme-forest'), name: 'Not a file' }, { id: 'brand-abc', name: 'Mine' }]);
  assert.deepEqual(store.list().map((p) => p.name), ['Mine']);
  assert.equal(store.get('brand-theme-forest').name, 'Forest');
  const source = fs.readFileSync(path.join(__dirname, '../../core/shared-settings.js'), 'utf8');
  // A synced active id is kept when branding.get() knows it, which it does for themes.
  assert.match(source, /next\.settings\.activeProfileId && this\.branding\.get\(next\.settings\.activeProfileId\)/);
  assert.equal(typeof SharedSettings, 'function');
});

test('themes: every theme exports to every branded format', (t) => {
  const root = makeTmpDir('themeexports');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const branding = new BrandingStore(path.join(root, 'settings'));
  for (const theme of branding.themes()) {
    const ast = buildRenderAst(store, guide.guideId, { branding: branding.resolve(theme.id) });
    for (const format of ['pdf', 'docx', 'pptx', 'html-rich', 'html-simple', 'markdown']) {
      const result = runExport(format, ast, path.join(root, theme.id, format), {});
      assert.ok(fs.statSync(result.file).size > 500, `${theme.name} ${format}`);
    }
    const html = fs.readFileSync(runExport('html-simple', ast, path.join(root, theme.id, 'check'), {}).file, 'utf8');
    assert.ok(html.toLowerCase().includes(theme.colors.primary.toLowerCase()), `${theme.name}: its color is in the page`);
  }
});
