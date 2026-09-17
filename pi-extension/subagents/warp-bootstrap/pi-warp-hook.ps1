# pi-warp-hook.ps1 — dot-sourced from the user's PowerShell $PROFILE.
if ($env:WARP_IS_LOCAL_SHELL_SESSION -or $env:TERM_PROGRAM -eq 'WarpTerminal') {
  if (-not $env:PI_WARP_HOOK) {
    $marker = Join-Path (Get-Location) '.pi-warp-surface'
    $spec = Join-Path (Get-Location) 'surface.json'
    if ((Test-Path $marker) -and (Test-Path $spec)) {
      $bootstrap = '__PI_WARP_BOOTSTRAP__'
      if (Test-Path $bootstrap) {
        & $bootstrap -SurfaceDir (Get-Location).Path
        exit $LASTEXITCODE
      } else {
        Write-Warning "pi-interactive-subagents: bootstrap missing at $bootstrap"
      }
    }
  }
}
