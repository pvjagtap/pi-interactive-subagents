# Gap analysis: `pi-herdr-agents` → `pi-interactive-subagents`

Compared trees:
- **Ours (A):** `~/.pi/agent/git/github.com/pvjagtap/pi-interactive-subagents` @ `208d06f` — v2.1.0, ~3.4k LOC extension, backends: **psmux + wezterm** (`cmux.ts`), peer dep `@mariozechner/pi-* ^0.65`.
- **Theirs (B):** `~/.pi/agent/npm/node_modules/pi-herdr-agents` — v1.6.0, ~11.3k LOC extension, backend: **herdr** (`terminal.ts` + `herdr.ts`), peer dep `@earendil-works/pi-* ^0.84`.

Both descend from HazAT's original. B is a much larger, modularized rewrite on the newer Pi API.

## 1. Tools

| Tool | A | B |
|---|---|---|
| `subagent` | yes | yes (+worktree, +persistent, +thinking, +model fallbacks, +routing guidelines) |
| `subagents_list` | yes | yes (richer status/lifecycle output) |
| `subagent_interrupt` | yes | yes |
| `subagent_resume` | yes | yes |
| `subagent_send` | **missing** | yes — send follow-up task to a persistent specialist |
| `subagent_stop` | **missing** | yes — stop a persistent specialist |
| `set_tab_title` | yes | *not present in B* (keep ours) |

## 2. Slash commands

| Command | A | B |
|---|---|---|
| `/subagent`, `/iterate`, `/plan` | yes | yes |
| `/btw` | **missing** | yes — ephemeral side-question subagent (ADR-0001) |
| `/btw-close` | **missing** | yes |
| `/worktree` | **missing** | yes — manage Herdr-managed git worktrees |

## 3. `subagent` parameters missing in A

- `thinking` (ThinkingLevel schema, inherits/overrides parent thinking level)
- `worktree: { branch, base? }` — isolated git worktree runs, retained after completion
- `persistent` — long-lived specialist sessions fed via `subagent_send`
- `model` as an **ordered comma-separated fallback list** (A only accepts a single model)
- A-only: `resumeSessionId` (Claude Code resume) — keep.

## 4. Modules present only in B (all above the terminal-backend layer, so portable)

| File | LOC | What it adds |
|---|---|---|
| `runtime-routing.ts` | 379 | model/provider resolution, `ThinkingLevel`, exact model refs, fallback chains, authenticated model catalog, launch-fallback plans |
| `status.ts` | 576 | status kinds/transitions, snapshots, stall classification, elapsed formatting, aggregated status lines for the widget |
| `activity.ts` | 654 | per-subagent activity file (phase/scope/events), recorder, shutdown reasons |
| `lifecycle.ts` | 636 | explicit lifecycle state machine (pane/process/turn/activity → projection + transitions) |
| `supervision.ts` | 258 | pane-list reconciliation loop, polling, orphan detection, diagnostics |
| `launch.ts` | 1048 | launch request types, worktree launch/handoff, manifests, tool allowlist building, script runner |
| `completion.ts` | 203 | exit-sidecar interpretation + `waitForCompletion` (A does this inline via `pollForExit`) |
| `wake.ts` | 102 | wake reasons/registrations for steering the parent |
| `pane-config.ts` | 135 | pane mode/direction config + pane factory |
| `model-config.ts` | 112 | default model config resolution |
| `role-config.ts` | 96 | role pack config |
| `persistent-config.ts` | 114 | persistent-specialist caps/config |
| `type-guards.ts` | 46 | runtime validation at I/O boundaries |
| `herdr.ts` / `terminal.ts` | 992 | backend layer — **do not port**, ours is `cmux.ts` |

B also has: role-pack discovery event (`pi-herdr-subagents:roles:discover:v1`), `examples/role-pack/`, `config.json.example`.

## 5. Agents / skills / docs

