/**
 * End-to-end integration test for the Warp backend.
 *
 * Unlike the psmux/WezTerm surface tests this one drives the Warp-specific
 * handshake directly (surface dir → warp:// tab → pane hook → bootstrap),
 * because Warp exposes no pane ids to address.
 *
 * Requirements to actually run:
 *   - pi running inside Warp (TERM_PROGRAM=WarpTerminal)
 *   - the pane hook installed: `node scripts/install-warp-hook.mjs --install`
 *
 * It is skipped (not failed) anywhere else, so CI on Linux/Windows runners
 * without a Warp GUI stays green.
 *
 * Run: node --test test/integration/warp-surface.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createWarpSurface,
  isWarpRuntimeAvailable,
  readSpec,
  readStatus,
  warpCloseSurface,
  warpDisposeSurface,
  warpReadScreen,
  warpSendCommand,
  writeTabConfig,
} from "../../pi-extension/subagents/warp.ts";

const enabled = isWarpRuntimeAvailable();

if (!enabled) {
  console.log("⚠️  Warp backend unavailable — skipping warp-surface integration tests");
  console.log("   Run inside Warp with `node scripts/install-warp-hook.mjs --install`.");
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

  it("opens a Warp tab, runs a command in it, and reads the transcript back", async () => {
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

  it("propagates the exit code through status.json and the done sentinel", async () => {
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

  it("preserves shell special characters sent through the input channel", async () => {
    const id = createWarpSurface("integ-escape", { cwd: process.cwd() });
    created.push(id);

    assert.ok(await until(() => readStatus(id)?.state === "running"), "pane bootstrapped");
    warpSendCommand(id, `echo 'a$b "c" \\d'`);

    assert.ok(
      await until(() => warpReadScreen(id, 200).includes(`a$b "c" \\d`), 10_000),
      `special characters survived:\n${warpReadScreen(id, 30)}`,
    );
  });

  it("emits a manual-fallback tab config that references the surface", () => {
    const id = createWarpSurface("integ-tabconfig", { cwd: process.cwd() });
    created.push(id);

    const file = writeTabConfig(id);
    const toml = readFileSync(file, "utf8");
    assert.ok(toml.includes(readSpec(id).id), "tab config points at the surface dir");
    assert.ok(toml.includes("pi-warp-bootstrap"), "tab config launches the bootstrap");
  });
});
