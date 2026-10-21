# Registers a StepForge that was installed from the .exe with Chocolatey, so
# that "choco upgrade stepforge" keeps it updated, or unregisters it again.
# The Windows installer and uninstaller extract this script and start it once,
# elevated. It is written for Windows PowerShell 5.1.
#
#   -Version            Exact package version of the installer that just ran.
#   -InstallChocolatey  Install Chocolatey first if it is missing.
#   -Uninstall          Unregister StepForge instead (used by the uninstaller).
#   -ResultFile         Where to write "ok" or "failed" and the log path, for
#                       the installer to read.
#
# This must never get in the way of installing or removing StepForge: every
# failure is logged and reported through -ResultFile, and the script always
# exits 0.
param(
  [string]$Version = '',
  [switch]$InstallChocolatey,
  [switch]$Uninstall,
  [string]$ResultFile = ''
)

# Native commands write to stderr; do not turn that into terminating errors.
$ErrorActionPreference = 'Continue'

$FeedUrl = 'https://packages.twestbrook.com/nuget/stepforge-choco/'
$SourceName = 'stepforge'
$PackageId = 'stepforge'

# SYSTEM, Administrators and TrustedInstaller. Anything this elevated script
# runs or writes into must be controlled by these alone.
$TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# WriteData/CreateFiles, AppendData/CreateDirectories, WriteExtendedAttributes,
# DeleteSubdirectoriesAndFiles, WriteAttributes, Delete, ChangePermissions,
# TakeOwnership, GENERIC_ALL and GENERIC_WRITE.
$WriteRightsMask = [int64](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)

$script:LogFile = $null

# True when only SYSTEM, Administrators or TrustedInstaller own and can change
# this directory, so a standard user cannot plant files or links in it.
function Test-SafeDirectory {
  param([string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { return $false }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if ($TrustedSids -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($TrustedSids -contains $rule.IdentityReference.Value) { continue }
      if (([int64]$rule.FileSystemRights -band $WriteRightsMask) -ne 0) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

# %ProgramData%\StepForge is created so that only administrators can write to
# it: standard users can create folders in %ProgramData%, and this script runs
# elevated, so a folder or link planted there could redirect what it writes.
# If an existing folder is not safe, the log goes to this user's temp folder.
function Initialize-Log {
  $fallback = Join-Path ([IO.Path]::GetTempPath()) 'StepForge-chocolatey-setup.log'
  $note = $null
  try {
    $dataDir = Join-Path $env:ProgramData 'StepForge'
    if (-not (Test-Path -LiteralPath $dataDir)) {
      $security = New-Object Security.AccessControl.DirectorySecurity
      $security.SetAccessRuleProtection($true, $false)
      $security.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
      $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      $propagate = [Security.AccessControl.PropagationFlags]::None
      $grants = @(
        @('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl),
        @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl),
        @('S-1-5-32-545', [Security.AccessControl.FileSystemRights]::ReadAndExecute)
      )
      foreach ($grant in $grants) {
        $sid = New-Object Security.Principal.SecurityIdentifier $grant[0]
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $grant[1], $inherit, $propagate, 'Allow')))
      }
      [void][IO.Directory]::CreateDirectory($dataDir, $security)
    }
    if (Test-SafeDirectory -Path $dataDir) {
      $script:LogFile = Join-Path $dataDir 'chocolatey-setup.log'
      return
    }
    $note = "$dataDir is not writable by administrators only, so this log is kept here instead."
  } catch {
    $note = "Could not create the log folder in ProgramData: $($_.Exception.Message)"
  }
  $script:LogFile = $fallback
  if ($note) { Write-Log $note }
}

function Write-Log {
  param([string]$Message)
  if (-not $script:LogFile) { return }
  try {
    Add-Content -LiteralPath $script:LogFile -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message) -Encoding UTF8
  } catch {
    # Logging is best effort.
  }
}

# Line 1 is "ok" or "failed", line 2 the log file, in the ANSI code page that
# the installer's FileRead expects.
function Write-Result {
  param([string]$Status)
  if (-not $ResultFile) { return }
  try {
    Set-Content -LiteralPath $ResultFile -Value @($Status, [string]$script:LogFile) -Encoding Default
  } catch {
    Write-Log "Could not write the result file: $($_.Exception.Message)"
  }
}

function Get-OwnerSid {
  param([string]$Path)
  try {
    return (Get-Acl -LiteralPath $Path -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier]).Value
  } catch {
    return ''
  }
}

