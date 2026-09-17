/**
 * End-to-end integration test for the Warp backend.
 *
 * Unlike the psmux/WezTerm surface tests this one drives the Warp-specific
 * handshake directly (surface dir → tab config → warp:// tab → bootstrap),
 * because Warp exposes no pane ids to address.
 *
 * Requirements to actually run:
 *   - pi running inside Warp (TERM_PROGRAM=WarpTerminal)
 *
 * It is skipped (not failed) anywhere else, so CI on Linux/Windows runners
 * without a Warp GUI stays green.
 *
 * Run: node --test test/integration/warp-surface.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createWarpSurface,
  isWarpRuntimeAvailable,
  paneShell,
  readSpec,
  readStatus,
  warpCloseSurface,
  warpDataDir,
  warpDisposeSurface,
  warpReadScreen,
  warpSendCommand,
  writeTabConfig,
} from "../../pi-extension/subagents/warp.ts";

const enabled = isWarpRuntimeAvailable();

// A PowerShell pane has no pty between us and the shell, so it never accepts
// injected keystrokes and always reads back an empty screen.
const injectable = paneShell() !== "powershell";

if (!enabled) {
  console.log("⚠️  Warp backend unavailable — skipping warp-surface integration tests");
  console.log("   Run pi inside Warp, or set PI_MUX_BACKEND=warp.");
} else if (!injectable) {
  console.log("⚠️  Warp PowerShell pane (direct mode) — skipping screen/input tests");
  console.log("   Use a Git Bash/MSYS2/WSL pane with PI_WARP_PANE_SHELL=posix for full parity.");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, budgetMs = 15_000, step = 500): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(step);
  }
  return predicate();
}

describe("warp-surface", { skip: !enabled, timeout: 90_000 }, () => {
  const created: string[] = [];

  after(() => {
    for (const id of created) {
      try {
        warpCloseSurface(id);
        warpDisposeSurface(id);
      } catch {}
    }
  });

  it("opens a Warp tab, runs a command in it, and reads the transcript back", async (t) => {
    if (!injectable) return t.skip("pane not injectable (direct mode)");
    const id = createWarpSurface("integ-echo", { cwd: process.cwd() });
    created.push(id);

    assert.ok(await until(() => readStatus(id)?.state === "running"), "pane bootstrapped");

    const marker = `MARKER_${Math.random().toString(36).slice(2, 8)}`;
    warpSendCommand(id, `echo ${marker}`);

    assert.ok(
      await until(() => warpReadScreen(id, 200).includes(marker), 10_000),
      `expected transcript to contain ${marker}:\n${warpReadScreen(id, 40)}`,
    );
  });

  it("propagates the exit code through status.json and the done sentinel", async (t) => {
    if (!injectable) return t.skip("pane not injectable (direct mode)");
    const id = createWarpSurface("integ-exit", { cwd: process.cwd() });
    created.push(id);

    assert.ok(await until(() => readStatus(id)?.state === "running"), "pane bootstrapped");
    warpSendCommand(id, "exit 3");

    assert.ok(await until(() => readStatus(id)?.state === "exited", 15_000), "surface exited");
    assert.equal(readStatus(id)?.exitCode, 3);
    assert.ok(
      warpReadScreen(id, 20).includes("__SUBAGENT_DONE_3__"),
      "sentinel present for crash detection fallback",
    );
  });

  it("preserves shell special characters sent through the input channel", async (t) => {
    if (!injectable) return t.skip("pane not injectable (direct mode)");
    const id = createWarpSurface("integ-escape", { cwd: process.cwd() });
    created.push(id);

    assert.ok(await until(() => readStatus(id)?.state === "running"), "pane bootstrapped");
    warpSendCommand(id, `echo 'a$b "c" \\d'`);

    assert.ok(
      await until(() => warpReadScreen(id, 200).includes(`a$b "c" \\d`), 10_000),
      `special characters survived:\n${warpReadScreen(id, 30)}`,
    );
  });

  it("emits a tab config that launches the bootstrap in the surface dir", () => {
    const id = createWarpSurface("integ-tabconfig", { cwd: process.cwd() });
    created.push(id);

    const name = writeTabConfig(id);
    const toml = readFileSync(join(warpDataDir(), "tab_configs", `${name}.toml`), "utf8");
    assert.ok(toml.includes(readSpec(id).id), "tab config points at the surface dir");
    assert.ok(toml.includes("pi-warp-bootstrap"), "tab config launches the bootstrap");
  });
});
