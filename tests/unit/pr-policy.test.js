'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkPullRequest, closingComment } = require('../../scripts/pr-policy');

const ROOT = path.join(__dirname, '../..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');

/** The template as a contributor fills it in, keeping its comments and unticked boxes. */
const FILLED = TEMPLATE
  .replace('Closes #<!-- issue number -->', 'Closes #303')
  .replace('<!-- What problem does this solve, and what will users notice? -->', 'Steps no longer split from their screenshots in DOCX exports.')
  .replace('## Changes\n\n-\n', '## Changes\n\n- Keep each step together in exporters/docx.js.\n')
  .replace('- [ ] `bash tests/run_test.sh` passes', '- [x] `bash tests/run_test.sh` passes');

function pr(fields = {}) {
  return {
    number: 1, draft: false, body: FILLED, author_association: 'CONTRIBUTOR', maintainer_can_modify: true,
    user: { login: 'contributor', type: 'User' },
    head: { repo: { full_name: 'contributor/StepForge', owner: { type: 'User' } } },
    base: { repo: { full_name: 'Twest2/StepForge' } },
    ...fields,
  };
}

test('a fork pull request that allows maintainer edits and fills in the template passes', () => {
  assert.deepEqual(checkPullRequest(pr()), { exempt: false, problems: [] });
  // Optional sections may be deleted, as the template says.
  const trimmed = FILLED.replace(/## Area[\s\S]*?(?=## Testing)/, '').replace(/## Screenshots or recordings[\s\S]*?(?=## Checklist)/, '');
  assert.deepEqual(checkPullRequest(pr({ body: trimmed })).problems, []);
});

test('a fork without maintainer edits is closed, unless the fork belongs to an organization', () => {
  const { problems } = checkPullRequest(pr({ maintainer_can_modify: false }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Allow edits by maintainers/);
  const orgFork = pr({ maintainer_can_modify: false, head: { repo: { full_name: 'some-org/StepForge', owner: { type: 'Organization' } } } });
  assert.deepEqual(checkPullRequest(orgFork).problems, [], 'GitHub has no maintainer-edit option for organization forks');
  const sameRepo = pr({ maintainer_can_modify: false, head: { repo: { full_name: 'Twest2/StepForge', owner: { type: 'User' } } } });
  assert.deepEqual(checkPullRequest(sameRepo).problems, [], 'a branch in this repository needs no permission');
});

test('the untouched template, a blank description and a missing section are each closed with what to fix', () => {
  const untouched = checkPullRequest(pr({ body: TEMPLATE })).problems;
  assert.equal(untouched.length, 4);
  assert.match(untouched[0], /Issue\*\* section does not link an issue/);
  assert.match(untouched.slice(1).join('\n'), /Summary\*\* section is empty[\s\S]*Changes\*\* section is empty[\s\S]*Testing\*\* section is empty/);

  const blank = checkPullRequest(pr({ body: null })).problems;
  assert.deepEqual(blank, ['The description is missing the **Issue**, **Summary**, **Changes**, **Testing**, **Checklist** sections from the pull request template.']);

  const noChecklist = checkPullRequest(pr({ body: FILLED.replace('## Checklist', 'Checklist') })).problems;
  assert.deepEqual(noChecklist, ['The description is missing the **Checklist** section from the pull request template.']);
});

test('an issue can be linked by number or by URL', () => {
  const byUrl = FILLED.replace('Closes #303', 'Fixes https://github.com/Twest2/StepForge/issues/303');
  assert.deepEqual(checkPullRequest(pr({ body: byUrl })).problems, []);
  const none = FILLED.replace('Closes #303', 'Closes the DOCX bug');
  assert.equal(checkPullRequest(pr({ body: none })).problems.length, 1);
});

test('maintainers and bots are not checked', () => {
  for (const author_association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(checkPullRequest(pr({ author_association, body: '', maintainer_can_modify: false })).exempt, true);
  }
  assert.equal(checkPullRequest(pr({ user: { login: 'dependabot[bot]', type: 'Bot' }, body: '' })).exempt, true);
});

test('the closing comment says what was wrong and asks for a new pull request', () => {
  const comment = closingComment(['The **Summary** section is empty.']);
  assert.match(comment, /closed automatically/);
  assert.match(comment, /- The \*\*Summary\*\* section is empty\./);
  assert.match(comment, /Please open a new pull request that fixes this\./);
  assert.match(comment, /PULL_REQUEST_TEMPLATE\.md/);
  assert.match(closingComment(['a', 'b']), /fixes these\./);
});

test('the rules workflow never checks out or runs pull request code', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-policy.yml'), 'utf8');
  assert.match(workflow, /pull_request_target:\n\s+types: \[opened, reopened, ready_for_review\]/);
  assert.doesNotMatch(workflow, /pull_request\.head\.(sha|ref)|github\.head_ref|refs\/pull/, 'only the base branch is checked out');
  assert.match(workflow, /sparse-checkout: scripts\/pr-policy\.js/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /npm (ci|install|run)|node /, 'nothing from the pull request is installed or run');
});
