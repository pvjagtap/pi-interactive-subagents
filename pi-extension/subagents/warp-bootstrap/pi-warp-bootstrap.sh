#!/usr/bin/env bash
# pi-warp-bootstrap.sh — pane driver for the Warp backend of
# pi-interactive-subagents.
#
# Invoked by the shell hook (see pi-warp-hook.sh) when an interactive Warp shell
# starts inside a surface directory, or directly:
#
#   bash pi-warp-bootstrap.sh /path/to/surface-dir
#
# Responsibilities:
#   * load surface.env (a shell-quoted twin of surface.json — we deliberately do
#     NOT parse JSON here; sed-based parsing silently truncates any value
#     containing a quote or backslash, and those values get executed)
#   * cd into the real working directory and name the Warp tab
#   * run the requested command under a pty, mirroring output to out.log
#   * splice in.fifo into the child's stdin so the parent pi session can send
#     text / Escape to a running TUI
#   * emit __SUBAGENT_DONE_<code>__ and status.json on exit
set -uo pipefail

SURFACE_DIR="${1:-${PI_SUBAGENT_SURFACE_DIR:-$PWD}}"
ENV_FILE="$SURFACE_DIR/surface.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "pi-warp-bootstrap: no surface.env in $SURFACE_DIR" >&2
  exit 64
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

SURFACE_ID="${PI_WARP_ID:-unknown}"
SURFACE_NAME="${PI_WARP_NAME:-subagent}"
TARGET_CWD="${PI_WARP_CWD:-$SURFACE_DIR}"
COMMAND="${PI_WARP_COMMAND:-}"
LOG="${PI_WARP_LOG:-$SURFACE_DIR/out.log}"
FIFO="${PI_WARP_INPUT:-$SURFACE_DIR/in.fifo}"
STATUS="${PI_WARP_STATUS:-$SURFACE_DIR/status.json}"

export PI_SUBAGENT_SURFACE="$SURFACE_ID"
export PI_SUBAGENT_SURFACE_DIR="$SURFACE_DIR"
export PI_WARP_SURFACE_NAME="$SURFACE_NAME"
export PI_WARP_HOOK=1

# Strip control bytes from the name before it reaches an OSC string: a name is
# caller-supplied data, and raw ESC/BEL in a title sequence is escape injection.
SAFE_NAME=$(printf '%s' "$SURFACE_NAME" | tr -d '\000-\037\177' | cut -c1-80)
TAB_TITLE="${PI_WARP_TAB_PREFIX:-pi} ▸ $SAFE_NAME"

# Name the Warp tab after the subagent.
#
# Warp derives tab titles from the shell's cwd (warp_set_title_idle_on_precmd),
# and our pane starts inside the surface directory — so without this the tab
# reads ".../surfaces/wmu4xc1a5d73gl" and you cannot tell which subagent it is.
# WARP_DISABLE_AUTO_TITLE stops Warp reclaiming the title on the next prompt.
# `warpctrl pane rename` would be the native route, but Scripting is off by
# default and absent on Windows, so OSC 0 is the portable answer.
export WARP_DISABLE_AUTO_TITLE=1
set_tab_title() { printf '\033]0;%s\a' "$1"; }
set_tab_title "$TAB_TITLE"

write_status() { # write_status <state> [exit-code] [child-pid]
  # Atomic: the parent process writes this file too (reconciliation on close).
  # A plain redirect lets a reader observe a half-written file.
  local tmp="$STATUS.$$.tmp"
  printf '{"id":"%s","pid":%s,"childPid":%s,"state":"%s","exitCode":%s,"rows":%s,"cols":%s,"title":"%s","updatedAt":%s}\n' \
    "$SURFACE_ID" "$$" "${3:-${CHILD_PID:-null}}" "$1" "${2:-null}" \
    "${WIN_ROWS:-24}" "${WIN_COLS:-80}" "${SAFE_NAME:-}" "$(date +%s000)" > "$tmp" && mv -f "$tmp" "$STATUS"
}

cleanup() {
  local code=$?
  kill "${FEEDER_PID:-0}" "${TTY_PID:-0}" 2>/dev/null
  rm -f "$FIFO" "$SURFACE_DIR/stdin.pipe" "$SURFACE_DIR/.pi-warp-surface" 2>/dev/null
  write_status exited "$code"
  set_tab_title "$TAB_TITLE (exit $code)"
  # Sentinel contract shared with the psmux/WezTerm backends.
  printf '__SUBAGENT_DONE_%s__\n' "$code" >> "$LOG"
  stty sane 2>/dev/null
}
trap cleanup EXIT

cd "$TARGET_CWD" 2>/dev/null || cd "$SURFACE_DIR"

# Capture the real pane geometry BEFORE stdin is swapped for the injection pipe.
# `script` sizes its pty from its own stdin; ours is a FIFO, which would leave the
# child at a default 80x24 box inside a full-size Warp tab.
WIN_ROWS=24; WIN_COLS=80
if [ -t 0 ]; then
  read -r WIN_ROWS WIN_COLS < <(stty size 2>/dev/null || echo "24 80")
