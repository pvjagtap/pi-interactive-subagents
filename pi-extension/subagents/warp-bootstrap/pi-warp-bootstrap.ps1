# pi-warp-bootstrap.ps1 — pane driver for the Warp backend (Windows).
#
# Windows notes:
#   * Warp's local-control CLI (`warpctrl`) is not published on Windows yet, so
#     surface creation always goes through `warp://action/new_tab?path=...`.
#   * There are no FIFOs, so the parent spools length-prefixed base64 records
#     into in.cmd and this script drains them.
#   * ConPTY injection requires the optional `node-pty` dependency. Without it
#     the pane runs in "direct mode": the command owns the console (TUIs work,
#     the user can type), output is captured by the agent's own session log, and
#     completion is reported through status.json + the .exit sidecar.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$SurfaceDir = $env:PI_SUBAGENT_SURFACE_DIR
)

$ErrorActionPreference = 'Stop'
if (-not $SurfaceDir) { $SurfaceDir = (Get-Location).Path }
$specPath = Join-Path $SurfaceDir 'surface.json'
if (-not (Test-Path $specPath)) {
  Write-Error "pi-warp-bootstrap: no surface.json in $SurfaceDir"
  exit 64
}

$spec = Get-Content -Raw -Path $specPath | ConvertFrom-Json
$log = if ($spec.log) { $spec.log } else { Join-Path $SurfaceDir 'out.log' }
$inbox = if ($spec.input) { $spec.input } else { Join-Path $SurfaceDir 'in.cmd' }
$statusPath = if ($spec.status) { $spec.status } else { Join-Path $SurfaceDir 'status.json' }

$env:PI_SUBAGENT_SURFACE = $spec.id
$env:PI_SUBAGENT_SURFACE_DIR = $SurfaceDir
$env:PI_WARP_SURFACE_NAME = $spec.name
$env:PI_WARP_HOOK = '1'

# Name the Warp tab after the subagent (Warp otherwise titles it from the cwd,
# which is the opaque surface directory). warpctrl is unavailable on Windows.
$env:WARP_DISABLE_AUTO_TITLE = '1'
$prefix = if ($env:PI_WARP_TAB_PREFIX) { $env:PI_WARP_TAB_PREFIX } else { 'pi' }
function Set-TabTitle { param([string]$Title) [Console]::Write("`e]0;$Title`a") }
Set-TabTitle "$prefix > $($spec.name)"
if ($spec.env) {
  foreach ($p in $spec.env.PSObject.Properties) {
    Set-Item -Path "env:$($p.Name)" -Value $p.Value
  }
}

function Write-SurfaceStatus {
  param([string]$State, $ExitCode = $null)
  $payload = [ordered]@{
    id        = $spec.id
    pid       = $PID
    state     = $State
    exitCode  = $ExitCode
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  ($payload | ConvertTo-Json -Compress) | Set-Content -Path $statusPath -Encoding utf8
}

# Background drain: parent -> pane. Records are "<bytes>:<base64>".
$drain = Start-ThreadJob -ScriptBlock {
  param($inbox)
  $offset = 0
  while ($true) {
    if (Test-Path $inbox) {
      $lines = Get-Content -Path $inbox -ErrorAction SilentlyContinue
      if ($lines.Count -gt $offset) {
        foreach ($line in $lines[$offset..($lines.Count - 1)]) {
          if ($line -match '^\d+:(.*)$') {
            $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1]))
            # Direct mode: replay into the console input buffer of this pane.
            [Microsoft.PowerShell.PSConsoleReadLine]::Insert($text) 2>$null
          }
        }
        $offset = $lines.Count
      }
    }
    Start-Sleep -Milliseconds 200
  }
} -ArgumentList $inbox -ErrorAction SilentlyContinue

Set-Location -Path $spec.cwd -ErrorAction SilentlyContinue
Write-SurfaceStatus -State 'running'

$code = 0
try {
  if ($spec.command) {
    & powershell -NoLogo -NoProfile -Command $spec.command
    $code = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }
  } else {
    $code = 0
  }
}
catch {
  $_ | Out-String | Add-Content -Path $log
  $code = 1
}
finally {
  if ($drain) { Stop-Job $drain -ErrorAction SilentlyContinue | Out-Null }
  Remove-Item -Path (Join-Path $SurfaceDir '.pi-warp-surface') -Force -ErrorAction SilentlyContinue
  Write-SurfaceStatus -State 'exited' -ExitCode $code
  "__SUBAGENT_DONE_${code}__" | Tee-Object -FilePath $log -Append
}
exit $code