# Looks in the places Chocolatey installs to: %ChocolateyInstall%, PATH, then
# the default %ProgramData%\chocolatey. Only the machine-wide
# %ChocolateyInstall% is set by administrators alone; any other choco.exe must
# be owned by SYSTEM or Administrators, so one planted by a standard user (for
# example in %ProgramData%\chocolatey when Chocolatey is not installed) is
# never run elevated.
function Find-Choco {
  $candidates = @()
  $machineRoot = [Environment]::GetEnvironmentVariable('ChocolateyInstall', 'Machine')
  if ($machineRoot) { $candidates += , @((Join-Path $machineRoot 'bin\choco.exe'), $true) }
  if ($env:ChocolateyInstall) { $candidates += , @((Join-Path $env:ChocolateyInstall 'bin\choco.exe'), $false) }
  $onPath = Get-Command 'choco.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { $candidates += , @($onPath.Path, $false) }
  if ($env:ProgramData) { $candidates += , @((Join-Path $env:ProgramData 'chocolatey\bin\choco.exe'), $false) }
  foreach ($candidate in $candidates) {
    $path = $candidate[0]
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    if ($candidate[1] -or ($TrustedSids -contains (Get-OwnerSid -Path $path))) { return $path }
    Write-Log "Ignoring $path because it is not owned by SYSTEM or Administrators."
  }
  return $null
}

function Invoke-Choco {
  param([string]$Choco, [string[]]$Arguments)
  Write-Log ('choco ' + ($Arguments -join ' '))
  $global:LASTEXITCODE = 0
  $output = @(& $Choco @Arguments 2>&1)
  $code = $LASTEXITCODE
  foreach ($line in $output) { Write-Log ('    ' + [string]$line) }
  Write-Log "    (exit code $code)"
  return [pscustomobject]@{ ExitCode = $code; Lines = @($output | ForEach-Object { [string]$_ }) }
}

# 0 is success; 1641 and 3010 mean success with a restart pending.
function Test-ChocoSucceeded {
  param($Result)
  return @(0, 1641, 3010) -contains $Result.ExitCode
}

# The major version of Chocolatey, from "choco --version" (for example 2.4.3).
function Get-ChocoMajorVersion {
  param([string]$Choco)
  $result = Invoke-Choco -Choco $Choco -Arguments @('--version')
  foreach ($line in $result.Lines) {
    if ($line -match '^\s*v?(\d+)\.\d+') { return [int]$Matches[1] }
  }
  return 0
}

# Chocolatey 2 lists local packages by default and rejects --local-only;
# Chocolatey 1 and earlier list the remote source unless it is given.
function Get-ListArguments {
  param([int]$ChocoMajor)
  if ($ChocoMajor -ge 2) { return @('list', '--exact', $PackageId, '--limit-output') }
  return @('list', '--local-only', '--exact', $PackageId, '--limit-output')
}

# The version Chocolatey has registered for StepForge, or '' when none. Lines
# look like "stepforge|1.3.4"; anything else (warnings) is ignored.
function Get-RegisteredVersion {
  param([string]$Choco, [int]$ChocoMajor)
  $result = Invoke-Choco -Choco $Choco -Arguments (Get-ListArguments -ChocoMajor $ChocoMajor)
  foreach ($line in $result.Lines) {
    if ($line -match ('^' + [regex]::Escape($PackageId) + '\|([^|\s]+)')) { return $Matches[1] }
  }
  return ''
}

# NuGet drops a trailing ".0" fourth part (1.3.4.0 is listed as 1.3.4).
function ConvertTo-PackageVersion {
  param([string]$Text)
  $parts = @($Text.Trim().Split('.'))
  if ($parts.Count -eq 4 -and $parts[3] -eq '0') { $parts = $parts[0..2] }
  return ($parts -join '.')
}

# The configured source with this feed URL, under any name, as an object with
# Name and Disabled; $null when there is none. Lines from
# "choco source list --limit-output" look like
# "name|url|disabled|user|certificate|priority|..." in Chocolatey 1 and 2.
function Find-FeedSource {
  param([string]$Choco)
  $wanted = $FeedUrl.TrimEnd('/')
  $result = Invoke-Choco -Choco $Choco -Arguments @('source', 'list', '--limit-output')
  foreach ($line in $result.Lines) {
    $fields = $line.Split('|')
    if ($fields.Count -ge 2 -and $fields[1].Trim().TrimEnd('/') -eq $wanted) {
      $disabled = $fields.Count -ge 3 -and $fields[2].Trim() -eq 'True'
      return [pscustomobject]@{ Name = $fields[0].Trim(); Disabled = $disabled }
    }
  }
  return $null
}

function Install-Chocolatey {
  Write-Log 'Chocolatey was not found. Installing it from community.chocolatey.org.'
  # The official install command. Group Policy may forbid changing the
  # execution policy; the install is still attempted.
  try { Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction Stop } catch { Write-Log "Set-ExecutionPolicy: $($_.Exception.Message)" }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
  $text = Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1')) *>&1 | Out-String
  Write-Log $text.Trim()
}

