import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
} from "../pi-extension/subagents/session.ts";

import { shellEscape, isPsmuxAvailable } from "../pi-extension/subagents/cmux.ts";
import { charWidth, renderScreen, renderTail } from "../pi-extension/subagents/warp-screen.ts";
import {
  alignUtf8,
  WARP_SURFACE_PROTOCOL,
  createWarpSurface,
  gcWarpSurfaces,
  isInsideWarp,
  isWarpRuntimeAvailable,
  inputFileName,
  listWarpSurfaces,
  paneShell,
  readSpec,
  readStatus,
  stripAnsi,
  surfaceDir,
  tomlEscape,
  warpDiagnostics,
  warpDisposeSurface,
  warpReadScreen,
  warpSendCommand,
  warpSendText,
  writeTabConfig,
  renderSurfaceEnv,
  shQuote,
} from "../pi-extension/subagents/warp.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
} from "../pi-extension/subagents/subagent-done.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("stays open after user takeover for that cycle", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), false);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          entries: 13,
          bytes: 55.6 * 1024,
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          entries: 21,
          bytes: 115.6 * 1024,
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          entries: 27,
          bytes: 106.8 * 1024,
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: Date.now() - 5_000,
          sessionFile: "sess1",
          entries: 1,
          bytes: 1,
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    // On Windows (psmux target), shellEscape uses PowerShell double-quote escaping
    const isPS = process.platform === "win32";

    it("wraps string appropriately", () => {
      if (isPS) {
        assert.equal(shellEscape("hello"), '"hello"');
      } else {
        assert.equal(shellEscape("hello"), "'hello'");
      }
    });

    it("escapes quotes", () => {
      if (isPS) {
        assert.equal(shellEscape("it's"), '"it\'s"');
      } else {
        assert.equal(shellEscape("it's"), "'it'\\''s'");
      }
    });

    it("handles empty string", () => {
      if (isPS) {
        assert.equal(shellEscape(""), '""');
      } else {
        assert.equal(shellEscape(""), "''");
      }
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      if (isPS) {
        assert.ok(escaped.startsWith('"'));
        assert.ok(escaped.endsWith('"'));
        // PowerShell escapes $ with backtick
        assert.ok(escaped.includes('`$world'));
      } else {
        assert.ok(escaped.startsWith("'"));
        assert.ok(escaped.endsWith("'"));
        assert.ok(escaped.includes("$world"));
      }
    });
  });

  describe("isPsmuxAvailable", () => {
    it("returns boolean based on PSMUX_SESSION", () => {
      const result = isPsmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });
});

// ── Warp backend ─────────────────────────────────────────────────────────────

