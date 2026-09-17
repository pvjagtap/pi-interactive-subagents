# ADR-0011: Warp Terminal as a class-1 backend

Status: accepted (amended 2026-09-17 — see "Amendment: tab configs replace the shell hook")
Date: 2026-09-16
Supersedes: none. Extends the backend layer defined in `pi-extension/subagents/cmux.ts`.

## Context

`cmux.ts` abstracts a terminal *multiplexer* behind seven primitives: create surface,
split, rename, send command, send Escape, read screen, close surface, plus
`pollForExit`. psmux and WezTerm both expose a scripting CLI that implements these
directly (`send-keys`, `capture-pane`, `cli send-text`, `cli get-text`).

Warp has no such CLI. Investigation of Warp `v0.2026.09.09.08.26.stable_02` on Linux
found:

| Capability | Warp | Notes |
|---|---|---|
| Open a tab at a path | ✅ | `warp://action/new_tab?path=…` — verified working, no settings required |
| Open a tab *running a command* | ✅ | tab configs, opened with `warp://tab_config/<file stem>` — see the amendment below |
| Send text to a pane | ⚠️ | `warpctrl input insert/replace` **stages text only**; Warp deliberately ships no "submit" action |
| Capture pane output | ❌ | no equivalent of `capture-pane` / `get-text` |
| Pane/tab management | ⚠️ | `warpctrl pane split/rename/close`, `tab create/rename/close` — **disabled by default** on public channels, gated behind Settings > Scripting |
| Windows support | ❌ | "On Windows, local-control publication is disabled until authenticated broker transport is supported" (bundled `warpctrl` skill) |

So `warpctrl` cannot be the foundation: it is optional, off by default, absent on
Windows, and missing the two primitives we need most.

## Decision

Implement Warp as a **surface-directory handshake** rather than keystroke injection.

1. Allocate `…/warp/surfaces/<id>/` containing `surface.json` (cwd, command, env,
   log/input/status paths) and a `.pi-warp-surface` marker.
2. Open a Warp tab **rooted at that directory** and running the pane driver, via a
   generated tab config (see the amendment below).
3. `pi-warp-bootstrap` becomes the pane driver:
   - runs the command under a pty (`script -qfe`), so TUIs get a real terminal;
   - mirrors output to `out.log` → implements `readScreen`;
   - splices `in.fifo` into the child's stdin → implements `sendCommand`/`sendEscape`,
     reaching a *running* TUI, not just a shell prompt;
   - writes `status.json` and `__SUBAGENT_DONE_<code>__` on exit.
4. `warpctrl` is used only for cosmetics and better close semantics **when present**.
   Every call site degrades silently.

The surface id is minted by us and *is* the pane handle, because Warp exposes no
addressable pane ids without local control.

### Completion is sidecar-first, not screen-first

`subagent_done` writes `${PI_SUBAGENT_SESSION}.exit`, and `pollForExit` checks that
sidecar **before** reading the screen. Sub-agents therefore terminate by calling the
tool (with `PI_SUBAGENT_AUTO_EXIT=1`), never by typing `/exit`. This keeps Warp's
weakest primitive (screen capture) off the critical path — it is only a crash-detection
fallback. Verified live: `pollForExit → {"reason":"done","exitCode":0}`.

### Submit key is CR, not LF

Verified experimentally: injecting `\n` leaves text sitting unsubmitted in a raw-mode
TUI's input box, while `\r` (what a physical Enter sends) submits. `warpSendCommand`
therefore terminates with CR; a pty in canonical mode maps CR→NL so shells are
unaffected. Override with `PI_WARP_SUBMIT_KEY=cr|lf|crlf`.

### The hook must defer to Warpify

*(Superseded by the amendment below — kept because it records why the hook approach was
fragile.)*

