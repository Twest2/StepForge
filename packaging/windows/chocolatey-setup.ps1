# Registers a StepForge that was installed from the .exe with Chocolatey, so
# that "choco upgrade stepforge" keeps it updated. The Windows installer
# extracts this script and starts it once, elevated. It is written for
# Windows PowerShell 5.1.
#
#   -Version            Exact package version of the installer that just ran.
#   -InstallChocolatey  Install Chocolatey first if it is missing.
#   -Uninstall          Unregister StepForge instead (used by the uninstaller).
#   -ResultFile         Where to write "ok" or "failed", for the installer to read.
#
# This must never get in the way of installing StepForge: every failure is
# logged and reported through -ResultFile, and the script always exits 0.
param(
  [string]$Version = '',
  [switch]$InstallChocolatey,
  [switch]$Uninstall,
  [string]$ResultFile = '',
  [string]$FeedUrl = 'https://packages.twestbrook.com/nuget/stepforge-choco/',
  [string]$SourceName = 'stepforge'
)

# Native commands write to stderr; do not turn that into terminating errors.
$ErrorActionPreference = 'Continue'

$dataDir = Join-Path $env:ProgramData 'StepForge'
$logFile = Join-Path $dataDir 'chocolatey-setup.log'
$installedCopy = Join-Path $dataDir 'chocolatey-setup.ps1'

function Write-Log {
  param([string]$Message)
  try {
    if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
    Add-Content -LiteralPath $logFile -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message) -Encoding UTF8
  } catch {
    # Logging is best effort.
  }
}

function Write-Result {
  param([string]$Text)
  if (-not $ResultFile) { return }
  try {
    Set-Content -LiteralPath $ResultFile -Value $Text -Encoding ASCII
  } catch {
    Write-Log "Could not write the result file: $($_.Exception.Message)"
  }
}

# Looks in the places Chocolatey installs to: %ChocolateyInstall%, PATH, then
# the default %ProgramData%\chocolatey.
function Find-Choco {
  $candidates = @()
  if ($env:ChocolateyInstall) { $candidates += (Join-Path $env:ChocolateyInstall 'bin\choco.exe') }
  $onPath = Get-Command 'choco.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { $candidates += $onPath.Definition }
  $candidates += (Join-Path $env:ProgramData 'chocolatey\bin\choco.exe')
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Invoke-Choco {
  param([string]$Choco, [string[]]$Arguments)
  Write-Log ('choco ' + ($Arguments -join ' '))
  $output = @(& $Choco @Arguments 2>&1)
  $code = $LASTEXITCODE
  foreach ($line in $output) { Write-Log ('    ' + [string]$line) }
  return [pscustomobject]@{ ExitCode = $code; Lines = $output }
}

function Install-Chocolatey {
  Write-Log 'Chocolatey was not found. Installing it from community.chocolatey.org.'
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
  $text = Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1')) *>&1 | Out-String
  Write-Log $text.Trim()
}

# True when a Chocolatey source with this URL exists under any name.
function Test-SourceConfigured {
  param([string]$Choco)
  $wanted = $FeedUrl.TrimEnd('/')
  $result = Invoke-Choco -Choco $Choco -Arguments @('source', 'list', '-r')
  foreach ($line in $result.Lines) {
    $fields = ([string]$line).Split('|')
    if ($fields.Count -ge 2 -and $fields[1].Trim().TrimEnd('/') -eq $wanted) { return $true }
  }
  return $false
}

# The version Chocolatey has registered for StepForge, or '' when none.
function Get-RegisteredVersion {
  param([string]$Choco)
  $result = Invoke-Choco -Choco $Choco -Arguments @('list', '--local-only', '--exact', '-r', 'stepforge')
  foreach ($line in $result.Lines) {
    if (([string]$line) -match '^stepforge\|(.+)$') { return $Matches[1].Trim() }
  }
  return ''
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

  if (-not (Test-SourceConfigured -Choco $choco)) {
    $add = Invoke-Choco -Choco $choco -Arguments @('source', 'add', "--name=$SourceName", "--source=$FeedUrl")
    if ($add.ExitCode -ne 0) {
      Write-Log "Could not add the StepForge feed (exit code $($add.ExitCode))."
      return $false
    }
  } else {
    Write-Log 'The StepForge feed is already configured.'
  }

  $registered = Get-RegisteredVersion -Choco $choco
  if ($registered -eq $Version) {
    Write-Log "Chocolatey already has StepForge $Version registered."
    return $true
  }

  # --skip-automation-scripts registers the package without running its
  # install script, so the installer that is already running is not run again.
  # "upgrade" also installs, but it handles a different registered version.
  $verb = 'install'
  $extra = @()
  if ($registered) {
    Write-Log "Chocolatey has StepForge $registered registered; moving it to $Version."
    $verb = 'upgrade'
    $extra = @('--allow-downgrade')
  }
  $run = Invoke-Choco -Choco $choco -Arguments (@($verb, 'stepforge', '--version', $Version, '--source', $FeedUrl, '-y', '--skip-automation-scripts') + $extra)
  if ($run.ExitCode -ne 0) {
    Write-Log "choco $verb failed with exit code $($run.ExitCode). Development and prerelease builds are not on the feed."
    return $false
  }
  return $true
}

function Unregister-StepForge {
  $choco = Find-Choco
  if (-not $choco) {
    Write-Log 'Chocolatey is not installed; nothing to unregister.'
    return $true
  }
  if (-not (Get-RegisteredVersion -Choco $choco)) {
    Write-Log 'Chocolatey does not have StepForge registered; nothing to do.'
    return $true
  }
  $run = Invoke-Choco -Choco $choco -Arguments @('uninstall', 'stepforge', '-y', '--skip-automation-scripts')
  if ($run.ExitCode -ne 0) {
    Write-Log "choco uninstall failed with exit code $($run.ExitCode)."
    return $false
  }
  return $true
}

$succeeded = $false
try {
  if ($Uninstall) {
    Write-Log 'Unregistering StepForge from Chocolatey.'
    $succeeded = Unregister-StepForge
    # The uninstaller runs this copy; nothing needs it once StepForge is gone.
    if ($succeeded -and $PSCommandPath -eq $installedCopy) {
      Remove-Item -LiteralPath $installedCopy -Force -ErrorAction SilentlyContinue
    }
  } elseif (-not $Version) {
    Write-Log 'No version was given.'
  } else {
    Write-Log "Setting up Chocolatey updates for StepForge $Version."
    $succeeded = Register-StepForge
    if ($succeeded -and $PSCommandPath -and $PSCommandPath -ne $installedCopy) {
      # Keep a copy where only administrators can change it, so the
      # uninstaller can unregister StepForge later.
      try {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installedCopy -Force
        & icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-1-0:(OI)(CI)RX' 2>&1 | Out-Null
      } catch {
        Write-Log "Could not keep a copy for the uninstaller: $($_.Exception.Message)"
      }
    }
  }
} catch {
  Write-Log "Unexpected error: $($_.Exception.Message)"
  $succeeded = $false
}

if ($succeeded) {
  Write-Log 'Done.'
  Write-Result 'ok'
} else {
  Write-Log 'Chocolatey setup did not finish.'
  Write-Result 'failed'
}
exit 0
