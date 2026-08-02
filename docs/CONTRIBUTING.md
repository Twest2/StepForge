# Contributing

Thanks for improving StepForge.

## Before You Start

- Open or link the issue that describes the work.
- Keep the change small and focused.
- If the work does not have an issue yet, create one first so the PR can
  reference it.

## Clean-Room Rules

StepForge is an independent reimplementation of publicly documented
guide-capture workflow patterns. To keep it legally clean:

- Do **not** use the names, logos, icons, screenshots, or UI strings of
  commercial documentation products anywhere in code, assets, or docs.
- Do **not** copy wording from other products' documentation into the UI.
- Do **not** decompile, disassemble, or otherwise inspect proprietary
  binaries to derive behavior.
- Implement behavior from public descriptions and your own design only.
- Keep file formats (`.sfgz`, `.sfglt`, guide/step JSON) documented and
  versioned in `docs/` and `ARCHITECTURE.md`.

StepForge is licensed under **Creative Commons Attribution-NonCommercial 4.0
International (CC BY-NC 4.0)** — see the root [LICENSE](../LICENSE). By
contributing you agree that your contributions are licensed under that same
license, and you add a Developer Certificate of Origin sign-off to each commit
(`git commit -s`) to certify you have the right to submit them.

## Offline Rules

- No network code paths in the application. No telemetry, update checks,
  license checks, remote fonts, or remote APIs — **ever**.
- No new runtime dependencies without prior maintainer agreement; prefer
  internal implementations using Node built-ins. This is due to all the 
  security issues that have arrose lately with NPM dependencies.

## Branching

- Use a branch name that includes the issue number, such as
  `issue-123-update-readme`.
- Keep unrelated cleanup in a separate branch, only have the fix in the
  branch.

## Pull Requests

- Every pull request must reference an issue number in the body with
  `Closes #123`, `Fixes #123`, or `Relates to #123`.
- Summarize the change clearly and call out anything a reviewer should
  verify manually.
- Update docs when behavior changes.
- Every exporter or storage change **requires tests**; output changes
  require updated snapshot fixtures under `tests/fixtures/`.

## Tests

Run the local checks before opening or updating a PR:

```bash
bash tests/run_test.sh
```

Put new shell checks in `tests/checks/` so the shared runner picks them up
automatically. The shell checks invoke the `node --test` workflow suites in
`tests/unit/`.

Write tests that exercise **real workflows and verify actual output** —
create a guide, export it, parse the bytes that came out. DO NOT WRITE A TEST THAT GREPS FOR CODE.

The Gitea workflow in `.gitea/workflows/tests.yaml` and `.github/workflows/ci.yaml` runs the same command
automatically on pushes and pull requests.

Please add lots of tests to each of your PR's and be descriptive with the
tests so that the issue doesn't happen again or the feature doesn't get
overwritten.

## Review Checklist

- The PR is linked to the correct issue.
- The test suite passes locally.
- Any relevant docs or comments are updated.
- The change stays within the intended scope.
- The PR body explains any manual verification that is still needed.
- No network calls, no new dependencies, no trademarked assets.
