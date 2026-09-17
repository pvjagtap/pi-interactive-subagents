# Warp backend (Linux + Windows)

`pi-interactive-subagents` treats Warp as a first-class surface host alongside psmux
and WezTerm. Warp has no multiplexer CLI, so the backend uses a **surface-directory
handshake**; see [ADR-0011](./adr/0011-warp-terminal-class-1-backend.md) for why.

## Setup

None. Run pi inside Warp (or set `PI_MUX_BACKEND=warp`) and spawn a subagent.

The backend drives Warp through **tab configs**: a generated TOML file in Warp's
`tab_configs/` directory describes a pane with a `directory` and a startup `commands`
entry, and `warp://tab_config/<name>` opens it. Warp picks up new files live, so nothing
has to be installed into a shell profile and no restart is needed.

The config name is the **file stem**, not the `name` field. Files live in Warp's portable
user-data directory, which is platform-specific:

| Platform | `tab_configs` location |
|---|---|
| Windows | `%APPDATA%\warp\Warp\data\tab_configs\` |
| macOS | `~/.warp/tab_configs/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/warp-terminal/tab_configs/` |

Warp on Windows does **not** read `~/.warp/tab_configs/` — that path is macOS-only.
Override the whole root with `PI_WARP_DATA_DIR` if your install differs.

## How a subagent runs

1. `createSurface()` writes `…/warp/surfaces/<id>/{surface.json,.pi-warp-surface}`.
2. It generates `tab_configs/pi_subagent_<id>.toml` whose pane sets
   `directory = <surface dir>` and `commands = ["<pi-warp-bootstrap …>"]`.
3. `warp://tab_config/pi_subagent_<id>` opens the tab; Warp runs the bootstrap in it.
4. The bootstrap runs the command under a pty, mirrors output to `out.log`, and splices
   `in.fifo` into the child's stdin.
5. The sub-agent finishes by calling **`subagent_done`**, which writes
   `${PI_SUBAGENT_SESSION}.exit`; `pollForExit` sees the sidecar and returns
   `reason: "done"`. Sub-agents should never be asked to type `/exit`.
6. The bootstrap returns and the pane's shell exits, so Warp closes the tab instead of
   leaving one behind per subagent. Set `PI_WARP_KEEP_TAB=1` to keep it open while
   debugging a launch failure.

Disposing a surface deletes its tab config, so stale entries do not pile up in Warp's
`+` menu.

## Platform matrix

| | Linux | Windows (WSL / MSYS2 + util-linux) | Windows (PowerShell, Git Bash) | macOS |
|---|---|---|---|---|
| Open tab (`warp://tab_config/…`) | ✅ | ✅ | ✅ | ✅ |
| Run command in pane | ✅ | ✅ | ✅ | ✅ |
| `sendCommand` into a running TUI | ✅ | ✅ | ❌ throws | ✅ |
| `sendEscape` (interrupt) | ✅ | ✅ | ❌ throws | ✅ |
| `readScreen` | ✅ transcript | ✅ transcript | ❌ not captured | ✅ transcript |
| Completion via `subagent_done` | ✅ | ✅ | ✅ | ✅ |
| Pane rename (`warpctrl`, else OSC 0) | ✅ | ✅ | ✅ | ✅ |
| Pane close via `warpctrl` | optional | ❌ not published on Windows | ❌ | optional |

A **PowerShell pane runs in direct mode**: the command owns the console, so TUIs render
and the user can type, but there is no pty in between — the parent can neither inject
keystrokes nor scrape the screen. Those calls **fail loudly** rather than silently doing
nothing; the pane still reports completion through `status.json` and the
`__SUBAGENT_DONE_n__` sentinel. Warp on Windows does not support `cmd.exe` or `fish`.

**Plain Git Bash cannot do full parity either.** The POSIX bootstrap gives the child a
pty with `script`, which comes from util-linux — and Git for Windows does not ship it.
Without `script` there is no pty, so no live capture and no injection. Full parity on
Windows means **WSL**, or **MSYS2 with `pacman -S util-linux`**. Check with
`command -v script` inside the shell Warp opens before assuming it works.