- Agents only in B: `poteto.md`, `adversarial-reviewer.md`.
- Agents only in A: `spec.md`, `claude-code.md` (keep).
- Skills only in B: `skills/orchestrate/` (SKILL.md, adversarial-review.md, example js) — B declares `pi.skills`; A declares none.
- Docs only in B: 10 ADRs (`docs/adr/0001..0010`), research notes, worktree docs, `CONTEXT.md`, `AGENTS.md`, `RELEASING.md`, `CHANGELOG.md`.
- Tooling only in B: biome + oxlint, auto-changelog, eval tests, `test:integration:live`.
- `plan-skill.md`: A 225 lines vs B 279 — B's version is newer.

## 6. A-only things to preserve during any port

- psmux/wezterm backends and Windows binary discovery (`cmux.ts`).
- `session-artifacts` extension (`pi-extension/session-artifacts/index.ts`, 252 LOC) — absent in B.
- `set_tab_title` tool, Claude Code plugin hooks (`plugin/hooks/*`), `resumeSessionId`, `spec`/`claude-code` agents.

## 7. Suggested port order

1. ~~**Low risk, no API change:** orchestrate skill, `poteto` + `adversarial-reviewer` agents, ADRs.~~ **DONE** — ported as `skills/isub-orchestrate/`, `agents/poteto.md`, `agents/adversarial-reviewer.md`, `docs/adr/`; worktree/`thinking`-param references rewritten for this package's feature set.
2. **Self-contained modules:** `type-guards.ts`, `completion.ts`, `status.ts`, `activity.ts`, `lifecycle.ts` — pure logic, adapt imports only. **NEXT**
3. **Config layer:** `model-config`, `pane-config`, `role-config`, `persistent-config` + `runtime-routing` (thinking levels, model fallbacks).
4. **Tools/commands:** `isub_send`, `isub_stop`, `/isub-btw`, `/isub-btw-close` on top of (3).
5. **Worktrees:** `launch.ts` worktree handoff + `/isub-worktree`, re-expressed over `cmux.ts` instead of `herdr.ts`. Biggest job.
6. **Supervision:** `supervision.ts` needs `listPanes`/`inspectPane` equivalents in `cmux.ts` (psmux/wezterm `list-panes`), currently missing.

~~Blocking prerequisite for 3–6: bump peer deps~~ **DONE** — peer/dev deps are now `@earendil-works/pi-* ^0.85.0`; all 29 unit tests pass.

## 8. Tool namespace (done)

Tools renamed to the `isub*` namespace so both packages can be installed at once
(Pi fails an extension whose tool name is already registered). Commands renamed
to `/isub`, `/isub-plan`, `/isub-iterate`; skill renamed to `isub-orchestrate`.
Legacy names still resolve in `deny-tools` / `PI_DENY_TOOLS`.

## 9. Backend disambiguation (done here, missing in herdr)

Both packages historically detected their multiplexer **only at tool-execution
time**:

- ours: `getMuxBackend()` — `PSMUX_SESSION`/`TMUX` + psmux binary, or `WEZTERM_PANE` + wezterm binary
- herdr: `isHerdrAvailable()` — `HERDR_ENV === "1"` + `herdr` binary

herdr registers its tools unconditionally and only returns
`"herdr is not available. <hint>"` when called, so with both packages installed
the model sees 11 spawn-ish tools and can waste a call on the wrong framework.

This package now gates **registration** on backend detection: outside psmux /
WezTerm no `isub*` tool or `/isub*` command is registered at all (override:
`PI_ISUB_FORCE=1`). Tool descriptions also name the active backend. Verified:

```
$ pi -p "list tools starting with isub or subagent"   # plain terminal
subagent, subagent_send, subagent_stop, subagent_interrupt, subagents_list, subagent_resume

$ PI_ISUB_FORCE=1 pi -p "..."
isub, isub_list, isub_set_tab_title, isub_interrupt, isub_resume
```

Remaining exposure is herdr's side; an upstream PR moving its registrations
behind `isTerminalAvailable()` would make the split symmetric.
