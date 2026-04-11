---
name: plan
description: >
  Planning workflow. Spawns a spec agent to clarify WHAT to build, then a
  planner agent to figure out HOW. Use when asked to "plan", "brainstorm",
  "I want to build X", or "let's design". Requires the subagents extension
  and a supported multiplexer (cmux/tmux/zellij).
---

# Plan

A planning workflow that separates WHAT (spec) from HOW (plan). First a spec agent clarifies intent and requirements with the user, then a planner figures out the technical approach and creates todos.

**Announce at start:** "Let me take a quick look, then I'll send a scout to map the codebase before we start the spec session."

---

## Tab Titles

Use `set_tab_title` to keep the user informed of progress in the multiplexer UI. Update the title at every phase transition.

| Phase         | Title example                                                  |
| ------------- | -------------------------------------------------------------- |
| Assessment    | `🔍 Assessing: <short task>`                                   |
| Scouting      | `🔍 Scouting: <short task>`                                    |
| Spec          | `📝 Spec: <short task>`                                        |
| Planning      | `💬 Planning: <short task>`                                    |
| Review plan   | `📋 Review: <short task>`                                      |
| Executing     | `🔨 Executing: 1/3 — <short task>` (update counter per worker) |
| Reviewing     | `🔎 Reviewing: <short task>`                                   |
| Done          | `✅ Done: <short task>`                                        |

Name subagents with context too:

- Scout: `"🔍 Scout"` (default is fine)
- Spec: `"📝 Spec"`
- Planner: `"💬 Planner"`
- Workers: `"🔨 Worker 1/3"`, `"🔨 Worker 2/3"`, etc.
- Reviewer: `"🔎 Reviewer"`

---

## The Flow

```
Phase 1: Quick Assessment (main session — 30s orientation)
    ↓
Phase 2: Scout (autonomous — deep codebase context)
    ↓
Phase 3: Spawn Spec Agent (interactive — clarifies WHAT, has scout context)
    ↓
Phase 4: Spawn Planner Agent (interactive — figures out HOW, has scout context)
    ↓
    Optional: Re-scout if spec/planner significantly changed scope
    ↓
Phase 5: Review Plan & Todos (main session)
    ↓
Phase 6: Execute Todos (workers — receive plan + scout context)
    ↓
Phase 7: Review
```

---

## Phase 1: Quick Assessment

Quick orientation — just enough to give the scout a focused mission:

```bash
ls -la
find . -type f -name "*.ts" | head -20  # or relevant extension
cat package.json 2>/dev/null | head -30
```

Spend ~30 seconds. You're looking for: tech stack, project shape, and the area relevant to the user's request. This tells you what to ask the scout to focus on.

---

## Phase 2: Scout

**Always spawn a scout before spec/planner.** The scout's context feeds into both — it helps the spec agent ask better questions and helps the planner make better design decisions.

```typescript
subagent({
  name: "🔍 Scout",
  agent: "scout",
  task: "Analyze the codebase for [user's request area]. Map file structure, key modules, patterns, conventions, and existing code related to [feature area]. Focus on what a spec agent and planner would need to understand.",
});
```

**Wait for the scout to finish.** Read the scout's context artifact — you'll pass it to both spec and planner.

---

## Phase 3: Spawn Spec Agent

Spawn the interactive spec agent with the scout's context. The `spec` agent clarifies intent, requirements, effort level, and success criteria (ISC) with the user.

```typescript
subagent({
  name: "📝 Spec",
  agent: "spec",
  interactive: true,
  task: `Define spec: [what the user wants to build]

Scout context:
[paste scout findings here — file structure, conventions, patterns, relevant code]`,
});
```

**The user works with the spec agent.** When done, they press Ctrl+D and the spec artifact path is returned.

---

## Phase 4: Spawn Planner Agent

Read the spec artifact, then spawn the planner. Pass both the spec AND the scout context. The planner takes these as input and figures out the technical approach — explores options, validates design, runs a premortem, writes the plan, and creates todos with mandatory code examples/references.

```typescript
// Read the spec first
read_artifact({ name: "specs/YYYY-MM-DD-<name>.md" });

subagent({
  name: "💬 Planner",
  agent: "planner",
  interactive: true,
  task: `Plan implementation for spec: specs/YYYY-MM-DD-<name>.md

Scout context:
[paste scout findings here — same context from Phase 2]`,
});
```

**The user works with the planner.** The planner will NOT re-clarify requirements — that's already done in the spec. It focuses on technical approach, design validation, premortem risk analysis, and creating well-scoped todos.

When done, the user presses Ctrl+D and the plan + todos are returned.

### Optional: Re-scout after planning

If the spec or planner significantly changed scope (e.g. new subsystems, different approach than expected, areas the original scout didn't cover), spawn another scout targeting the new areas:

```typescript
subagent({
  name: "🔍 Scout (updated scope)",
  agent: "scout",
  task: "The plan changed scope. Gather context for [new areas]. Read the plan at [plan path]. Focus on [specific files/modules the planner identified that weren't in the original scout].",
});
```

Fold the new context into the worker tasks.

---

## Phase 5: Review Plan & Todos

Once the planner closes, read the plan and todos:

```typescript
todo({ action: "list" });
```

Review with the user:

> "Here's what the planner produced: [brief summary]. Ready to execute, or anything to adjust?"

---

## Phase 6: Execute Todos

Spawn workers sequentially. Each worker gets the plan path and scout context:

```typescript
// Workers execute todos sequentially — one at a time
subagent({
  name: "🔨 Worker 1/N",
  agent: "worker",
  task: "Implement TODO-xxxx. Mark the todo as done. Plan: [plan path]\n\nScout context: [paste scout summary from Phase 2, plus any re-scout from Phase 4]",
});

// Check result, then next todo
subagent({
  name: "🔨 Worker 2/N",
  agent: "worker",
  task: "Implement TODO-yyyy. Mark the todo as done. Plan: [plan path]\n\nScout context: [paste scout summary]",
});
```

**Always run workers sequentially in the same git repo** — parallel workers will conflict on commits.

---

## Phase 7: Review

After all todos are complete:

```typescript
subagent({
  name: "Reviewer",
  agent: "reviewer",
  interactive: false,
  task: "Review the recent changes. Plan: [plan path]",
});
```

Triage findings:

- **P0** — Real bugs, security issues → fix now
- **P1** — Genuine traps, maintenance dangers → fix before merging
- **P2** — Minor issues → fix if quick, note otherwise
- **P3** — Nits → skip

Create todos for P0/P1, run workers to fix, re-review only if fixes were substantial.

---

## ⚠️ Completion Checklist

Before reporting done:

1. ✅ Scout ran before spec/planner?
2. ✅ Scout context was passed to spec and planner?
3. ✅ All worker todos closed?
4. ✅ Every todo has a polished commit (using the `commit` skill)?
5. ✅ Reviewer has run?
6. ✅ Reviewer findings triaged and addressed?
