# pi-warp-hook.sh — sourced from ~/.bashrc / ~/.zshrc (bash + zsh).
#
# Guarded: only fires for interactive Warp shells that start inside a
# pi-interactive-subagents surface directory. Everything else is a no-op.
#
# IMPORTANT — cooperation with Warpify:
# Warp bootstraps every shell it launches by piping a large script into the
# shell's stdin (the `WARP_BOOTSTRAP_VAR` heredoc, guarded by
# `[ -z "$WARP_BOOTSTRAPPED" ]`). rc files run BEFORE that text arrives, so a
# hook that exec's the pane driver here would swallow Warp's bootstrap into the
# wrong shell — it gets echoed line-by-line at a raw-mode prompt instead of
# being eval'd. We therefore DEFER until Warp reports `WARP_BOOTSTRAPPED`, and
# only then hand the pane over.
if [ -n "${PS1:-}" ] && [ "${TERM_PROGRAM:-}" = "WarpTerminal" ] && [ -z "${PI_WARP_HOOK:-}" ]; then
  if [ -f "$PWD/.pi-warp-surface" ] && [ -f "$PWD/surface.json" ]; then
    export PI_WARP_BOOTSTRAP="__PI_WARP_BOOTSTRAP__"
    export PI_WARP_SURFACE_PWD="$PWD"

    __pi_warp_takeover() {
      # Wait for Warpify to finish; without this we corrupt Warp's own bootstrap.
      [ -z "${WARP_BOOTSTRAPPED:-}" ] && return 0
      [ -f "$PI_WARP_SURFACE_PWD/.pi-warp-surface" ] || return 0
      if [ -f "$PI_WARP_BOOTSTRAP" ]; then
        exec bash "$PI_WARP_BOOTSTRAP" "$PI_WARP_SURFACE_PWD"
      else
        echo "pi-interactive-subagents: bootstrap missing at $PI_WARP_BOOTSTRAP" >&2
      fi
    }

    if [ -n "${ZSH_VERSION:-}" ]; then
      precmd_functions+=(__pi_warp_takeover)
    else
      PROMPT_COMMAND="__pi_warp_takeover${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
    fi
  fi
fi
