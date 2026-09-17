# Warp backend (Linux + Windows)

`pi-interactive-subagents` treats Warp as a first-class surface host alongside psmux
and WezTerm. Warp has no multiplexer CLI, so the backend uses a **surface-directory
handshake**; see [ADR-0011](./adr/0011-warp-terminal-class-1-backend.md) for why.

## Setup (once)

```bash
node scripts/install-warp-hook.mjs --install     # add the guarded pane hook
node scripts/install-warp-hook.mjs --status      # verify
node scripts/install-warp-hook.mjs --uninstall   # fully reversible
```

Then open a **new** Warp tab (or `exec $SHELL`). Until the hook is installed, Warp is
not advertised as a backend and `muxSetupHint()` tells you exactly this.

The hook is a small guarded block in `~/.bashrc` / `~/.zshrc` /
`~/.config/fish/config.fish` / PowerShell `$PROFILE`. It does nothing unless **all** of
these hold: interactive shell, `TERM_PROGRAM=WarpTerminal`, and the shell started inside
a surface directory. Inspect exactly what will be written with `--print`.

## How a subagent runs

1. `createSurface()` writes `…/warp/surfaces/<id>/{surface.json,.pi-warp-surface}`.
2. Warp opens a tab on that directory via `warp://action/new_tab?path=…`.
3. The hook waits for Warp's own shell bootstrap to finish (`WARP_BOOTSTRAPPED`), then
   execs `pi-warp-bootstrap`.
4. The bootstrap runs the command under a pty, mirrors output to `out.log`, and splices
   `in.fifo` into the child's stdin.
5. The sub-agent finishes by calling **`subagent_done`**, which writes
   `${PI_SUBAGENT_SESSION}.exit`; `pollForExit` sees the sidecar and returns
   `reason: "done"`. Sub-agents should never be asked to type `/exit`.

## Platform matrix

| | Linux | Windows (Git Bash / MSYS2 / WSL) | Windows (PowerShell) | macOS |
|---|---|---|---|---|
| Open tab (`warp://action/new_tab`) | ✅ | ✅ | ✅ | ✅ |
| Run command in pane | ✅ | ✅ | ✅ | ✅ |
| `sendCommand` into a running TUI | ✅ | ✅ | ⚠️ direct mode | ✅ |
| `sendEscape` (interrupt) | ✅ | ✅ | ⚠️ direct mode | ✅ |
| `readScreen` | ✅ transcript | ✅ transcript | ⚠️ limited | ✅ transcript |
| Completion via `subagent_done` | ✅ | ✅ | ✅ | ✅ |
| Pane rename / close via `warpctrl` | optional | ❌ not published on Windows | ❌ | optional |

Warp on Windows does not support `cmd.exe` or `fish`. Prefer a **Git Bash / MSYS2 / WSL**
default shell for full parity; PowerShell panes still launch, run and report completion.

## Environment variables

| Variable | Purpose |
|---|---|
| `PI_MUX_BACKEND=warp` | force the Warp backend |
| `PI_WARP_SUBMIT_KEY=cr\|lf\|crlf` | key used to submit a line (default `cr` — LF does **not** submit in raw-mode TUIs) |
| `PI_WARP_STATE_DIR` | relocate surface directories + hook receipt |
| `PI_WARP_NO_LAUNCH=1` | prepare surfaces without opening UI (tests/dry-runs) |
| `PI_WARP_BIN`, `PI_WARPCTRL_BIN` | override binary discovery |
| `PI_WARP_DATA_DIR` | Warp channel data dir (default: first existing `~/.warp*`) |

## Optional: Warp Scripting (`warpctrl`)

If you enable **Settings > Scripting** (and install the CLI via the command palette,
"Install Warp Control CLI command"), the backend additionally uses `warpctrl` for pane
rename, real pane close and splits. It is never required; on Windows it is unavailable.

## Troubleshooting

**Injected text appears but is not submitted.** That is the LF/CR issue — ensure
`PI_WARP_SUBMIT_KEY` is unset or `cr`. Also check **Settings > Agents > Third-party CLI
agents**: Warp auto-detects `pi` as a CLI agent and its *Rich Input* editor can take
keyboard focus ("Auto open on session start"). Turn that off for unattended panes.

**Warp's bootstrap script is echoed line-by-line into a prompt.** An old hook took over
before Warpify completed. Reinstall the hook (`--install`) — the current one defers until
`WARP_BOOTSTRAPPED` is set — then run `stty sane` in the affected pane.

**Pane shows `running` but nothing is there.** `readStatus()` reconciles against the OS:
if the recorded pid is dead it flips to `exited` and appends the done sentinel. Call
`warpCloseSurface(id)` to reap orphaned children.

**Diagnostics.** `warpDiagnostics()` reports binaries, hook receipt, data/state dirs and
whether `warpctrl` answers.

## Tests

```bash
npm test                                                   # unit (no Warp needed)
node --test test/integration/warp-surface.test.ts          # live; skips unless inside Warp + hook installed
```
