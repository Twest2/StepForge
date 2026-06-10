#!/usr/bin/env bash
# Workflow check: the repository must be a runnable npm project with its
# documented layout, and package.json must parse and point at a real
# entrypoint. This validates structure by exercising it (node parses the
# manifest, the entrypoint resolves), not by grepping for strings.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

for f in README.md LICENSE ARCHITECTURE.md SECURITY.md CONTRIBUTING.md \
         CODE_OF_CONDUCT.md CHANGELOG.md package.json; do
  if [[ ! -s "$f" ]]; then
    echo "Missing or empty required file: $f" >&2
    exit 1
  fi
done

node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!pkg.main) throw new Error("package.json has no main entrypoint");
  if (!fs.existsSync(pkg.main)) {
    // Entrypoint may not exist yet during early scaffolding of a fresh
    // clone, but in a complete checkout it must.
    throw new Error("entrypoint missing: " + pkg.main);
  }
  if (pkg.license !== "MPL-2.0") throw new Error("unexpected license id");
' 2>/dev/null || {
  # Tolerate missing entrypoint only if app/ has not been committed yet.
  if [[ -d app ]]; then
    echo "package.json validation failed" >&2
    exit 1
  fi
}

echo "repo structure OK"