describe("warp.ts", () => {
  let warpDir: string;
  let prevState: string | undefined;
  let prevNoLaunch: string | undefined;
  let prevData: string | undefined;

  before(() => {
    warpDir = createTestDir();
    prevState = process.env.PI_WARP_STATE_DIR;
    prevNoLaunch = process.env.PI_WARP_NO_LAUNCH;
    prevData = process.env.PI_WARP_DATA_DIR;
    process.env.PI_WARP_STATE_DIR = warpDir;
    process.env.PI_WARP_NO_LAUNCH = "1";
    process.env.PI_WARP_DATA_DIR = join(warpDir, "warp-data");
  });

  after(() => {
    if (prevState === undefined) delete process.env.PI_WARP_STATE_DIR;
    else process.env.PI_WARP_STATE_DIR = prevState;
    if (prevNoLaunch === undefined) delete process.env.PI_WARP_NO_LAUNCH;
    else process.env.PI_WARP_NO_LAUNCH = prevNoLaunch;
    if (prevData === undefined) delete process.env.PI_WARP_DATA_DIR;
    else process.env.PI_WARP_DATA_DIR = prevData;
    rmSync(warpDir, { recursive: true, force: true });
  });

  describe("stripAnsi", () => {
    it("removes SGR sequences", () => {
      assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
    });

    it("removes OSC title sequences Warp emits", () => {
      assert.equal(stripAnsi("\u001b]0;user@host: /tmp\u0007prompt$ "), "prompt$ ");
    });

    it("normalises bare carriage returns to newlines", () => {
      assert.equal(stripAnsi("a\rb"), "a\nb");
    });

    it("leaves plain text untouched", () => {
      assert.equal(stripAnsi("__SUBAGENT_DONE_0__"), "__SUBAGENT_DONE_0__");
    });
  });

  describe("tomlEscape", () => {
    it("escapes backslashes and quotes for Windows paths", () => {
      assert.equal(tomlEscape("C:\\Users\\a b"), "C:\\\\Users\\\\a b");
      assert.equal(tomlEscape('say "hi"'), 'say \\"hi\\"');
    });
  });

  describe("createWarpSurface", () => {
    it("writes a complete surface handshake and mints an addressable id", () => {
      const id = createWarpSurface("api-worker", { cwd: warpDir, command: "echo hi" });
      assert.ok(id.length > 3);

      const dir = surfaceDir(id);
      assert.ok(existsSync(join(dir, ".pi-warp-surface")), "marker file exists");

      const spec = readSpec(id);
      assert.equal(spec.protocol, WARP_SURFACE_PROTOCOL);
      assert.equal(spec.id, id);
      assert.equal(spec.name, "api-worker");
      assert.equal(spec.cwd, warpDir);
      assert.equal(spec.command, "echo hi");
      assert.equal(spec.env.PI_SUBAGENT_SURFACE, id);
      assert.equal(spec.env.PI_SUBAGENT_SURFACE_DIR, dir);
      assert.ok(spec.log.endsWith("out.log"));
    });

    it("reports a starting status before the pane bootstraps", () => {
      const id = createWarpSurface("scout", { cwd: warpDir });
      assert.equal(readStatus(id)?.state, "starting");
    });

    it("gives each surface an isolated directory", () => {
      const a = createWarpSurface("a", { cwd: warpDir });
      const b = createWarpSurface("b", { cwd: warpDir });
      assert.notEqual(surfaceDir(a), surfaceDir(b));
      assert.equal(listWarpSurfaces().length >= 2, true);
    });
  });

  describe("warpReadScreen", () => {
    it("renders the transcript as a screen, not as sliced lines", () => {
      const id = createWarpSurface("reader", { cwd: warpDir });
      const spec = readSpec(id);
      writeFileSync(spec.log, "\u001b[32mone\u001b[0m\ntwo\nthree\nfour\n");
      assert.equal(warpReadScreen(id, 2).trim().split("\n").at(-1), "four");
      assert.ok(warpReadScreen(id, 10).includes("one"));
      assert.ok(!warpReadScreen(id, 10).includes("\u001b"));
    });

    it("shows the latest TUI frame, which naive slicing would miss", () => {
      const id = createWarpSurface("tui-reader", { cwd: warpDir });
      const spec = readSpec(id);
      const frame = (n: number) =>
        `\u001b[2J\u001b[1;1Hbanner\u001b[3;1Hprogress ${n}/3`;
      writeFileSync(spec.log, [1, 2, 3].map(frame).join(""));
      const screen = warpReadScreen(id, 10);
      assert.ok(screen.includes("progress 3/3"), screen);
      assert.ok(!screen.includes("progress 1/3"), "superseded frames are gone");
    });

    it("honours PI_WARP_SCREEN=raw for bootstrap debugging", () => {
      const id = createWarpSurface("raw-reader", { cwd: warpDir });
      writeFileSync(readSpec(id).log, "alpha\nbeta\n");
      process.env.PI_WARP_SCREEN = "raw";
      try {
        assert.ok(warpReadScreen(id, 5).includes("beta"));
      } finally {
        delete process.env.PI_WARP_SCREEN;
      }
    });

    it("returns empty string when the pane has not written anything yet", () => {
      const id = createWarpSurface("quiet", { cwd: warpDir });
      assert.equal(warpReadScreen(id, 10).trim(), "");
    });
  });

  describe("readSpec", () => {
    it("throws a clear error for an unknown surface", () => {
      assert.throws(() => readSpec("does-not-exist"), /Unknown Warp surface/);
    });
  });

  describe("tab config launch", () => {
    it("writes a tab config carrying the pane's launch command", () => {
      const id = createWarpSurface("tab cfg", { cwd: warpDir });
      const name = writeTabConfig(id);
      assert.equal(name, `pi_subagent_${id}`);

      const toml = readFileSync(
        join(process.env.PI_WARP_DATA_DIR!, "tab_configs", `${name}.toml`),
        "utf8",
      );
      // The command riding along with the tab is what removes the shell hook.
      assert.match(toml, /^commands = \[".+pi-warp-bootstrap.+"\]$/m);
      assert.match(toml, /^type = "terminal"$/m);
      assert.ok(toml.includes(tomlEscape(surfaceDir(id))));
    });

    it("removes the tab config when the surface is disposed", () => {
      const id = createWarpSurface("disposable", { cwd: warpDir });
      const file = join(
        process.env.PI_WARP_DATA_DIR!,
        "tab_configs",
        `${writeTabConfig(id)}.toml`,
      );
      assert.equal(existsSync(file), true);
      warpDisposeSurface(id);
      assert.equal(existsSync(file), false);
    });

    it("exits the pane shell so Warp closes the tab, unless PI_WARP_KEEP_TAB", () => {
      const tomlFor = (id: string) =>
        readFileSync(
          join(process.env.PI_WARP_DATA_DIR!, "tab_configs", `${writeTabConfig(id)}.toml`),
          "utf8",
        );

      assert.match(tomlFor(createWarpSurface("self closing", { cwd: warpDir })), /; exit /);

      const prev = process.env.PI_WARP_KEEP_TAB;
      process.env.PI_WARP_KEEP_TAB = "1";
      try {
        assert.doesNotMatch(tomlFor(createWarpSurface("sticky", { cwd: warpDir })), /; exit /);
      } finally {
        if (prev === undefined) delete process.env.PI_WARP_KEEP_TAB;
        else process.env.PI_WARP_KEEP_TAB = prev;
      }
    });
  });

  describe("availability gating", () => {
    it("never claims availability outside Warp without an explicit override", () => {
      const prevTerm = process.env.TERM_PROGRAM;
      const prevUuid = process.env.WARP_TERMINAL_SESSION_UUID;
      const prevLocal = process.env.WARP_IS_LOCAL_SHELL_SESSION;
      const prevOverride = process.env.PI_MUX_BACKEND;
      delete process.env.TERM_PROGRAM;
      delete process.env.WARP_TERMINAL_SESSION_UUID;
      delete process.env.WARP_IS_LOCAL_SHELL_SESSION;
      delete process.env.PI_MUX_BACKEND;
      try {
        assert.equal(isInsideWarp(), false);
        assert.equal(isWarpRuntimeAvailable(), false);
      } finally {
        if (prevTerm !== undefined) process.env.TERM_PROGRAM = prevTerm;
        if (prevUuid !== undefined) process.env.WARP_TERMINAL_SESSION_UUID = prevUuid;
        if (prevLocal !== undefined) process.env.WARP_IS_LOCAL_SHELL_SESSION = prevLocal;
        if (prevOverride !== undefined) process.env.PI_MUX_BACKEND = prevOverride;
      }
    });
  });

  describe("warpDiagnostics", () => {
    it("reports every field the doctor output needs", () => {
      const d = warpDiagnostics();
      for (const key of [
        "insideWarp",
        "tabConfigDir",
        "dataDir",
        "stateDir",
        "bootstrap",
        "platform",
      ]) {
        assert.ok(key in d, `missing ${key}`);
      }
    });
  });
});

