# pi-warp-bootstrap.ps1 — pane driver for the Warp backend (Windows PowerShell).
#
# Windows notes:
#   * Warp's local-control CLI (`warpctrl`) is not published on Windows yet, so
#     surface creation goes through a generated tab config opened with
#     `warp://tab_config/<name>`, which carries this script as its startup command.
#   * There is no ConPTY plumbing here, so a PowerShell pane runs in "direct
#     mode": the command owns the console (TUIs work, the user can type), but
#     the parent cannot inject keystrokes and cannot scrape the rendered screen.
#     The parent learns this from `injectable:false` in status.json and fails
#     such sends loudly instead of dropping them on the floor.
#   * Completion is reported through status.json plus the `__SUBAGENT_DONE_n__`
#     sentinel in out.log — the same contract psmux/WezTerm use.
#   * For full parity (live injection + screen reads) use a Git Bash / MSYS2 /
#     WSL pane and set PI_WARP_PANE_SHELL=posix.
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
$statusPath = if ($spec.status) { $spec.status } else { Join-Path $SurfaceDir 'status.json' }
$commandFile = if ($spec.commandFile) { $spec.commandFile } else { Join-Path $SurfaceDir 'command.txt' }

$env:PI_SUBAGENT_SURFACE = $spec.id
$env:PI_SUBAGENT_SURFACE_DIR = $SurfaceDir
$env:PI_WARP_SURFACE_NAME = $spec.name

# Strip control bytes from the name before it reaches an OSC string: a name is
# caller-supplied data, and a raw ESC/BEL in a title sequence is escape injection.
$safeName = ($spec.name -replace '[\x00-\x1f\x7f]', '')
if ($safeName.Length -gt 80) { $safeName = $safeName.Substring(0, 80) }

# Name the Warp tab after the subagent (Warp otherwise titles it from the cwd,
# which is the opaque surface directory). warpctrl is unavailable on Windows.
$env:WARP_DISABLE_AUTO_TITLE = '1'
$prefix = if ($env:PI_WARP_TAB_PREFIX) { $env:PI_WARP_TAB_PREFIX } else { 'pi' }
$tabTitle = "$prefix > $safeName"
function Set-TabTitle { param([string]$Title) [Console]::Write("$([char]27)]0;$Title$([char]7)") }
Set-TabTitle $tabTitle

if ($spec.env) {
  foreach ($p in $spec.env.PSObject.Properties) {
    Set-Item -Path "env:$($p.Name)" -Value $p.Value
  }
}

function Write-SurfaceStatus {
  param([string]$State, $ExitCode = $null)
  # Atomic: the parent writes this file too (reconciliation on close), and a
  # plain Set-Content lets a reader observe a half-written file — which the
  # parent reads as "no status" and silently drops from supervision.
  $rows = 24; $cols = 80
  try { $rows = [Console]::WindowHeight; $cols = [Console]::WindowWidth } catch { }
  $payload = [ordered]@{
    id         = $spec.id
    pid        = $PID
    state      = $State
    exitCode   = $ExitCode
    injectable = $false
    rows       = $rows
    cols       = $cols
    title      = $safeName
    updatedAt  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $tmp = "$statusPath.$PID.tmp"
  ($payload | ConvertTo-Json -Compress) | Set-Content -Path $tmp -Encoding utf8
  Move-Item -Path $tmp -Destination $statusPath -Force
}

Set-Location -Path $spec.cwd -ErrorAction SilentlyContinue

# Pick up a launch command the parent handed over while the tab was still
# opening. Opening a Warp tab is an async round trip (URL handler -> app ->
# $PROFILE -> this script) that outlasts any fixed delay the parent could wait,
# so the parent drops the command here rather than typing into a pane that does
# not exist yet. Without this a PowerShell pane had nothing to run, exited
# instantly and reported a bogus clean exit before the sub-agent ever started.
$command = $spec.command
if (-not $command) {
  $waitMs = if ($env:PI_WARP_COMMAND_WAIT_MS) { [int]$env:PI_WARP_COMMAND_WAIT_MS } else { 15000 }
  $waited = 0
  while (-not $command -and $waited -lt $waitMs) {
    if (Test-Path $commandFile) {
      $command = (Get-Content -Raw -Path $commandFile).Trim()
      break
    }
    Start-Sleep -Milliseconds 100
    $waited += 100
  }
}

Write-SurfaceStatus -State 'running'

# The parent cannot see this pane's screen, so say so once in the transcript
# rather than letting `readScreen` return an unexplained empty string.
@(
  '[pi-interactive-subagents] Warp PowerShell pane (direct mode).',
  '[pi-interactive-subagents] Live screen capture and keystroke injection are unavailable here;',
  '[pi-interactive-subagents] use a Git Bash/MSYS2/WSL pane with PI_WARP_PANE_SHELL=posix for full parity.'
) | Add-Content -Path $log -Encoding utf8

$code = 0
try {
  if ($command) {
    # Run in-process so the child inherits this console: a TUI needs the real
    # console handles, and piping or a nested `powershell -Command` takes them
    # away. The string comes from the parent pi process through a file only this
    # user can write — the same trust boundary psmux/WezTerm `send-keys` already
    # operate under.
    $global:LASTEXITCODE = 0
    Invoke-Expression $command
    $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  } else {
    Add-Content -Path $log -Encoding utf8 `
      -Value '[pi-interactive-subagents] no launch command arrived in time; nothing to run.'
    $code = 64
  }
}
catch {
  $_ | Out-String | Add-Content -Path $log -Encoding utf8
  $code = 1
}
finally {
  Remove-Item -Path (Join-Path $SurfaceDir '.pi-warp-surface') -Force -ErrorAction SilentlyContinue
  Write-SurfaceStatus -State 'exited' -ExitCode $code
  Set-TabTitle "$tabTitle (exit $code)"
  # Sentinel contract shared with the psmux/WezTerm backends.
  Add-Content -Path $log -Value "__SUBAGENT_DONE_${code}__" -Encoding utf8
}
exit $code
