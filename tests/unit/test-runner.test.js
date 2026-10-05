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

test('explicit skips delegate only the named checks', shellOptions, (t) => {
  const f = fixture(t);
  const result = f.run('--skip', 'test_workflow_build_release.sh', '--skip', 'test_unit_workflows.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.executed(), ['rpm', 'samples']);
  assert.match(result.stdout, /explicit --skip/);
});

test('runner propagates failures with explicit skips', shellOptions, (t) => {
  const f = fixture(t, true);
  const result = f.run('--skip', 'test_workflow_build_release.sh');
  assert.equal(result.status, 7);
  assert.deepEqual(f.executed(), ['rpm', 'units']);
  assert.doesNotMatch(result.stdout, /All tests passed/);
});

test('shell runner rejects unknown options and extra arguments before running checks', shellOptions, (t) => {
  const f = fixture(t);
  for (const args of [['--fedora'], ['--skip'], ['--skip', 'test_unit_workflows.sh', 'extra']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  assert.deepEqual(f.executed(), []);
});


test('runner rejects missing or unsafe skip names before any check runs', shellOptions, (t) => {
  const f = fixture(t);
  for (const name of ['test_renamed.sh', '../test_unit_workflows.sh', '/test_unit_workflows.sh']) {
    const result = f.run('--skip', 'test_workflow_build_release.sh', '--skip', name);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown check:/);
  }
  assert.deepEqual(f.executed(), []);
});

test('duplicate skip arguments remain harmless', shellOptions, (t) => {
  const f = fixture(t);
  const result = f.run('--skip', 'test_workflow_build_release.sh', '--skip', 'test_workflow_build_release.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.executed(), ['rpm', 'units', 'samples']);
});