fi
[ -n "$WIN_ROWS" ] && [ "$WIN_ROWS" -gt 0 ] 2>/dev/null || WIN_ROWS=24
[ -n "$WIN_COLS" ] && [ "$WIN_COLS" -gt 0 ] 2>/dev/null || WIN_COLS=80
export LINES="$WIN_ROWS" COLUMNS="$WIN_COLS"

[ -p "$FIFO" ] || { rm -f "$FIFO"; mkfifo "$FIFO"; }
write_status running

if [ -z "$COMMAND" ]; then
  # Idle surface: interactive shell driven through the same stdin splice, so
  # the parent can `sendCommand` into it exactly like `psmux send-keys`.
  COMMAND="${SHELL:-/bin/bash} -i"
fi

# Keep a writer open so the FIFO never sees EOF between sends.
exec 9<>"$FIFO"

pty_run() {
  # `script` gives the child a real pty (TUIs stay happy) and mirrors everything
  # to $LOG. The prefix runs *inside* the pty so the child starts at the pane's
  # real geometry. It contains ONLY integers — the tab title used to be spliced
  # in here too, which meant quoting caller-supplied text inside a shell string
  # inside another shell string, and that quoting broke on names containing
  # quotes. The title is re-asserted from this process instead (see below).
  #
  # Dispatch on the OS, never on `script --version`: BSD/macOS script has no
  # such flag and would treat "version" as the transcript FILE argument, i.e.
  # it would start a real interactive shell on our tty and block forever.
  local sized="stty rows ${WIN_ROWS:-24} cols ${WIN_COLS:-80} 2>/dev/null; $1"
  case "$(uname -s 2>/dev/null)" in
    Darwin|*BSD*)
      # BSD: script [-q] [-F pipe] file command ...
      script -q -F "$LOG" /bin/sh -c "$sized"
      ;;
    *)
      # util-linux: script [-q] [-f flush] [-e exit-code] -c command file
      script -qfe -c "$sized" "$LOG"
      ;;
  esac
}

# Propagate live window resizes into the child's pty. `script` cannot forward
# SIGWINCH for us because its own stdin is not a terminal.
apply_pty_size() {
  local r c ctty
  read -r r c < <(stty size < /dev/tty 2>/dev/null || echo "$WIN_ROWS $WIN_COLS")
  [ -n "$r" ] && [ "$r" -gt 0 ] 2>/dev/null || return 0
  WIN_ROWS=$r; WIN_COLS=$c
  CHILD_PID=$(pgrep -P "${RUN_PID:-0}" 2>/dev/null | head -n1)
  write_status running
  [ -n "${CHILD_PID:-}" ] || return 0
  ctty=$(ps -o tty= -p "$CHILD_PID" 2>/dev/null | tr -d ' ')
  [ -n "$ctty" ] && [ "$ctty" != "?" ] || return 0
  stty -F "/dev/$ctty" rows "$r" cols "$c" 2>/dev/null
}

# Merge the user's keystrokes with anything the parent pushes into the FIFO.
# Both feeders write into one pipe that the pty child reads, so `pty_run` stays
# in the *foreground*: when the child exits we get control back immediately and
# the EXIT trap can publish the sentinel (a piped pty_run would otherwise block
# until the tty reader noticed SIGPIPE).
STDIN_PIPE="$SURFACE_DIR/stdin.pipe"
[ -p "$STDIN_PIPE" ] || { rm -f "$STDIN_PIPE"; mkfifo "$STDIN_PIPE"; }
exec 8<>"$STDIN_PIPE"

if [ -t 0 ]; then
  stty raw -echo 2>/dev/null
  ( cat /dev/tty > "$STDIN_PIPE" 2>/dev/null ) & TTY_PID=$!
fi
( cat <&9 > "$STDIN_PIPE" 2>/dev/null ) & FEEDER_PID=$!

pty_run "$COMMAND" < "$STDIN_PIPE" &
RUN_PID=$!

# Re-apply geometry on every resize, plus once shortly after start so the child
# has settled into its pty (this is also where childPid gets published).
trap apply_pty_size WINCH
( sleep 0.4; kill -WINCH $$ 2>/dev/null ) &

# Re-assert the tab title after the child has started: shell integrations set
# their own title on first prompt, and WARP_DISABLE_AUTO_TITLE only stops Warp's
# own hook. Writing to our stdout (the Warp tty) avoids quoting caller data into
# any shell string.
( sleep 1; set_tab_title "$TAB_TITLE"; sleep 2; set_tab_title "$TAB_TITLE" ) &

CODE=0
while kill -0 "$RUN_PID" 2>/dev/null; do
  wait "$RUN_PID"
  CODE=$?
  # `wait` also returns when a trapped signal (WINCH) interrupts it; only the
  # real exit ends the loop, which `kill -0` above confirms.
done

kill "${TTY_PID:-0}" "${FEEDER_PID:-0}" 2>/dev/null
exit $CODE
