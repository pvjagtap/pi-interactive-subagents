import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "psmux" | "wezterm";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    if (process.platform === "win32") {
      execSync(`where ${command}`, { stdio: "ignore" });
    } else {
      execSync(`command -v ${command}`, { stdio: "ignore" });
    }
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * Resolve the psmux binary path.
 * psmux may not be in the inherited PATH (e.g. installed via cargo on Windows
 * where .cargo/bin is in the User PATH but not in Git Bash's $PATH).
 * We check well-known install locations as a fallback.
 */
let resolvedPsmuxBin: string | null | undefined;
function getPsmuxBin(): string | null {
  if (resolvedPsmuxBin !== undefined) return resolvedPsmuxBin;

  if (hasCommand("psmux")) {
    resolvedPsmuxBin = "psmux";
    return resolvedPsmuxBin;
  }

  if (process.platform === "win32") {
    const home = homedir();
    const candidates = [
      join(home, ".cargo", "bin", "psmux.exe"),
      join(process.env.LOCALAPPDATA ?? "", "psmux", "psmux.exe"),
      join(process.env.APPDATA ?? "", "npm", "psmux.cmd"),
      join(home, "scoop", "shims", "psmux.exe"),
    ];
    for (const p of candidates) {
      if (p && existsSync(p)) {
        resolvedPsmuxBin = p;
        return resolvedPsmuxBin;
      }
    }
  }

  resolvedPsmuxBin = null;
  return null;
}

/**
 * Resolve the wezterm binary path.
 * Checks PATH first, then well-known install locations on Windows.
 */
let resolvedWeztermBin: string | null | undefined;
function getWeztermBin(): string | null {
  if (resolvedWeztermBin !== undefined) return resolvedWeztermBin;

  if (hasCommand("wezterm")) {
    resolvedWeztermBin = "wezterm";
    return resolvedWeztermBin;
  }

  if (process.platform === "win32") {
    // Check WEZTERM_EXECUTABLE env (points to wezterm-gui.exe) — derive wezterm.exe from its dir
    const weztermExe = process.env.WEZTERM_EXECUTABLE;
    if (weztermExe) {
      const weztermDir = dirname(weztermExe);
      const candidate = join(weztermDir, "wezterm.exe");
      if (existsSync(candidate)) {
        resolvedWeztermBin = candidate;
        return resolvedWeztermBin;
      }
    }

    // Check common install locations
    const candidates = [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "WezTerm", "wezterm.exe"),
      join(process.env.ProgramFiles ?? "", "WezTerm", "wezterm.exe"),
    ];
    for (const p of candidates) {
      if (p && existsSync(p)) {
        resolvedWeztermBin = p;
        return resolvedWeztermBin;
      }
    }
  }

  resolvedWeztermBin = null;
  return null;
}

function isPsmuxRuntimeAvailable(): boolean {
  if (getPsmuxBin() === null) return false;
  return !!(process.env.PSMUX_SESSION || (process.platform === "win32" && process.env.TMUX));
}

function isWeztermRuntimeAvailable(): boolean {
  if (getWeztermBin() === null) return false;
  // WEZTERM_PANE is set inside WezTerm panes
  return process.env.WEZTERM_PANE != null;
}

export function isPsmuxAvailable(): boolean {
  return isPsmuxRuntimeAvailable();
}

