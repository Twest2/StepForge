'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTmpDir, rmrf } = require('./helpers');

const shellOptions = { skip: process.platform !== 'linux' };
function fixture(t, fail = false) {
  const root = makeTmpDir('test-runner');
  t.after(() => rmrf(root));
  fs.mkdirSync(path.join(root, 'tests/checks'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../run_test.sh'), path.join(root, 'tests/run_test.sh'));
  for (const [name, body] of Object.entries({
    test_fedora_package: 'echo rpm >> executed',
    test_unit_workflows: `echo units >> executed\n${fail ? 'exit 7' : ''}`,
    test_workflow_build_release: 'echo debian >> executed',
    test_workflow_sample_artifacts: 'echo samples >> executed',
  })) fs.writeFileSync(path.join(root, `tests/checks/${name}.sh`), body);
  return {
    run: (...args) => spawnSync('bash', ['tests/run_test.sh', ...args], { cwd: root, encoding: 'utf8' }),
    executed: () => fs.existsSync(path.join(root, 'executed'))
      ? fs.readFileSync(path.join(root, 'executed'), 'utf8').trim().split('\n') : [],
  };
}

test('default shell runner executes the complete suite', shellOptions, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.executed(), ['rpm', 'units', 'debian', 'samples']);
});

test('Fedora profile delegates only the Debian release build', shellOptions, (t) => {
  const f = fixture(t);
  const result = f.run('--fedora');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.executed(), ['rpm', 'units', 'samples']);
  assert.match(result.stdout, /delegated to the Ubuntu CI job/);
});

test('Fedora profile propagates check failures', shellOptions, (t) => {
  const f = fixture(t, true);
  const result = f.run('--fedora');
  assert.equal(result.status, 7);
  assert.deepEqual(f.executed(), ['rpm', 'units']);
  assert.doesNotMatch(result.stdout, /All tests passed/);
});

test('shell runner rejects unknown profiles and extra arguments before running checks', shellOptions, (t) => {
  const f = fixture(t);
  for (const args of [['--fedor'], ['--fedora', 'extra']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  assert.deepEqual(f.executed(), []);
});