Warp bootstraps each shell by **piping a large script into the shell's stdin** (the
`WARP_BOOTSTRAP_VAR` heredoc, guarded by `[ -z "$WARP_BOOTSTRAPPED" ]`). rc files run
*before* that text arrives. A hook that `exec`s the pane driver from `.bashrc` swallows
Warp's bootstrap into the wrong shell, where it is echoed line-by-line at a raw-mode
prompt instead of being eval'd (observed). The hook therefore defers via
`PROMPT_COMMAND`/`precmd_functions` and only takes over once `WARP_BOOTSTRAPPED` is set.
This also matches Warp's documented guidance to guard rc customisations with
`[[ $TERM_PROGRAM == "WarpTerminal" ]]`.

## Amendment: tab configs replace the shell hook

The original table entry above was wrong. Warp **does** expose a URI for tab configs:
`warp://tab_config/<name>`, where `<name>` is the config's **file stem** (matched
case-insensitively), not its `name` field. A config may declare a pane `directory` plus
a `commands` array, which is exactly the "open a tab running a command" primitive the
hook existed to synthesise.

Verified on Warp `v0.2026.09.09.08.26.stable_02` (Windows): dropping a new TOML into the
tab-configs directory and opening the URI ran the command in a fresh tab, with no restart
and no settings toggle.

The directory is platform-specific, and getting it wrong fails silently — Warp simply
never lists the config:

| Platform | `tab_configs` location |
|---|---|
| Windows | `%APPDATA%\warp\Warp\data\tab_configs\` |
| macOS | `~/.warp/tab_configs/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/warp-terminal/tab_configs/` (unverified) |

Warp on Windows explicitly does not read `~/.warp/tab_configs/`.

Consequently the shell-profile hook (`pi-warp-hook.*`, `scripts/install-warp-hook.mjs`,
the `pi-warp-hook` bin entry and the hook receipt) is **removed**. This also removes the
worst property of the old design: on Windows the hook had to be written into the
PowerShell `$PROFILE`, which on managed machines lives under a redirected — often
OneDrive-synced — Documents folder.

Surfaces now write `tab_configs/pi_subagent_<id>.toml` at creation and delete it on
dispose, so Warp's `+` menu does not accumulate stale entries.

## Consequences

**Positive**
- Warp becomes class-1 on Linux, Windows and macOS without requiring Warp's Scripting
  toggle and without touching any shell profile.
- No new runtime dependencies; the pty comes from `util-linux`'s `script`.
- `sendCommand`/`sendEscape` reach running TUIs, so `subagent_send` and
  `subagent_interrupt` work.
- Orphans are reconciled from the OS (`readStatus` verifies the pid), which Warp itself
  cannot report.

**Negative / accepted**
- Depends on Warp's tab-config directory layout, which is undocumented per-channel and
  differs by platform. `PI_WARP_DATA_DIR` is the escape hatch.
- `readScreen` returns the pane **transcript**, not a rendered screen grid, so a
  full-screen TUI yields redraw noise. Acceptable because completion is sidecar-driven;
  a VT-renderer pass is the future improvement.
- Windows PowerShell panes run in "direct mode" (no pty splice). Git Bash / MSYS2 / WSL
  panes get full parity via the same bash bootstrap; Warp on Windows does not support
  `cmd.exe` or `fish` at all, so PowerShell + Git Bash are the two supported shells.
- `warpctrl` remains optional and may disappear between Warp releases; no code path
  depends on it.

## Alternatives rejected

- **`warpctrl` as the backend** — off by default, unavailable on Windows, no submit and
  no capture. Cannot implement the interface.
- **A guarded shell-profile hook** — the original decision; replaced once tab configs
  were found to be programmatically openable. It required writing into `$PROFILE` /
  rc files, had to race Warp's own shell bootstrap, and gated availability on an install
  step.
- **Log-viewer panes (`tail -f`)** — breaks interactivity, which is the point of this
  package.
- **`node-pty` dependency** — heavier than `script`, and native builds would burden
  every install. Left as an optional upgrade path for Windows PowerShell parity.