export function isWeztermAvailable(): boolean {
  return isWeztermRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  if (isPsmuxRuntimeAvailable()) return "psmux";
  if (isWeztermRuntimeAvailable()) return "wezterm";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  return "Start pi inside psmux (`psmux new -s pi -- pi`) or WezTerm.";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Return the psmux binary name/path.
 */
function psmuxBin(): string {
  return getPsmuxBin() ?? "psmux";
}

/**
 * Return the wezterm binary name/path.
 */
function weztermBin(): string {
  return getWeztermBin() ?? "wezterm";
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish,
 * $LASTEXITCODE for psmux/PowerShell on Windows).
 */
export function exitStatusVar(): string {
  if (isFishShell()) return "$status";
  if (isPowerShellTarget()) return "$LASTEXITCODE";
  return "$?";
}

/**
 * Returns true when the sub-agent pane shell is PowerShell.
 *
 * IMPORTANT: This checks what shell the **mux pane** will use, NOT what
 * the parent process runs in.
 *
 * - psmux on Windows → panes are always PowerShell.
 * - WezTerm on Windows → panes inherit the default shell (usually PowerShell).
 *
 * Environment variables like BASH_VERSION, MSYSTEM, and SHELL belong to the
 * *parent* process and must NOT be used to infer the pane shell when running
 * under psmux on Windows.
 */
export function isPowerShellTarget(): boolean {
  // psmux on Windows → panes are always PowerShell.
  // WezTerm on Windows → panes default to PowerShell.
  if (process.platform === "win32") return true;

  // Non-Windows: use parent shell hints as a best-effort fallback.
  const shell = process.env.SHELL ?? "";
  const shellBase = shell.replace(/\\/g, "/").split("/").pop() ?? "";
  if (["bash", "zsh", "fish", "sh"].includes(shellBase)) {
    return false;
  }
  return false;
}

export function shellEscape(s: string): string {
  if (isPowerShellTarget()) {
    return '"' + s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$') + '"';
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert a Windows file path to a format the target shell understands.
 * - For PowerShell (psmux): keep backslashes as-is.
 * - For bash-on-Windows: convert `C:\foo\bar` to `/c/foo/bar`
 *   (MSYS/Git Bash path convention).
 * - On non-Windows: return as-is.
 */
export function shellPath(p: string): string {
  if (process.platform !== "win32") return p;
  if (isPowerShellTarget()) return p;
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`);
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

/**
 * Create a new terminal surface for a subagent.
 * For WezTerm: spawns a new tab (full-width, avoids narrow-pane TUI crashes).
 * For psmux: creates a split pane.
 * Returns a pane identifier (`%12` for psmux, numeric string for wezterm).
 */
export function createSurface(name: string): string {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    // Spawn a new tab instead of splitting — each subagent gets full terminal width
    const paneId = execFileSync(bin, ["cli", "spawn"], { encoding: "utf8" }).trim();
    if (!paneId || isNaN(Number(paneId))) {
      throw new Error(`Unexpected wezterm spawn output: ${paneId}`);
    }
    // Set tab title for easy identification
    try {
      execFileSync(bin, ["cli", "set-tab-title", "--pane-id", paneId, name], { encoding: "utf8" });
    } catch {
      // Optional — title is cosmetic.
    }
    return paneId;
  }

  // psmux: fall back to split
  return createSurfaceSplit(name, "right");
}

/**
 * Create a new split in the given direction.
 * Returns a pane identifier (`%12` for psmux, numeric string for wezterm).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    const args = ["cli", "split-pane"];
    // Map directions to wezterm flags
    switch (direction) {
      case "right":
        args.push("--right");
        break;
      case "left":
        args.push("--left");
        break;
      case "up":
        args.push("--top");
        break;
      case "down":
        args.push("--bottom");
        break;
    }
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync(bin, args, { encoding: "utf8" }).trim();
    if (!paneId || isNaN(Number(paneId))) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId}`);
    }
    // Set pane title via tab title
    try {
      execFileSync(bin, ["cli", "set-tab-title", "--pane-id", paneId, name], { encoding: "utf8" });
    } catch {
      // Optional — title is cosmetic.
    }
    return paneId;
  }

  // psmux backend
  const bin = psmuxBin();
  const args = ["split-window"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync(bin, args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected psmux split-window output: ${pane}`);
  }

  try {
    execFileSync(bin, ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
  } catch {
    // Optional — pane title is cosmetic.
  }
  return pane;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    const paneId = process.env.WEZTERM_PANE;
    if (!paneId) throw new Error("WEZTERM_PANE not set");
    execFileSync(bin, ["cli", "set-tab-title", "--pane-id", paneId, title], { encoding: "utf8" });
    return;
  }

  // psmux backend
  const bin = psmuxBin();
  if (process.env.PI_SUBAGENT_RENAME_PSMUX_WINDOW !== "1") {
    return;
  }
  const paneId = process.env.TMUX_PANE ?? process.env.PSMUX_PANE;
  if (!paneId) throw new Error("PSMUX_PANE/TMUX_PANE not set");
  const windowId = execFileSync(
    bin,
    ["display-message", "-p", "-t", paneId, "#{window_id}"],
    { encoding: "utf8" },
  ).trim();
  execFileSync(bin, ["rename-window", "-t", windowId, title], { encoding: "utf8" });
}

/**
 * Rename the current workspace/session.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    const paneId = process.env.WEZTERM_PANE;
    if (!paneId) throw new Error("WEZTERM_PANE not set");
    try {
      execFileSync(bin, ["cli", "rename-workspace", "--pane-id", paneId, title], { encoding: "utf8" });
    } catch {
      // rename-workspace may not be supported in older WezTerm versions
    }
    return;
  }

  // psmux backend
  const bin = psmuxBin();
  if (process.env.PI_SUBAGENT_RENAME_PSMUX_SESSION !== "1") {
    return;
  }
  const paneId = process.env.TMUX_PANE ?? process.env.PSMUX_PANE;
  if (!paneId) throw new Error("PSMUX_PANE/TMUX_PANE not set");
  const sessionId = execFileSync(
    bin,
    ["display-message", "-p", "-t", paneId, "#{session_id}"],
    { encoding: "utf8" },
  ).trim();
  execFileSync(bin, ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    // send-text sends text as if pasted; append \r\n to execute
    execFileSync(bin, ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\r\n"], {
      encoding: "utf8",
    });
    return;
  }

  // psmux backend
  const bin = psmuxBin();
  execFileSync(bin, ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync(bin, ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    // Send ESC character (\x1b)
    execFileSync(bin, ["cli", "send-text", "--pane-id", surface, "--no-paste", "\x1b"], {
      encoding: "utf8",
    });
    return;
  }

  // psmux backend
  const bin = psmuxBin();
  execFileSync(bin, ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const ext = isPowerShellTarget() ? ".ps1" : ".sh";
  const scriptPath =
    options?.scriptPath ??
    join(
      process.env.TEMP ?? process.env.TMP ?? join(homedir(), ".pi-tmp"),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  if (isPowerShellTarget()) {
    const scriptParts: string[] = [];
    if (options?.scriptPreamble) {
      scriptParts.push(options.scriptPreamble.trimEnd());
    }
    scriptParts.push(command);
    writeFileSync(scriptPath, scriptParts.join("\n") + "\n");
    sendCommand(surface, `& ${shellEscape(shellPath(scriptPath))}`);
  } else {
    const scriptParts = ["#!/bin/bash"];
    if (options?.scriptPreamble) {
      scriptParts.push(options.scriptPreamble.trimEnd());
    }
    scriptParts.push(command);
    writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
    sendCommand(surface, `bash ${shellEscape(shellPath(scriptPath))}`);
  }
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    // get-text with --start-line for scrollback; negative = scrollback lines
    return execFileSync(
      bin,
      ["cli", "get-text", "--pane-id", surface, "--start-line", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  }

  // psmux backend
  const bin = psmuxBin();
  return execFileSync(
    bin,
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    const { stdout } = await execFileAsync(
      bin,
      ["cli", "get-text", "--pane-id", surface, "--start-line", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  // psmux backend
  const bin = psmuxBin();
  const { stdout } = await execFileAsync(
    bin,
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "wezterm") {
    const bin = weztermBin();
    execFileSync(bin, ["cli", "kill-pane", "--pane-id", surface], { encoding: "utf8" });
    return;
  }

  // psmux backend
  const bin = psmuxBin();
  execFileSync(bin, ["kill-pane", "-t", surface], { encoding: "utf8" });
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          if (data.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            if (data.type === "ping") {
              return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
            }
            return { reason: "done", exitCode: 0 };
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
