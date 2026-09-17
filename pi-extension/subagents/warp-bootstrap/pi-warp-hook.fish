# pi-warp-hook.fish — sourced from ~/.config/fish/config.fish
if status is-interactive; and test "$TERM_PROGRAM" = WarpTerminal; and not set -q PI_WARP_HOOK
    if test -f "$PWD/.pi-warp-surface"; and test -f "$PWD/surface.json"
        set -l pi_warp_bootstrap "__PI_WARP_BOOTSTRAP__"
        if test -f $pi_warp_bootstrap
            exec bash $pi_warp_bootstrap $PWD
        else
            echo "pi-interactive-subagents: bootstrap missing at $pi_warp_bootstrap" >&2
        end
    end
end