// ── Warp VT screen renderer ──────────────────────────────────────────────────

describe("warp-screen.ts", () => {
  const opts = { rows: 5, cols: 20 };

  describe("renderScreen", () => {
    it("renders plain text with newlines", () => {
      assert.equal(renderScreen("hello\nworld", opts), "hello\nworld\n\n\n");
    });

    it("applies carriage returns as overwrites, like a real terminal", () => {
      // A progress line that rewrites itself must show only the final value.
      assert.equal(renderScreen("50%\r100%", opts).split("\n")[0], "100%");
    });

    it("honours cursor positioning (CUP) instead of printing escapes", () => {
      const out = renderScreen("\u001b[3;5Hmark", opts).split("\n");
      assert.equal(out[2], "    mark");
      assert.ok(!out.join("").includes("\u001b"));
    });

    it("clears the screen on ED(2) so stale frames do not leak", () => {
      const out = renderScreen("junk everywhere\u001b[2J\u001b[1;1Hfresh", opts);
      assert.equal(out.split("\n")[0], "fresh");
      assert.ok(!out.includes("junk"));
    });

    it("clears to end of line on EL(0)", () => {
      assert.equal(renderScreen("abcdef\u001b[4G\u001b[0K", opts).split("\n")[0], "abc");
    });

    it("drops SGR colour codes but keeps their text", () => {
      assert.equal(renderScreen("\u001b[1;31mred\u001b[0m", opts).split("\n")[0], "red");
    });

    it("skips OSC title sequences entirely", () => {
      assert.equal(renderScreen("\u001b]0;title\u0007body", opts).split("\n")[0], "body");
    });

    it("scrolls and preserves evicted rows as scrollback", () => {
      const out = renderScreen("1\n2\n3\n4\n5\n6\n7", { rows: 3, cols: 10 });
      assert.ok(out.includes("1"), "scrollback retained");
      assert.ok(out.trimEnd().endsWith("7"), "latest row last");
    });

    it("renders the alt screen without scrollback when a TUI switches to it", () => {
      const out = renderScreen("shell junk\u001b[?1049h\u001b[2J\u001b[1;1HTUI", opts);
      assert.equal(out.split("\n")[0], "TUI");
      assert.ok(!out.includes("shell junk"), "alt screen hides the main buffer");
    });

    it("wraps text beyond the column width", () => {
      const out = renderScreen("abcdefgh", { rows: 3, cols: 4 }).split("\n");
      assert.equal(out[0], "abcd");
      assert.equal(out[1], "efgh");
    });

    it("handles backspace", () => {
      assert.equal(renderScreen("abc\b\bX", opts).split("\n")[0], "aXc");
    });

    it("never emits escape characters for unknown sequences", () => {
      const out = renderScreen("a\u001b[?25l\u001b[6nb\u001b]11;rgb:00/00/00\u0007c", opts);
      assert.ok(!out.includes("\u001b"));
      assert.equal(out.split("\n")[0], "abc");
    });
  });

  describe("renderTail", () => {
    it("returns the last N meaningful rows without trailing blanks", () => {
      const tail = renderTail("a\nb\nc\nd\ne", 2, { rows: 10, cols: 10 });
      assert.equal(tail, "d\ne");
    });

    it("surfaces live progress that naive line-slicing would miss", () => {
      // TUI-style frame: repaint via CUP, no newlines at all.
      const frame = (n: number) => `\u001b[2J\u001b[1;1Hheader\u001b[3;1H[phase1 ${n}/15] scanning`;
      const raw = [1, 2, 3].map(frame).join("");
      assert.ok(renderTail(raw, 5, { rows: 6, cols: 40 }).includes("[phase1 3/15]"));
      // and the superseded frames are gone
      assert.ok(!renderTail(raw, 5, { rows: 6, cols: 40 }).includes("[phase1 1/15]"));
    });
  });
});

