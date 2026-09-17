#!/usr/bin/env node
/**
 * install-warp-hook.mjs — install/uninstall the Warp pane hook.
 *
 * The Warp backend needs exactly one thing from the user's environment: a
 * guarded line in their shell profile so that a Warp tab opened on a surface
 * directory execs the pi pane bootstrap. This script manages that line
 * idempotently on Linux, macOS and Windows.
 *
 *   node scripts/install-warp-hook.mjs --install     # add hook + write receipt
 *   node scripts/install-warp-hook.mjs --uninstall   # remove hook + receipt
 *   node scripts/install-warp-hook.mjs --status      # report what is installed
 *   node scripts/install-warp-hook.mjs --print       # print the block, install nothing
 *
 * Flags: --shell bash|zsh|fish|powershell (repeatable), --dry-run, --yes
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const BOOTSTRAP_DIR = join(PKG_ROOT, "pi-extension", "subagents", "warp-bootstrap");

const BEGIN = "# >>> pi-interactive-subagents (warp) >>>";
const END = "# <<< pi-interactive-subagents (warp) <<<";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const shellsArg = argv.reduce((acc, a, i) => (a === "--shell" ? [...acc, argv[i + 1]] : acc), []);
const dryRun = has("--dry-run");

function stateDir() {
  if (process.env.PI_WARP_STATE_DIR) return process.env.PI_WARP_STATE_DIR;
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "pi-interactive-subagents",
      "warp",
    );
  }
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "pi-interactive-subagents", "warp");
}
const receiptPath = join(stateDir(), "hook-installed.json");

/** Shell targets: profile file + hook template + comment syntax. */
function targets() {
  const home = homedir();
  const all = {
    bash: {
      profile: join(home, ".bashrc"),
      template: join(BOOTSTRAP_DIR, "pi-warp-hook.sh"),
      bootstrap: join(BOOTSTRAP_DIR, "pi-warp-bootstrap.sh"),
      begin: BEGIN,
      end: END,
    },
    zsh: {
      profile: join(home, ".zshrc"),
      template: join(BOOTSTRAP_DIR, "pi-warp-hook.sh"),
      bootstrap: join(BOOTSTRAP_DIR, "pi-warp-bootstrap.sh"),
      begin: BEGIN,
      end: END,
    },
    fish: {
      profile: join(home, ".config", "fish", "config.fish"),
      template: join(BOOTSTRAP_DIR, "pi-warp-hook.fish"),
      bootstrap: join(BOOTSTRAP_DIR, "pi-warp-bootstrap.sh"),
      begin: BEGIN,
      end: END,
    },
    powershell: {
      profile:
        process.env.PI_WARP_PS_PROFILE ??
        join(
          homedir(),
          "Documents",
          "PowerShell",
          "Microsoft.PowerShell_profile.ps1",
        ),
      template: join(BOOTSTRAP_DIR, "pi-warp-hook.ps1"),
      bootstrap: join(BOOTSTRAP_DIR, "pi-warp-bootstrap.ps1"),
      begin: BEGIN,
      end: END,
    },
  };

  if (shellsArg.length) {
    return Object.fromEntries(
      shellsArg.filter((s) => all[s]).map((s) => [s, all[s]]),
    );
  }

  // Auto-detect: install only where a profile (or its parent dir) exists.
  const detected = {};
  const wanted =
    process.platform === "win32" ? ["powershell"] : ["bash", "zsh", "fish", "powershell"];
  for (const s of wanted) {
    const t = all[s];
    if (existsSync(t.profile) || existsSync(dirname(t.profile))) detected[s] = t;
  }
  return detected;
}

function renderBlock(t) {
  const body = readFileSync(t.template, "utf8").replaceAll("__PI_WARP_BOOTSTRAP__", t.bootstrap);
  return `${t.begin}\n${body.trimEnd()}\n${t.end}\n`;
}

function stripBlock(content, t) {
  const re = new RegExp(
    `\\n?${escapeRe(t.begin)}[\\s\\S]*?${escapeRe(t.end)}\\n?`,
    "g",
  );
  return content.replace(re, "\n");
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function install() {
  const ts = targets();
  const installed = [];
  for (const [shell, t] of Object.entries(ts)) {
    const block = renderBlock(t);
    const prev = existsSync(t.profile) ? readFileSync(t.profile, "utf8") : "";
    const next = `${stripBlock(prev, t).trimEnd()}\n\n${block}`;
    if (dryRun) {
      console.log(`[dry-run] would update ${t.profile}\n${block}`);
    } else {
      mkdirSync(dirname(t.profile), { recursive: true });
      writeFileSync(t.profile, next);
      console.log(`installed hook → ${t.profile}`);
    }
    installed.push({ shell, profile: t.profile, bootstrap: t.bootstrap });
  }
  if (!installed.length) {
    console.error("No shell profiles detected. Re-run with --shell bash|zsh|fish|powershell.");
    process.exit(1);
  }
  if (!dryRun) {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      receiptPath,
      JSON.stringify(
        { protocol: 1, installedAt: Date.now(), packageRoot: PKG_ROOT, shells: installed },
        null,
        2,
      ),
    );
    console.log(`receipt → ${receiptPath}`);
    console.log("Open a NEW Warp tab (or `exec $SHELL`) for the hook to take effect.");
  }
}

function uninstall() {
  for (const [, t] of Object.entries(targets())) {
    if (!existsSync(t.profile)) continue;
    const prev = readFileSync(t.profile, "utf8");
    const next = stripBlock(prev, t);
    if (next !== prev) {
      if (dryRun) console.log(`[dry-run] would clean ${t.profile}`);
      else {
        writeFileSync(t.profile, next);
        console.log(`removed hook ← ${t.profile}`);
      }
    }
  }
  if (!dryRun && existsSync(receiptPath)) {
    rmSync(receiptPath, { force: true });
    console.log("receipt removed");
  }
}

function status() {
  const receipt = existsSync(receiptPath)
    ? JSON.parse(readFileSync(receiptPath, "utf8") || "{}")
    : null;
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        insideWarp:
          process.env.TERM_PROGRAM === "WarpTerminal" || !!process.env.WARP_TERMINAL_SESSION_UUID,
        receipt,
        targets: Object.fromEntries(
          Object.entries(targets()).map(([s, t]) => [
            s,
            {
              profile: t.profile,
              present:
                existsSync(t.profile) && readFileSync(t.profile, "utf8").includes(BEGIN),
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

if (has("--print")) {
  for (const [shell, t] of Object.entries(targets())) {
    console.log(`# ${shell} → ${t.profile}`);
    console.log(renderBlock(t));
  }
} else if (has("--uninstall")) {
  uninstall();
} else if (has("--status")) {
  status();
} else if (has("--install")) {
  install();
} else {
  console.log(
    "usage: install-warp-hook.mjs --install | --uninstall | --status | --print [--shell <name>] [--dry-run]",
  );
}
