$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
node (Join-Path $Root 'scripts/package-windows.js') @args
exit $LASTEXITCODE
