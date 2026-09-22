$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$installer = Get-ChildItem -Path $toolsDir -Filter 'StepForge Setup *.exe' | Select-Object -First 1
if (-not $installer) { throw 'The StepForge installer is missing from this package.' }

# A copy installed "only for me" from the setup wizard would sit next to the
# Chocolatey-managed copy. Remove it so there is a single StepForge to update.
# Guides, settings and the Google Drive sign-in are kept.
$userInstalls = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'StepForge*' -and $_.QuietUninstallString }
foreach ($entry in $userInstalls) {
  if ($entry.QuietUninstallString -match '^"([^"]+)"\s*(.*)$' -and (Test-Path -LiteralPath $Matches[1])) {
    Write-Host "Replacing the per-user StepForge install with the Chocolatey-managed install."
    $process = Start-Process -FilePath $Matches[1] -ArgumentList $Matches[2] -Wait -PassThru
    if ($process.ExitCode -ne 0) { Write-Warning "The per-user StepForge uninstaller exited with code $($process.ExitCode)." }
  }
}

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  file64         = $installer.FullName
  silentArgs     = '/S /allusers'
  validExitCodes = @(0)
  softwareName   = 'StepForge*'
}
Install-ChocolateyInstallPackage @packageArgs

# The installer is only needed during installation; do not keep 100 MB around.
Remove-Item -LiteralPath $installer.FullName -Force -ErrorAction SilentlyContinue
