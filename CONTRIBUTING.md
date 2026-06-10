# Contributing

Thanks for improving this template.

## Before You Start

- Open or link the issue that describes the work.
- Keep the change small and focused.
- If the work does not have an issue yet, create one first so the PR can reference it.

## Branching

- Use a branch name that includes the issue number, such as `issue-123-update-readme`.
- Keep unrelated cleanup in a separate branch, only have the fix in the branch.

## Pull Requests

- Every pull request must reference an issue number in the body with `Closes #123`, `Fixes #123`, or `Relates to #123`.
- Summarize the change clearly and call out anything a reviewer should verify manually.
- Update docs and templates when the workflow changes.
- If the PR changes the template itself, describe how future contributors should use the new pattern.

## Tests

Run the local checks before opening or updating a PR:

```bash
bash tests/run_test.sh
```

Put new shell checks in `tests/checks/` so the shared runner picks them up automatically.

The Gitea workflow in `.gitea/workflows/tests.yaml` runs the same command automatically on pushes and pull requests.

Please add lots of tests to each of your PR's and be descriptive with the tests so that the issue doesn't happen again or the feature doesn't get overwritten.

## Review Checklist

- The PR is linked to the correct issue.
- The test suite passes locally.
- Any relevant docs or comments are updated.
- The change stays within the intended scope.
- The PR body explains any manual verification that is still needed.

## Notes for Template Maintainers

If this repository is reused as a starter for another project, adjust the branch naming convention, issue linking rule, and testing command so they match the new project.
