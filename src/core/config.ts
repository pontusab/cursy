import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { CONFIG_DIR, CONFIG_FILE } from "./paths.js";

export type AgentMode = "agent" | "plan" | "ask";

export interface ThreadState {
  /** cursor-agent chat session id to resume for this iMessage thread. */
  chatId?: string;
  /** Workspace directory the agent operates on for this thread. */
  workspace?: string;
  /** Per-thread model override. */
  model?: string;
  /** Per-thread mode override (agent, plan, or ask). */
  mode?: AgentMode;
  /** Whether this thread has passed the passphrase gate (if configured). */
  authed?: boolean;
}

export interface CursyConfig {
  version: number;
  /** Normalized handles (phone/email) allowed to drive the agent. */
  whitelist: string[];
  /** Optional prefix required before a message is treated as a prompt. */
  commandPrefix: string | null;
  /** Optional shared passphrase that must appear in the first message. */
  passphrase: string | null;
  defaultWorkspace: string;
  defaultModel: string | null;
  defaultMode: AgentMode;
  /** Pass --force to cursor-agent (full tool access incl. shell/write). */
  force: boolean;
  /**
   * Allow non-iMessage messages (SMS/RCS) to control the agent. OFF by default:
   * SMS sender IDs are spoofable, and with `force` the agent has shell access,
   * so we only honor commands/prompts arriving over iMessage unless explicitly
   * opted in here.
   */
  allowSms: boolean;
  /**
   * Use iMessage tapbacks for lightweight signals (e.g. a 👍 acknowledgment
   * instead of an "on it..." bubble) where it makes sense. Requires
   * Accessibility permission; falls back to text automatically if a tapback
   * can't be sent.
   */
  reactions: boolean;
  /** Per-thread persisted state keyed by normalized handle. */
  threads: Record<string, ThreadState>;
  /** Last processed Messages ROWID (watermark for incremental reads). */
  watermark: number;
}

export const CONFIG_VERSION = 1;

export function defaultConfig(): CursyConfig {
  return {
    version: CONFIG_VERSION,
    whitelist: [],
    commandPrefix: null,
    passphrase: null,
    defaultWorkspace: process.cwd(),
    defaultModel: null,
    defaultMode: "agent",
    force: true,
    reactions: false,
    allowSms: false,
    threads: {},
    watermark: 0,
  };
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * Returns true only if a config file exists and contains the minimum viable
 * settings for the daemon to run (at least one whitelisted handle and a
 * workspace).
 */
export function isConfigured(): boolean {
  if (!configExists()) return false;
  try {
    const cfg = loadConfig();
    return cfg.whitelist.length > 0 && Boolean(cfg.defaultWorkspace);
  } catch {
    return false;
  }
}

export function loadConfig(): CursyConfig {
  const raw = readFileSync(CONFIG_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<CursyConfig>;
  // Merge over defaults so older config files gain new fields gracefully.
  return { ...defaultConfig(), ...parsed };
}

export function saveConfig(cfg: CursyConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Load existing config or fall back to defaults (without writing). */
export function loadConfigOrDefault(): CursyConfig {
  return configExists() ? loadConfig() : defaultConfig();
}

/** Read-modify-write helper that persists the result. */
export function updateConfig(
  fn: (cfg: CursyConfig) => CursyConfig | void,
): CursyConfig {
  const cfg = loadConfigOrDefault();
  const next = fn(cfg) ?? cfg;
  saveConfig(next);
  return next;
}
