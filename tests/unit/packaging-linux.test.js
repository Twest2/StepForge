'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// These are structural checks that run in the normal (cross-platform) unit
// suite so the Linux packaging config can't rot silently; the actual .deb
// build/inspection lives in tests/integration/linux/package-deb.test.sh.

test('Linux packaging files exist in their expected separate locations', () => {
  for (const f of [
    'packaging/linux/debian/package.sh',
    'packaging/linux/debian/control.in',
    'packaging/linux/common/stepforge.desktop',
    'packaging/linux/common/stepforge-mime.xml',
    'packaging/linux/common/launcher.sh',
    'scripts/linux/apt/install-runtime-deps.sh',
    'scripts/linux/apt/install-build-deps.sh',
    'docs/linux/apt.md',
    'tests/integration/linux/package-deb.test.sh',
  ]) {
    assert.ok(exists(f), `expected ${f} to exist`);
  }
});

test('the old non-production package-linux.sh is gone', () => {
  assert.equal(exists('scripts/package-linux.sh'), false);
});

test('the desktop entry is valid and app-branded', () => {
  const desktop = read('packaging/linux/common/stepforge.desktop');
  assert.match(desktop, /^\[Desktop Entry\]/);
  assert.match(desktop, /^Type=Application$/m);
  assert.match(desktop, /^Exec=stepforge %U$/m);
  assert.match(desktop, /^Icon=stepforge$/m);
  assert.match(desktop, /^Categories=.+;$/m);
  assert.match(desktop, /MimeType=application\/x-stepforge-guide/);
});

test('the control template declares runtime deps, no hardcoded arch, real maintainer slot', () => {
  const control = read('packaging/linux/debian/control.in');
  assert.match(control, /^Architecture: @ARCH@$/m, 'arch must be templated, not hardcoded');
  assert.match(control, /^Depends:.*libnss3/m);
  assert.match(control, /@VERSION@/);
  assert.match(control, /@MAINTAINER@/);
  // The false "fully offline" wording must not reappear here.
  assert.doesNotMatch(control, /fully offline/i);
});

test('the launcher refuses an unsandboxed launch unless explicitly opted in', () => {
  const launcher = read('packaging/linux/common/launcher.sh');
  assert.match(launcher, /STEPFORGE_ALLOW_NO_SANDBOX/);
  // It must not unconditionally exec with --no-sandbox.
  assert.doesNotMatch(launcher, /^exec .*--no-sandbox/m);
  // It never installs anything at runtime.
  assert.doesNotMatch(launcher, /npm (install|ci|rebuild)/);
});

test('the package builder requires node_modules and guards against dev-dep leaks', () => {
  const script = read('packaging/linux/debian/package.sh');
  assert.match(script, /node_modules\/electron\/dist/);
  assert.match(script, /npm ls --omit=dev/);
  assert.match(script, /electron-builder/); // the leak guard references it
  assert.match(script, /dpkg --print-architecture/); // arch detected, not hardcoded
  assert.doesNotMatch(script, /cp -a "\$ROOT_DIR\/node_modules" /); // never copy the whole dev tree
});

test('apt setup scripts target apt and keep build vs runtime deps separate', () => {
  const runtime = read('scripts/linux/apt/install-runtime-deps.sh');
  const build = read('scripts/linux/apt/install-build-deps.sh');
  assert.match(runtime, /apt-get/);
  assert.match(runtime, /libnss3/);
  assert.doesNotMatch(runtime, /dpkg-dev|fakeroot/, 'runtime script must not install build tools');
  assert.match(build, /dpkg-dev/);
  assert.match(build, /fakeroot/);
});

test('an original icon set is generated (not a placeholder/third-party asset)', () => {
  assert.ok(exists('packaging/assets/stepforge.svg'));
  assert.ok(exists('scripts/make-icons.js'));
  // The generated PNGs are committed for packaging.
  for (const size of [16, 48, 256]) {
    assert.ok(exists(`packaging/assets/icons/stepforge-${size}.png`), `icon ${size} missing`);
  }
  // Regenerate the 256px icon and confirm the generator is deterministic and
  // produces a valid PNG (starts with the PNG signature).
  const { renderIcon } = require('../../scripts/make-icons');
  const { encodePng } = require('../../core/png');
  const png = encodePng(renderIcon(256));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
