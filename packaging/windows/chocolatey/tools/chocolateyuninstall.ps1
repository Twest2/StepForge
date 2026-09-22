$ErrorActionPreference = 'Stop'

[array]$keys = Get-UninstallRegistryKey -SoftwareName 'StepForge*'
if ($keys.Count -eq 0) {
  Write-Warning 'StepForge is not installed; nothing to uninstall.'
  return
}

foreach ($key in $keys) {
  # electron-builder writes: "C:\...\Uninstall StepForge.exe" /allusers
  if ($key.UninstallString -notmatch '^"([^"]+)"\s*(.*)$') { continue }
  $packageArgs = @{
    packageName    = $env:ChocolateyPackageName
    fileType       = 'exe'
    file           = $Matches[1]
    silentArgs     = "$($Matches[2]) /S".Trim()
    validExitCodes = @(0)
  }
  Uninstall-ChocolateyPackage @packageArgs
}