function Register-StepForge {
  $choco = Find-Choco
  if (-not $choco) {
    if (-not $InstallChocolatey) {
      Write-Log 'Chocolatey is not installed and installing it was not requested.'
      return $false
    }
    Install-Chocolatey
    $choco = Find-Choco
    if (-not $choco) {
      Write-Log 'Chocolatey is still missing after the install.'
      return $false
    }
  }
  Write-Log "Using $choco"
  $major = Get-ChocoMajorVersion -Choco $choco

  $source = Find-FeedSource -Choco $choco
  if (-not $source) {
    $add = Invoke-Choco -Choco $choco -Arguments @('source', 'add', "--name=$SourceName", "--source=$FeedUrl")
    if (-not (Test-ChocoSucceeded $add)) {
      Write-Log 'Could not add the StepForge feed.'
      return $false
    }
  } elseif ($source.Disabled) {
    $enable = Invoke-Choco -Choco $choco -Arguments @('source', 'enable', "--name=$($source.Name)")
    if (-not (Test-ChocoSucceeded $enable)) {
      Write-Log "Could not enable the source $($source.Name)."
      return $false
    }
  } else {
    Write-Log "The StepForge feed is already configured as $($source.Name)."
  }

  $wanted = ConvertTo-PackageVersion $Version
  $registered = Get-RegisteredVersion -Choco $choco -ChocoMajor $major
  if ($registered -and (ConvertTo-PackageVersion $registered) -eq $wanted) {
    Write-Log "Chocolatey already has StepForge $registered registered."
    return $true
  }

  # --skip-automation-scripts registers the package without running its
  # install script, so the installer that is already running is not run again.
  # When another version is registered, "upgrade" moves it to this one.
  $verb = 'install'
  $extra = @()
  if ($registered) {
    Write-Log "Chocolatey has StepForge $registered registered; moving it to $Version."
    $verb = 'upgrade'
    $extra = @('--allow-downgrade')
  }
  $run = Invoke-Choco -Choco $choco -Arguments (@($verb, $PackageId, '--version', $Version, '--source', $FeedUrl, '-y', '--skip-automation-scripts', '--no-progress') + $extra)
  if (-not (Test-ChocoSucceeded $run)) {
    Write-Log "choco $verb failed. Development and prerelease builds are not on the feed."
    return $false
  }

  # The package's install script normally deletes the embedded installer; it
  # was skipped, so remove the ~100 MB copy here.
  try {
    $tools = Join-Path (Split-Path -Parent (Split-Path -Parent $choco)) "lib\$PackageId\tools"
    Get-ChildItem -LiteralPath $tools -Filter 'StepForge Setup *.exe' -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Log "Could not remove the package's copy of the installer: $($_.Exception.Message)"
  }
  return $true
}

function Unregister-StepForge {
  $choco = Find-Choco
  if (-not $choco) {
    Write-Log 'Chocolatey is not installed; nothing to unregister.'
    return $true
  }
  Write-Log "Using $choco"
  $major = Get-ChocoMajorVersion -Choco $choco
  if (-not (Get-RegisteredVersion -Choco $choco -ChocoMajor $major)) {
    Write-Log 'Chocolatey does not have StepForge registered; nothing to do.'
    return $true
  }
  # StepForge's own uninstaller is already running: skip the package's
  # uninstall script and Chocolatey's automatic uninstaller, which would
  # otherwise start it a second time.
  $run = Invoke-Choco -Choco $choco -Arguments @('uninstall', $PackageId, '-y', '--skip-automation-scripts', '--skip-autouninstaller', '--no-progress')
  if (-not (Test-ChocoSucceeded $run)) {
    Write-Log 'choco uninstall failed.'
    return $false
  }
  return $true
}

function Invoke-Main {
  $succeeded = $false
  try {
    Initialize-Log
    if ($Uninstall) {
      Write-Log 'Unregistering StepForge from Chocolatey.'
      $succeeded = Unregister-StepForge
    } elseif ($Version -notmatch '^\d+(\.\d+){2,3}$') {
      Write-Log "No valid version was given ('$Version')."
    } else {
      Write-Log "Setting up Chocolatey updates for StepForge $Version."
      $succeeded = Register-StepForge
    }
  } catch {
    Write-Log "Unexpected error: $($_.Exception.Message)"
    $succeeded = $false
  }

  if (($succeeded -is [bool]) -and $succeeded) {
    Write-Log 'Done.'
    Write-Result 'ok'
  } else {
    Write-Log 'Chocolatey setup did not finish.'
    Write-Result 'failed'
  }
}

# Dot-sourcing loads the functions without running anything (for tests).
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-Main
  exit 0
}
