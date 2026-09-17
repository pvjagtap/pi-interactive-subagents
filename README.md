# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in psmux, WezTerm or **Warp** panes on **Linux** and **Windows**. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `isub()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with elapsed time and progress. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)    8 msgs (5.1KB)   │
│ 00:45  Scout: DB (scout)     12 msgs (9.3KB)   │
╰─────────────────────────────────────────────────╯
```

For parallel execution, just call `isub` multiple times — they all run concurrently:

```typescript
isub({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
isub({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Requires one supported surface host: [psmux](https://github.com/nicobailon/psmux) (a
tmux-compatible multiplexer written in Rust that works natively on **Windows**),
[WezTerm](https://wezfurlong.org/wezterm/), or [Warp](https://www.warp.dev).

Start pi inside psmux:

```bash
psmux new -s pi -- pi
```

### Warp

Warp is supported on **Linux and Windows**. It ships no multiplexer CLI, so a
guarded shell-profile hook hands each newly opened tab to the pane bootstrap —
that is the only setup step:

```bash
node scripts/install-warp-hook.mjs --install     # add the hook
node scripts/install-warp-hook.mjs --status      # check what is installed
node scripts/install-warp-hook.mjs --uninstall   # fully reversible
```

Then open a **new** Warp tab. Until the hook is present, Warp is not advertised as
a backend and the setup hint explains why. Sub-agents finish by calling the
`subagent_done` tool — it writes an exit sidecar file that the parent polls — so
nothing depends on screen scraping and no one types `/exit`.

| Variable | Purpose |
| -------- | ------- |
| `PI_MUX_BACKEND=warp` | force the Warp backend |
| `PI_WARP_SUBMIT_KEY` | key used to submit a line (`cr` default; LF does not submit in raw-mode TUIs) |
| `PI_WARP_SCREEN=raw` | return the stripped transcript instead of the rendered screen |
| `PI_WARP_NO_LAUNCH=1` | prepare surfaces without opening any UI (tests/dry-runs) |

On Windows, Git Bash / MSYS2 / WSL panes get full parity; PowerShell panes run in
a reduced "direct mode" (launch and completion work, live injection does not).
See [docs/warp-backend.md](docs/warp-backend.md) for the full guide and platform
matrix, and [ADR-0011](docs/adr/0011-warp-terminal-class-1-backend.md) for the design.

## What's Included

### Extensions

**Subagents** — 4 tools + 3 commands:

| Tool              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `isub`        | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately) |
| `isub_list`  | List available agent definitions                                                |
| `isub_set_tab_title`   | Update tab/window title to show progress                                        |
| `isub_resume` | Resume a previous sub-agent session (async)                                     |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/isub-plan`                    | Start a full planning workflow       |
| `/isub-iterate`                 | Fork into a subagent for quick fixes |
| `/isub <agent> <task>` | Spawn a named agent directly         |

**Session Artifacts** — 2 tools for session-scoped file storage:

| Tool             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `write_artifact` | Write plans, context, notes to a session-scoped directory |
| `read_artifact`  | Read artifacts from current or previous sessions          |

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Opus (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Haiku                  | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Sonnet                 | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Opus (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Sonnet                 | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |
| **poteto**        | inherits               | Deliberate general-purpose orchestrator — delegates recon/impl/review, integrates results |
| **adversarial-reviewer** | high thinking   | Multi-wave adversarial review with fresh, cross-family reviewers                          |
| **spec**          | see `agents/spec.md`   | Turns a rough idea into a written specification                                          |
| **claude-code**   | Claude Code CLI        | Delegates to the local `claude` CLI                                                      |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

### Bundled Skills

| Skill                | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `isub-orchestrate`   | Bounded multi-agent review: evidence pinning, fan-out with fresh reviewers, synthesis |

---

## Tool Namespace

All tools are namespaced under `isub*` so this package can be installed next to
other subagent packages (Pi refuses to load an extension whose tool names are
already taken).

| Old name             | Current name           |
| -------------------- | ---------------------- |
| `subagent`           | `isub`                 |
| `subagents_list`     | `isub_list`            |
| `subagent_interrupt` | `isub_interrupt`       |
| `subagent_resume`    | `isub_resume`          |
| `set_tab_title`      | `isub_set_tab_title`   |
| `/subagent`          | `/isub`                |
| `/plan`              | `/isub-plan`           |
| `/iterate`           | `/isub-iterate`        |

The old names are still accepted in `deny-tools:` frontmatter and `PI_DENY_TOOLS`
for backward compatibility.

### Backend gating (coexisting with other subagent packages)

This package only registers its tools and commands when the pi session is
actually running inside a backend it drives:

| Backend | Detected via                                    |
| ------- | ----------------------------------------------- |
| psmux   | `PSMUX_SESSION` (or `TMUX` on Windows) + binary |
| WezTerm | `WEZTERM_PANE` + `wezterm` binary               |
| Warp    | `TERM_PROGRAM=WarpTerminal` + installed pane hook |

If neither is present, `isub*` tools and `/isub*` commands are **not registered
at all** — so the model never sees a tool it cannot use, and there is no
ambiguity when another subagent framework (e.g. `pi-herdr-agents`, which drives
`herdr` and detects `HERDR_ENV=1`) is installed side by side. Inside psmux,
WezTerm or Warp you get the `isub*` tools; inside herdr you get theirs.

Registration uses the same detection the operations enforce, so no configuration
can expose a surface the multiplexer cannot serve. Use
`PI_MUX_BACKEND=psmux|wezterm|warp` to pick a backend when several are available.
Warp is tried last, so a multiplexer running *inside* a Warp window still wins.

---

## Async Subagent Flow

```
1. Agent calls isub()         → returns immediately ("started")
2. Sub-agent runs in mux pane     → widget shows live progress
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as interrupt
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ──────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)      15 msgs (12KB) │
│ 00:45  Researcher (researcher)   8 msgs (6KB)  │
│ 00:12  Scout: DB (scout)             starting…  │
╰─────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
isub({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Fork — sub-agent gets full conversation context
isub({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Override agent defaults
isub({
  name: "Worker",
  agent: "worker",
  model: "anthropic/claude-haiku-4-5",
  task: "Quick fix...",
});

// Custom working directory
isub({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter      | Type    | Default  | Description                                                             |
| -------------- | ------- | -------- | ----------------------------------------------------------------------- |
| `name`         | string  | required | Display name (shown in widget and pane title)                           |
| `task`         | string  | required | Task prompt for the sub-agent                                           |
| `agent`        | string  | —        | Load defaults from agent definition                                     |
| `fork`         | boolean | `false`  | Copy current session for full context                                   |
| `model`        | string  | —        | Override agent's default model                                          |
| `systemPrompt` | string  | —        | Append to system prompt                                                 |
| `skills`       | string  | —        | Comma-separated skill names                                             |
| `tools`        | string  | —        | Comma-separated tool names                                              |
| `cwd`          | string  | —        | Working directory for the sub-agent (see [Role Folders](#role-folders)) |

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `isub_resume`.

**Parameters:**
- `message` (required): What you need help with

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `isub_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/isub-plan` Workflow

The `/isub-plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/isub-iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This forks the current session into a subagent with full conversation context. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `isub_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn — no `subagent_done` call needed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |

---

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all spawning tools (`isub`, `isub_list`, `isub_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: isub, isub_set_tab_title
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
isub({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
isub({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: isub, isub_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)
  - [Warp](https://www.warp.dev) (run `node scripts/install-warp-hook.mjs --install` once)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
# or
# just run pi inside Warp (after installing the pane hook)
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm
```

## License

MIT
