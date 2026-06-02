import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import type { AgentMode } from "./config.js";

/**
 * Common locations where CLI tools install on macOS. A compiled binary or a
 * launchd/GUI-spawned process inherits a minimal PATH (typically
 * /usr/bin:/bin:/usr/sbin:/sbin), so dirs added by your shell rc (oh-my-zsh,
 * ~/.zshrc) like ~/.local/bin are NOT visible. We search these explicitly.
 */
function commonBinDirs(): string[] {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

/**
 * Prepend the common bin dirs to process.env.PATH (idempotent) so every child
 * process we spawn - and cursor-agent's own subprocesses - can find tooling.
 */
export function augmentPath(): void {
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const merged = [...new Set([...commonBinDirs(), ...current])];
  process.env.PATH = merged.join(":");
}

/**
 * Resolve the cursor-agent binary to an absolute path, checking known install
 * locations before falling back to a bare PATH lookup. Honors CURSY_CURSOR_BIN.
 */
export function resolveCursorBin(): string {
  const override = process.env.CURSY_CURSOR_BIN;
  if (override) return override;
  for (const dir of commonBinDirs()) {
    const candidate = join(dir, "cursor-agent");
    if (existsSync(candidate)) {
      // cursor-agent installs ~/.local/bin/cursor-agent as a symlink (or
      // launcher) into a versioned directory, and its self-updater atomically
      // repoints that symlink at a new version. Resolving to the concrete
      // target means we spawn a path that stays put during the swap, instead
      // of the symlink that briefly vanishes (the cause of transient ENOENT).
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return "cursor-agent";
}

export interface RunOptions {
  prompt: string;
  workspace: string;
  /** Existing cursor-agent chat session id to resume, if any. */
  chatId?: string;
  model?: string | null;
  mode?: AgentMode;
  force?: boolean;
  /** Hard timeout in ms before the process is killed (default 600000). */
  timeoutMs?: number;
  /** Optional callback for intermediate assistant text (progress relay). */
  onText?: (text: string) => void;
}

export interface RunResult {
  /** Final assistant text. */
  result: string;
  /** Chat session id to resume next time for this thread. */
  chatId?: string;
  model?: string;
  timedOut: boolean;
  exitCode: number | null;
}

/** Binary name; allow override for testing / non-standard installs. */
export const CURSOR_BIN = process.env.CURSY_CURSOR_BIN || "cursor-agent";

/** PATH augmented with common bin dirs, for spawned child processes. */
function spawnEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  const extra = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const path = [...new Set([...extra, ...(process.env.PATH ?? "").split(":")])]
    .filter(Boolean)
    .join(":");
  return { ...process.env, PATH: path };
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  // Various shapes across versions; read defensively.
  chatId?: string;
  session_id?: string;
  sessionId?: string;
  model?: string;
  result?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
  text?: string;
}

function extractText(ev: StreamEvent): string | null {
  if (typeof ev.text === "string") return ev.text;
  const content = ev.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c && (c.type === "text" || c.type === undefined))
      .map((c) => c.text ?? "")
      .filter(Boolean);
    if (parts.length) return parts.join("");
  }
  return null;
}

function extractChatId(ev: StreamEvent): string | undefined {
  return ev.chatId ?? ev.session_id ?? ev.sessionId;
}

/**
 * Run cursor-agent in headless print mode and stream the result.
 *
 * Mitigates the known issue where `cursor-agent -p` sometimes fails to exit
 * after completing: once the terminal `result` event is observed, we resolve
 * and give the process a short grace period before force-killing it.
 */
export function runAgent(opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const args = ["-p", "--output-format", "stream-json"];
  if (opts.force !== false) args.push("--force");
  if (opts.chatId) args.push("--resume", opts.chatId);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.model) args.push("--model", opts.model);
  if (opts.mode && opts.mode !== "agent") args.push("--mode", opts.mode);
  args.push(opts.prompt);

  log.debug("spawning cursor-agent", { args });

  return new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let chatId: string | undefined = opts.chatId;
    let model: string | undefined;
    let finalResult: string | undefined;
    const assistantChunks: string[] = [];
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let stderr = "";
    let retriedSpawn = false;

    const hardTimer = setTimeout(() => {
      log.warn("cursor-agent hard timeout, killing", { timeoutMs });
      finish(true, null);
      kill();
    }, timeoutMs);

    const kill = () => {
      const target = child;
      try {
        target?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          target?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000).unref();
    };

    const finish = (timedOut: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      let result =
        finalResult ??
        (assistantChunks.join("").trim() ||
          (timedOut ? "(timed out before a response)" : ""));
      // No usable output but the process failed: surface the actual error
      // (e.g. "Authentication required...") instead of a useless empty reply.
      if (!result && !timedOut && exitCode !== 0) {
        const err = stderr.trim();
        log.error("cursor-agent failed", { exitCode, stderr: err });
        result = err
          ? `cursor-agent error (exit ${exitCode}):\n${err}`
          : `cursor-agent exited with code ${exitCode} and no output.`;
      }
      resolve({ result, chatId, model, timedOut, exitCode });
    };

    const start = () => {
      const current = spawn(resolveCursorBin(), args, {
        cwd: opts.workspace || process.cwd(),
        env: spawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = current;

      const rl = createInterface({ input: current.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(trimmed) as StreamEvent;
        } catch {
          // Non-JSON line (shouldn't happen in stream-json) -> treat as text.
          assistantChunks.push(trimmed);
          return;
        }

        const cid = extractChatId(ev);
        if (cid) chatId = cid;
        if (ev.model) model = ev.model;

        if (ev.type === "result") {
          if (typeof ev.result === "string") finalResult = ev.result;
          // Terminal event observed; resolve now and reap the process shortly.
          finish(false, current.exitCode);
          graceTimer = setTimeout(kill, 1500);
          graceTimer.unref?.();
          return;
        }

        if (ev.type === "assistant" || ev.message?.role === "assistant") {
          const text = extractText(ev);
          if (text) {
            assistantChunks.push(text);
            opts.onText?.(text);
          }
        }
      });

      current.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      current.on("error", (err: NodeJS.ErrnoException) => {
        // cursor-agent self-updates by atomically swapping its launcher, so a
        // prompt that lands mid-swap sees ENOENT. Re-resolve and retry once
        // before giving up, so a transient update doesn't eat the reply.
        if (err.code === "ENOENT" && !retriedSpawn && !settled) {
          retriedSpawn = true;
          log.warn("cursor-agent spawn ENOENT; re-resolving and retrying", String(err));
          setTimeout(start, 800).unref?.();
          return;
        }
        log.error("cursor-agent spawn error", String(err));
        finalResult =
          finalResult ??
          (err.code === "ENOENT"
            ? "cursor-agent is unavailable right now (it may be updating). Please send that again in a moment."
            : `Failed to run cursor-agent: ${err.message}`);
        finish(false, null);
      });

      current.on("close", (code) => {
        // Ignore the failed child's close after a retry superseded it.
        if (current !== child) return;
        if (stderr.trim()) log.debug("cursor-agent stderr", stderr.trim());
        finish(false, code);
      });
    };

    start();
  });
}

/** Check that the cursor-agent binary is invokable; returns its version. */
export async function getCursorVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(resolveCursorBin(), ["--version"], {
      env: spawnEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}
