import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentDefinition } from "../pi-extension/subagents/index.ts";

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), "../agents");

// Regression: the frontmatter regex was LF-only, so every agent definition checked out
// with CRLF on Windows parsed as null and vanished from isub_list without any error.
test("parses agent definitions with CRLF line endings", () => {
  const crlf = "---\r\nname: crlf-agent\r\nthinking: high\r\n---\r\n\r\nBody text.\r\n";
  const parsed = parseAgentDefinition(crlf, "fallback");
  assert.ok(parsed, "CRLF definition failed to parse");
  assert.equal(parsed!.name, "crlf-agent");
  assert.equal(parsed!.thinking, "high");
  assert.equal(parsed!.body, "Body text.");
});

test("every bundled agent definition parses", () => {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "no bundled agents found");
  for (const f of files) {
    const parsed = parseAgentDefinition(readFileSync(join(agentsDir, f), "utf8"), f);
    assert.ok(parsed, `${f}: did not parse`);
    assert.ok(parsed!.name, `${f}: no name`);
  }
});