// ── Regressions found by adversarial review of the Warp backend ──────────────

describe("warp backend review regressions", () => {
  let warpDir: string;
  let prevState: string | undefined;
  let prevNoLaunch: string | undefined;
  let prevData: string | undefined;

  before(() => {
    warpDir = createTestDir();
    prevState = process.env.PI_WARP_STATE_DIR;
    prevNoLaunch = process.env.PI_WARP_NO_LAUNCH;
    prevData = process.env.PI_WARP_DATA_DIR;
    process.env.PI_WARP_STATE_DIR = warpDir;
    process.env.PI_WARP_NO_LAUNCH = "1";
    process.env.PI_WARP_DATA_DIR = join(warpDir, "warp-data");
  });

  after(() => {
    if (prevState === undefined) delete process.env.PI_WARP_STATE_DIR;
    else process.env.PI_WARP_STATE_DIR = prevState;
    if (prevNoLaunch === undefined) delete process.env.PI_WARP_NO_LAUNCH;
    else process.env.PI_WARP_NO_LAUNCH = prevNoLaunch;
    if (prevData === undefined) delete process.env.PI_WARP_DATA_DIR;
    else process.env.PI_WARP_DATA_DIR = prevData;
    rmSync(warpDir, { recursive: true, force: true });
  });

  describe("VT parser", () => {
    it("consumes CSI intermediate bytes (DECSCUSR) instead of leaking the final byte", () => {
      // "ESC [ 6 SP q" — emitted by vim and many prompts. The space is an
      // intermediate byte, not the final byte; mis-parsing printed a stray "q".
      assert.equal(renderScreen("a\u001b[6 qb", { rows: 2, cols: 20 }).split("\n")[0], "ab");
    });

    it("keeps astral characters whole at the wrap boundary", () => {
      const rows = renderScreen("abc\u{1F600}d", { rows: 3, cols: 4 }).split("\n");
      const split = rows.some((r) => /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(r));
      assert.equal(split, false, `surrogate pair split across rows: ${JSON.stringify(rows)}`);
      assert.ok(rows.join("").includes("\u{1F600}"));
    });

    it("accounts for double-width glyphs when wrapping", () => {
      assert.equal(charWidth(0x6f22), 2, "CJK is two cells");
      assert.equal(charWidth(0x1f600), 2, "emoji is two cells");
      assert.equal(charWidth(0x61), 1, "ascii is one cell");
      // 3 wide glyphs = 6 columns, so the 4th must wrap in a 6-column grid.
      const rows = renderScreen("漢字漢", { rows: 3, cols: 6 }).split("\n");
      assert.equal(rows[0], "漢字漢");
    });
  });

  // `/bin/sh` is the whole point of these two: they prove the quoting survives a
  // real POSIX shell. There is nothing to prove, and no /bin/sh, on Windows.
  describe("shell quoting (surface.env)", { skip: process.platform === "win32" }, () => {
    it("neutralises quotes, backslashes and command substitution", () => {
      const nasty = `it's \\ "q" $(touch /tmp/PWNED) \`id\``;
      const quoted = shQuote(nasty);
      assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
      // Round-trip through a real shell: the value must come back byte-identical.
      const out = execFileSync("/bin/sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
      assert.equal(out, nasty);
    });

    it("emits a sourceable env file and drops invalid variable names", () => {
      const env = renderSurfaceEnv({
        protocol: 1,
        id: "x",
        name: "na'me",
        cwd: "/tmp",
        command: `echo "hi" && echo 'bye'`,
        log: "/l",
        input: "/i",
        status: "/s",
        createdAt: 0,
        env: { GOOD: "v'v", "BAD-NAME": "nope" },
      } as any);
      assert.ok(env.includes("export GOOD="));
      assert.ok(!env.includes("BAD-NAME"), "invalid identifier must not be emitted");
      // Sourcing it must not execute the embedded command substitution.
      const envFile = join(warpDir, "probe.env");
      writeFileSync(envFile, env);
      const probe = execFileSync(
        "/bin/sh",
        ["-c", `. "$1"; printf %s "$PI_WARP_COMMAND"`, "sh", envFile],
        { encoding: "utf8" },
      );
      assert.equal(probe, `echo "hi" && echo 'bye'`);
      assert.equal(existsSync("/tmp/PWNED"), false, "no command substitution ran");
    });
  });

  describe("send-before-ready", () => {
    it("hands the first command to the pane through the command file", () => {
      const id = createWarpSurface("deferred", { cwd: warpDir });
      assert.equal(readStatus(id)?.state, "starting");
      // Opening a Warp tab outlasts any delay the parent can wait, so the launch
      // command is dropped for the bootstrap to pick up instead of being typed
      // into a pane that does not exist yet.
      warpSendCommand(id, "echo hi");
      const spec = readSpec(id)!;
      assert.equal(readFileSync(spec.commandFile, "utf8").trimEnd(), "echo hi");
      assert.equal(existsSync(spec.input), false, "no pane means no input pipe yet");
    });

    it("reports a starting pane as retryable, not as a dead one", () => {
      const id = createWarpSurface("not-ready", { cwd: warpDir });
      assert.throws(
        () => warpSendText(id, "echo hi"),
        /still starting/,
        "must not claim the pane closed before it ever opened",
      );
    });
  });

  describe("pane shell selection", () => {
    it("follows PI_WARP_PANE_SHELL rather than the parent platform", () => {
      const prev = process.env.PI_WARP_PANE_SHELL;
      try {
        process.env.PI_WARP_PANE_SHELL = "posix";
        assert.equal(paneShell(), "posix");
        assert.equal(inputFileName(paneShell()), "in.fifo");
        const id = createWarpSurface("posix-pane", { cwd: warpDir });
        assert.equal(readSpec(id)?.shell, "posix");

        process.env.PI_WARP_PANE_SHELL = "pwsh";
        assert.equal(paneShell(), "powershell");
        assert.equal(inputFileName(paneShell()), "in.cmd");
      } finally {
        if (prev === undefined) delete process.env.PI_WARP_PANE_SHELL;
        else process.env.PI_WARP_PANE_SHELL = prev;
      }
    });

    it("refuses keystroke injection into a PowerShell pane instead of dropping it", () => {
      const id = createWarpSurface("ps-pane", { cwd: warpDir, shell: "powershell" });
      // Make it look live so we get past the start-up guard.
      const spec = readSpec(id)!;
      writeFileSync(spec.input, "");
      writeFileSync(
        spec.status,
        JSON.stringify({ id, state: "running", injectable: false, updatedAt: Date.now() }),
      );
      assert.throws(() => warpSendText(id, "hi"), /PI_WARP_PANE_SHELL=posix/);
    });
  });

  describe("surface garbage collection", () => {
    it("prunes exited surfaces past the TTL and keeps live ones", () => {
      const live = createWarpSurface("gc-live", { cwd: warpDir });
      const dead = createWarpSurface("gc-dead", { cwd: warpDir });
      writeFileSync(
        readSpec(dead)!.status,
        JSON.stringify({ id: dead, state: "exited", exitCode: 0, updatedAt: 0 }),
      );
      const prev = process.env.PI_WARP_SURFACE_TTL_MS;
      try {
        process.env.PI_WARP_SURFACE_TTL_MS = "1";
        gcWarpSurfaces();
      } finally {
        if (prev === undefined) delete process.env.PI_WARP_SURFACE_TTL_MS;
        else process.env.PI_WARP_SURFACE_TTL_MS = prev;
      }
      assert.equal(existsSync(surfaceDir(dead)), false, "stale exited surface must be reaped");
      assert.equal(existsSync(surfaceDir(live)), true, "a starting surface must survive");
    });
  });

  describe("bounded transcript reads", () => {
    it("only replays the tail of a very large log", () => {
      const id = createWarpSurface("big-log", { cwd: warpDir });
      const spec = readSpec(id);
      const filler = "x".repeat(1024) + "\n";
      writeFileSync(spec.log, filler.repeat(400) + "FINAL_MARKER\n"); // ~400KB
      process.env.PI_WARP_LOG_TAIL_BYTES = "4096";
      try {
        const screen = warpReadScreen(id, 5);
        assert.ok(screen.includes("FINAL_MARKER"), "tail is what matters");
      } finally {
        delete process.env.PI_WARP_LOG_TAIL_BYTES;
      }
    });
  });
});

// ── UTF-8 boundary safety in bounded transcript reads (found by re-audit) ────

describe("warp readTail UTF-8 alignment", () => {
  let dir: string;
  let prevState: string | undefined;
  let prevNoLaunch: string | undefined;
  let prevData: string | undefined;

  before(() => {
    dir = createTestDir();
    prevState = process.env.PI_WARP_STATE_DIR;
    prevNoLaunch = process.env.PI_WARP_NO_LAUNCH;
    prevData = process.env.PI_WARP_DATA_DIR;
    process.env.PI_WARP_STATE_DIR = dir;
    process.env.PI_WARP_NO_LAUNCH = "1";
    process.env.PI_WARP_DATA_DIR = join(dir, "warp-data");
  });

  after(() => {
    if (prevState === undefined) delete process.env.PI_WARP_STATE_DIR;
    else process.env.PI_WARP_STATE_DIR = prevState;
    if (prevNoLaunch === undefined) delete process.env.PI_WARP_NO_LAUNCH;
    else process.env.PI_WARP_NO_LAUNCH = prevNoLaunch;
    if (prevData === undefined) delete process.env.PI_WARP_DATA_DIR;
    else process.env.PI_WARP_DATA_DIR = prevData;
    delete process.env.PI_WARP_LOG_TAIL_BYTES;
    rmSync(dir, { recursive: true, force: true });
  });

  it("never emits U+FFFD regardless of where the byte cut lands", () => {
    const id = createWarpSurface("utf8", { cwd: dir });
    // 4-byte emoji followed by a 3-byte CJK char: cuts can land 1-3 bytes in.
    writeFileSync(readSpec(id).log, "A".repeat(200) + "😀漢 END\n");
    const corrupted: number[] = [];
    for (let tail = 8; tail <= 24; tail++) {
      process.env.PI_WARP_LOG_TAIL_BYTES = String(tail);
      if (warpReadScreen(id, 3).includes("\uFFFD")) corrupted.push(tail);
    }
    assert.deepEqual(corrupted, [], `byte cuts corrupted characters at tails: ${corrupted}`);
  });

  it("drops an incomplete trailing sequence (pty still mid-write)", () => {
    // Valid text then the first 2 bytes of a 3-byte character.
    const partial = Buffer.concat([
      Buffer.from("hello ", "utf8"),
      Buffer.from([0xe6, 0xbc]), // truncated 漢
    ]);
    const aligned = alignUtf8(partial).toString("utf8");
    assert.equal(aligned, "hello ");
    assert.ok(!aligned.includes("\uFFFD"));
  });

  it("leaves an already-aligned buffer untouched", () => {
    const buf = Buffer.from("plain ascii", "utf8");
    assert.equal(alignUtf8(buf).toString("utf8"), "plain ascii");
  });
});
