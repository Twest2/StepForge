# Architecture

This template is organized around three small areas:

- Repository guidance in `README.md` and `CONTRIBUTING.md`.
- User-facing templates in `.github/`.
- Validation and automation in `tests/` and `.gitea/workflows/`.

## Workflow

1. Update the documentation and templates.
2. Put shell checks in `tests/checks/`.
3. Run `bash tests/run_test.sh` locally.
4. Open a pull request so Gitea Actions can verify the template on PR open.