The pane shell is chosen by `PI_WARP_PANE_SHELL`, **not** by the platform pi runs on —
pi running under Windows PowerShell can still drive a POSIX pane. That does need a
POSIX `sh` on `PATH` (or `PI_WARP_SH`): a pane's input channel is a FIFO, which only a
POSIX shell can open for writing. The backend says so explicitly if one is missing.

## Deferred launch command

Opening a Warp tab is an async round trip (URL handler → app → shell rc files → Warpify →
`pi-warp-bootstrap`) that outlasts any fixed delay the parent could wait. So the first
`sendCommand` on a surface whose pane has not appeared yet is written to `command.txt`
instead, and the bootstrap adopts it as its launch command. Once the pane's input pipe
exists, sends go through it as usual. If nothing arrives within
`PI_WARP_COMMAND_WAIT_MS`, a POSIX pane falls back to an idle interactive shell.
## Surface housekeeping

Surface directories are reaped on every `createSurface()`: exited surfaces older than
`PI_WARP_SURFACE_TTL_MS` are deleted, and at most `PI_WARP_SURFACE_RETAIN` finished
surfaces are kept (oldest dropped first). Live and starting surfaces are never touched.

## Environment variables

| Variable | Purpose |
|---|---|
| `PI_MUX_BACKEND=warp` | force the Warp backend |
| `PI_WARP_PANE_SHELL=posix\|powershell` | which shell the Warp pane runs (default: `powershell` on Windows, `posix` elsewhere) |
| `PI_WARP_SUBMIT_KEY=cr\|lf\|crlf` | key used to submit a line (default `cr` — LF does **not** submit in raw-mode TUIs) |
| `PI_WARP_STATE_DIR` | relocate surface directories |
| `PI_WARP_NO_LAUNCH=1` | prepare surfaces without opening UI (tests/dry-runs) |
| `PI_WARP_COMMAND_WAIT_MS` | how long the pane waits for a deferred launch command (default `15000`) |
| `PI_WARP_START_TIMEOUT_MS` | how long the parent tolerates a pane that never bootstrapped (default `60000`) |
| `PI_WARP_SURFACE_TTL_MS` | age at which an exited surface directory is reaped (default 24 h) |
| `PI_WARP_SURFACE_RETAIN` | how many finished surfaces to keep (default `50`) |
| `PI_WARP_BIN`, `PI_WARPCTRL_BIN` | override binary discovery |
| `PI_WARP_SH` | POSIX shell used to write into a pane's FIFO (Windows: auto-detected Git Bash/MSYS2 `sh`) |
| `PI_WARP_DATA_DIR` | Warp portable user-data root that holds `tab_configs/` |
| `PI_WARP_KEEP_TAB=1` | leave the tab open after the subagent exits (default: the pane shell exits and Warp closes the tab) |

## Optional: Warp Scripting (`warpctrl`)

If you enable **Settings > Scripting** (and install the CLI via the command palette,
"Install Warp Control CLI command"), the backend additionally uses `warpctrl` for pane
rename, real pane close and splits. It is never required; on Windows it is unavailable.

## Troubleshooting

**Injected text appears but is not submitted.** That is the LF/CR issue — ensure
`PI_WARP_SUBMIT_KEY` is unset or `cr`. Also check **Settings > Agents > Third-party CLI
agents**: Warp auto-detects `pi` as a CLI agent and its *Rich Input* editor can take
keyboard focus ("Auto open on session start"). Turn that off for unattended panes.

**No tab opens at all.** Check that `warpDiagnostics().tabConfigDir` is the directory
your Warp install actually reads — the generated config must show up in Warp's `+` menu
under *Tab configs*. If it does not, point `PI_WARP_DATA_DIR` at the right root.

**Pane shows `running` but nothing is there.** `readStatus()` reconciles against the OS:
if the recorded pid is dead it flips to `exited` and appends the done sentinel. Call
`warpCloseSurface(id)` to reap orphaned children.

**Diagnostics.** `warpDiagnostics()` reports binaries, tab-config/data/state dirs and
whether `warpctrl` answers.

## Tests

```bash
npm test                                                   # unit (no Warp needed)
node --test test/integration/warp-surface.test.ts          # live; skips unless inside Warp
```
