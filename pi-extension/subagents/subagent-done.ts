/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor
 *   (toggle with `/subagent-tools`, or a key of your choice via PI_SUBAGENT_WIDGET_KEY)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function shouldAutoExitOnAgentEnd(
  userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  if (userTookOver) return false;

  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const toggleHint = process.env.PI_SUBAGENT_WIDGET_KEY ?? "/subagent-tools";

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", `  (${toggleHint} to collapse)`);

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", `  (${toggleHint} to expand)`);

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  let finished = false;

  // The parent polls for this sidecar; writing it is what ends its wait.
  function finish(ctx: { shutdown: () => void }): void {
    finished = true;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    }
    ctx.shutdown();
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  // session_start can sample the registry before every tool is in it, which
  // made the widget report "1 tools" while the agent actually had dozens.
  pi.on("agent_start", (_event, ctx) => {
    const names = pi.getAllTools().map((t) => t.name).sort();
    if (names.length === toolNames.length) return;
    toolNames = names;
    renderWidget(ctx, null);
  });

  // A user keystroke after the agent started means they want to steer, which
  // suspends both the auto-exit path and the done-nudge for that cycle.
  let userTookOver = false;
  let agentStarted = false;
  let nudged = false;

  pi.on("agent_start", () => {
    agentStarted = true;
  });

  pi.on("input", (event) => {
    // Our own reminder arrives as source "extension"; only a real keystroke
    // means the user wants to steer.
    if ((event as any).source !== "interactive") return;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("agent_end", (event, ctx) => {
    if (finished) return;
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = shouldAutoExitOnAgentEnd(userTookOver, messages);
    if (!shouldExit) {
      // User sent input after the agent had started, or the run was interrupted
      // with Escape. Reset takeover so auto-exit can re-engage on the next
      // normal completion cycle.
      userTookOver = false;
      return;
    }

    if (autoExit) {
      ctx.shutdown();
      return;
    }

    // An interactive subagent is supposed to call subagent_done itself, but a
    // model that reads "…and then stop" in its task just ends the turn — and the
    // parent polls forever. Ask once, then end the session on its behalf.
    if (!nudged) {
      nudged = true;
      pi.sendUserMessage(
        "Your task looks finished. Call the subagent_done tool now to hand your result back to the parent agent. " +
          "If work remains, keep going and call it when you are done.",
      );
      return;
    }

    finish(ctx);
  });

  pi.registerCommand("subagent-tools", {
    description: "Toggle the subagent tools widget",
    async handler(_args, ctx) {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  // Keys are resolved from user config, so any hardcoded default can collide and
  // print an "Extension issues" banner in every subagent pane. Opt in instead.
  const widgetKey = process.env.PI_SUBAGENT_WIDGET_KEY;
  if (widgetKey) {
    pi.registerShortcut(widgetKey, {
      description: "Toggle subagent tools widget",
      handler: (ctx) => {
        expanded = !expanded;
        renderWidget(ctx, null);
      },
    });
  }

  pi.registerTool({
    name: "set_tab_title",
    label: "Set Tab Title",
    description:
      "Set this pane's tab title so the user can see what you are working on. " +
      "Start the title with your agent tag, e.g. \"[reviewer] Auditing auth module\".",
    parameters: Type.Object({
      title: Type.String({ description: "Short title for this pane" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctx.ui.setTitle(params.title);
      return { content: [{ type: "text", text: `Tab title set to: ${params.title}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));
      finished = true;

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      finish(ctx);
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
