import type { CursyConfig, ThreadState } from "./config.js";
import { normalizeHandle } from "./handle.js";

export type ParsedInput =
  | { kind: "ignored"; reason: string }
  | { kind: "prompt"; prompt: string }
  | { kind: "command"; name: string; arg: string };

const COMMANDS = new Set([
  "new",
  "stop",
  "workspace",
  "model",
  "mode",
  "ping",
  "status",
  "help",
]);

/**
 * Interpret an incoming message body.
 *
 * - If a command prefix is configured, the message must start with it; the
 *   prefix is then stripped before further parsing.
 * - A leading "/" marks a built-in command.
 * - Anything else is a natural-language prompt for the agent.
 */
export function parseInput(
  body: string,
  prefix: string | null,
): ParsedInput {
  let text = body.trim();
  if (!text) return { kind: "ignored", reason: "empty" };

  if (prefix) {
    if (!text.startsWith(prefix)) {
      return { kind: "ignored", reason: "missing prefix" };
    }
    text = text.slice(prefix.length).trim();
    if (!text) return { kind: "ignored", reason: "empty after prefix" };
  }

  if (text.startsWith("/")) {
    const space = text.indexOf(" ");
    const name = (space === -1 ? text.slice(1) : text.slice(1, space))
      .toLowerCase()
      .trim();
    const arg = space === -1 ? "" : text.slice(space + 1).trim();
    if (COMMANDS.has(name)) return { kind: "command", name, arg };
    return { kind: "ignored", reason: `unknown command: /${name}` };
  }

  return { kind: "prompt", prompt: text };
}

/** Get persisted state for a thread, falling back to config defaults. */
export function getThread(cfg: CursyConfig, handle: string): ThreadState {
  const key = normalizeHandle(handle);
  return cfg.threads[key] ?? {};
}

/** Resolve the workspace for a thread (thread override or default). */
export function workspaceFor(cfg: CursyConfig, handle: string): string {
  return getThread(cfg, handle).workspace || cfg.defaultWorkspace;
}

/** Mutate (in place) the thread state for a handle and return the config. */
export function setThread(
  cfg: CursyConfig,
  handle: string,
  patch: Partial<ThreadState>,
): CursyConfig {
  const key = normalizeHandle(handle);
  cfg.threads[key] = { ...(cfg.threads[key] ?? {}), ...patch };
  return cfg;
}

/** Clear the resumable session for a thread (used by /new). */
export function resetThread(cfg: CursyConfig, handle: string): CursyConfig {
  const key = normalizeHandle(handle);
  const existing = cfg.threads[key] ?? {};
  cfg.threads[key] = { workspace: existing.workspace };
  return cfg;
}
