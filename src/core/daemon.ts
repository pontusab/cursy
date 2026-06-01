import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  loadConfig,
  saveConfig,
  type AgentMode,
  type CursyConfig,
} from "./config.js";
import { matchWhitelist, normalizeHandle } from "./handle.js";
import {
  getMaxRowid,
  openDb,
  sendFile,
  sendReaction,
  sendText,
  watch,
  type IncomingMessage,
  type ReactionType,
} from "./imessage.js";
import { runAgent } from "./cursor.js";
import { formatReply } from "./format.js";
import {
  getThread,
  parseInput,
  resetThread,
  setThread,
  workspaceFor,
} from "./router.js";
import { decideSelfChat, SelfChatDeduper } from "./selfchat.js";
import { log } from "./log.js";
import { PID_FILE } from "./paths.js";

// Outbound loop guard: if a single thread receives more than this many replies
// within the window, we trip a circuit breaker and stop auto-replying to it
// until a fresh inbound message arrives. Prevents runaway message loops.
const BREAKER_MAX_REPLIES = 6;
const BREAKER_WINDOW_MS = 30_000;

// Drop an identical reply sent to the same thread within this window. Guards
// against duplicate bubbles (e.g. repeated "on it..." or identical errors).
const DEDUP_WINDOW_MS = 15_000;

// Self-chats (texting your own number) write TWO is_from_me=0 rows for a single
// sent message, so the same prompt is delivered to us twice. Drop an identical
// inbound prompt from the same handle seen within this window so we only run the
// agent - and reply - once. (Also collapses an impatient double-send.)
const INBOUND_DEDUP_WINDOW_MS = 60_000;

const HELP_TEXT = [
  "cursy commands:",
  "/new - start a fresh agent session",
  "/workspace <path> - set this thread's working directory",
  "/model <name> - set the model for this thread",
  "/mode <agent|plan|ask> - set how the agent responds",
  "/ping - quick health check (no agent call)",
  "/status - show current session info",
  "/help - this message",
  "",
  "Anything else you text is sent straight to the agent.",
].join("\n");

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

const MODES = new Set(["agent", "plan", "ask"]);

export class Daemon {
  private cfg: CursyConfig;
  private startedAt = Date.now();
  private stopWatch: (() => void) | null = null;
  // Serialize agent runs; a single user shouldn't run many at once.
  private queue: Promise<void> = Promise.resolve();
  private running = false;
  // Per-handle outbound timestamps + tripped flags for the loop circuit breaker.
  private replyTimes = new Map<string, number[]>();
  private breakerTripped = new Set<string>();
  // Last text sent per handle, to drop duplicate consecutive replies.
  private lastSent = new Map<string, { text: string; at: number }>();
  // Last actionable inbound text per handle, to drop self-chat double-delivery.
  private seenInbound = new Map<string, { text: string; at: number }>();
  private selfChat = new SelfChatDeduper();

  constructor() {
    this.cfg = loadConfig();
  }

  private persist(): void {
    saveConfig(this.cfg);
  }

  start(): void {
    // On first run, don't replay history: jump the watermark to "now".
    if (!this.cfg.watermark) {
      try {
        const db = openDb();
        try {
          this.cfg.watermark = getMaxRowid(db);
        } finally {
          db.close();
        }
        this.persist();
      } catch (err) {
        log.error("failed to seed watermark", String(err));
      }
    }

    log.info("daemon starting", {
      watermark: this.cfg.watermark,
      whitelist: this.cfg.whitelist.length,
    });

    this.stopWatch = watch({
      sinceRowid: this.cfg.watermark,
      onMessage: (msg) => this.enqueue(msg),
      onWatermark: (rowid) => {
        this.cfg.watermark = rowid;
        this.persist();
      },
    });
  }

  stop(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    log.info("daemon stopped");
  }

  private enqueue(msg: IncomingMessage): void {
    this.queue = this.queue.then(() => this.handle(msg)).catch((err) => {
      log.error("handle failed", String(err));
    });
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    const cleanText = msg.text.replace(/\uFFFC/g, "").trim();

    const gate = decideSelfChat(
      msg,
      this.cfg.whitelist,
      this.selfChat,
      cleanText,
    );
    if (gate.action === "skip") {
      log.debug("ignoring message", {
        rowid: msg.rowid,
        reason: gate.reason,
        isFromMe: msg.isFromMe,
      });
      if (gate.markGuid) this.selfChat.markSeen(msg.guid);
      return;
    }

    if (msg.isGroup) {
      log.debug("ignoring group message", { rowid: msg.rowid });
      this.selfChat.markSeen(msg.guid);
      return;
    }
    if (!msg.handle) return;
    if (!cleanText) return;

    const matched = matchWhitelist(msg.handle, this.cfg.whitelist);
    if (!matched) {
      log.debug("sender not whitelisted", { handle: msg.handle });
      return;
    }

    // Security: only honor control over iMessage by default. SMS/RCS sender IDs
    // can be spoofed, and with `force` the agent has shell access - so a spoofed
    // SMS matching the whitelist must not be able to run commands. Opt in via
    // `allowSms` for setups where the controlling device is SMS-only.
    if (!this.cfg.allowSms && msg.service !== "iMessage") {
      log.warn("ignoring non-iMessage control message", {
        handle: msg.handle,
        service: msg.service,
      });
      return;
    }

    // Self-chat double-delivery: an identical prompt from the same handle within
    // the dedup window is the duplicate row, not a new request - skip it so we
    // don't run the agent (and reply) twice.
    const prevIn = this.seenInbound.get(msg.handle);
    if (
      prevIn &&
      prevIn.text === cleanText &&
      Date.now() - prevIn.at < INBOUND_DEDUP_WINDOW_MS
    ) {
      log.debug("ignoring duplicate inbound message", {
        rowid: msg.rowid,
        handle: msg.handle,
      });
      return;
    }
    this.seenInbound.set(msg.handle, { text: cleanText, at: Date.now() });
    this.selfChat.markSeen(msg.guid);
    this.selfChat.recordTwin(msg.handle, cleanText, msg.isFromMe);

    // A genuine inbound message from a whitelisted human resets the loop
    // circuit breaker for that thread.
    this.breakerTripped.delete(msg.handle);
    this.replyTimes.delete(msg.handle);

    // Passphrase gate (optional): first message from a thread must contain it.
    if (this.cfg.passphrase) {
      const thread = getThread(this.cfg, msg.handle);
      if (!thread.authed) {
        if (msg.text.includes(this.cfg.passphrase)) {
          setThread(this.cfg, msg.handle, { authed: true });
          this.persist();
          await this.reply(msg, "Authenticated. You can text me commands now.");
        } else {
          log.warn("passphrase gate failed", { handle: msg.handle });
        }
        return;
      }
    }

    const parsed = parseInput(cleanText, this.cfg.commandPrefix);
    if (parsed.kind === "ignored") {
      log.debug("ignored input", { reason: parsed.reason });
      return;
    }
    if (parsed.kind === "command") {
      await this.runCommand(msg, parsed.name, parsed.arg);
      return;
    }
    await this.runPrompt(msg, parsed.prompt);
  }

  private async runCommand(
    msg: IncomingMessage,
    name: string,
    arg: string,
  ): Promise<void> {
    const handle = msg.handle!;
    switch (name) {
      case "help":
        await this.reply(msg, HELP_TEXT);
        return;
      case "new":
        resetThread(this.cfg, handle);
        this.persist();
        await this.reply(msg, "Started a fresh session. What can I do?");
        return;
      case "workspace": {
        const dir = resolve(arg.replace(/^~/, process.env.HOME ?? "~"));
        if (!arg) {
          await this.reply(msg, `Workspace: ${workspaceFor(this.cfg, handle)}`);
          return;
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          await this.reply(msg, `Not a directory: ${dir}`);
          return;
        }
        setThread(this.cfg, handle, { workspace: dir });
        this.persist();
        await this.reply(msg, `Workspace set to ${dir}`);
        return;
      }
      case "model": {
        if (!arg) {
          const m =
            getThread(this.cfg, handle).model ??
            this.cfg.defaultModel ??
            "(default)";
          await this.reply(msg, `Model: ${m}`);
          return;
        }
        setThread(this.cfg, handle, { model: arg });
        this.persist();
        await this.reply(msg, `Model set to ${arg}`);
        return;
      }
      case "mode": {
        if (!arg) {
          const m = getThread(this.cfg, handle).mode ?? this.cfg.defaultMode;
          await this.reply(msg, `Mode: ${m}`);
          return;
        }
        const mode = arg.toLowerCase();
        if (!MODES.has(mode)) {
          await this.reply(
            msg,
            `Unknown mode: ${arg}. Use agent, plan, or ask.`,
          );
          return;
        }
        setThread(this.cfg, handle, { mode: mode as AgentMode });
        this.persist();
        await this.reply(msg, `Mode set to ${mode}`);
        return;
      }
      case "ping": {
        const lines = [
          "pong",
          `workspace: ${workspaceFor(this.cfg, handle)}`,
          `agent: ${this.running ? "busy" : "idle"}`,
          `uptime: ${formatUptime(Date.now() - this.startedAt)}`,
        ];
        await this.reply(msg, lines.join("\n"));
        return;
      }
      case "status": {
        const t = getThread(this.cfg, handle);
        const lines = [
          `workspace: ${t.workspace ?? this.cfg.defaultWorkspace}`,
          `model: ${t.model ?? this.cfg.defaultModel ?? "(default)"}`,
          `mode: ${t.mode ?? this.cfg.defaultMode}`,
          `session: ${t.chatId ? "active" : "none"}`,
        ];
        await this.reply(msg, lines.join("\n"));
        return;
      }
      default:
        await this.reply(msg, `Unknown command: /${name}`);
    }
  }

  private async runPrompt(msg: IncomingMessage, prompt: string): Promise<void> {
    const handle = msg.handle!;
    const thread = getThread(this.cfg, handle);
    const workspace = workspaceFor(this.cfg, handle);
    this.running = true;

    // Acknowledge with a 👍 tapback when reactions are enabled; otherwise stay
    // silent and just send the reply once it's ready (no "on it..." bubble).
    await this.react(msg, "like");

    const res = await runAgent({
      prompt,
      workspace,
      chatId: thread.chatId,
      model: thread.model ?? this.cfg.defaultModel,
      mode: thread.mode ?? this.cfg.defaultMode,
      force: this.cfg.force,
    });

    this.running = false;

    if (res.chatId) {
      setThread(this.cfg, handle, { chatId: res.chatId });
      this.persist();
    }

    const text = res.result || (res.timedOut ? "That took too long and was stopped." : "(no response)");
    const formatted = formatReply(text);

    for (const bubble of formatted.bubbles) {
      await this.reply(msg, bubble);
    }
    for (const att of formatted.attachments) {
      if (msg.chatGuid) {
        try {
          await sendFile(att.path, msg.chatGuid);
        } catch (err) {
          log.warn("failed to send attachment", String(err));
        }
      }
    }
    if (!formatted.bubbles.length && !formatted.attachments.length) {
      await this.reply(msg, "(done)");
    }
  }

  /**
   * Loop circuit breaker. Records an outbound send for the handle and returns
   * false once the rate exceeds the threshold, so we stop replying until a new
   * inbound message resets it. Guards against runaway message loops.
   */
  private allowSend(handle: string | null): boolean {
    if (!handle) return true;
    if (this.breakerTripped.has(handle)) return false;
    const now = Date.now();
    const times = (this.replyTimes.get(handle) ?? []).filter(
      (t) => now - t < BREAKER_WINDOW_MS,
    );
    times.push(now);
    this.replyTimes.set(handle, times);
    if (times.length > BREAKER_MAX_REPLIES) {
      this.breakerTripped.add(handle);
      log.warn("loop circuit breaker tripped; pausing replies", {
        handle,
        window_ms: BREAKER_WINDOW_MS,
        max: BREAKER_MAX_REPLIES,
      });
      return false;
    }
    return true;
  }

  /** True if `text` duplicates the previous reply to this handle very recently. */
  private isDuplicate(handle: string | null, text: string): boolean {
    if (!handle) return false;
    const prev = this.lastSent.get(handle);
    return !!prev && prev.text === text && Date.now() - prev.at < DEDUP_WINDOW_MS;
  }

  private async reply(msg: IncomingMessage, text: string): Promise<void> {
    if (this.isDuplicate(msg.handle, text)) {
      log.warn("dropping duplicate reply", { handle: msg.handle });
      return;
    }
    if (!this.allowSend(msg.handle)) return;
    try {
      await sendText(text, {
        chatGuid: msg.chatGuid,
        handle: msg.handle,
        service: msg.service,
      });
      if (msg.handle) {
        this.lastSent.set(msg.handle, { text, at: Date.now() });
        this.selfChat.recordOutbound(msg.handle, text);
      }
    } catch (err) {
      log.error("failed to send reply", String(err));
    }
  }

  /**
   * React to the just-received message with a tapback. Returns false if
   * reactions are disabled or the UI automation failed, so callers can fall
   * back to a text reply.
   */
  private async react(
    msg: IncomingMessage,
    type: ReactionType,
  ): Promise<boolean> {
    if (!this.cfg.reactions) return false;
    if (!msg.chatGuid) return false;
    if (!this.allowSend(msg.handle)) return false;
    const chatLookup = msg.handle ?? msg.chatGuid;
    try {
      await sendReaction(type, { chatGuid: msg.chatGuid, chatLookup });
      return true;
    } catch (err) {
      log.warn("tapback failed; falling back to text", String(err));
      return false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Singleton guard: ensures only one daemon processes messages at a time. Two
 * concurrent daemons (e.g. a launchd instance plus a manual `__daemon` run)
 * each reply to every message, which looks like a message loop. Returns true if
 * this process acquired the lock.
 */
function acquireSingletonLock(): boolean {
  try {
    if (existsSync(PID_FILE)) {
      const prev = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      if (Number.isFinite(prev) && prev !== process.pid && isProcessAlive(prev)) {
        return false;
      }
    }
    writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch {
    return true; // Fail open: never block the only daemon on a lock error.
  }
}

function releaseSingletonLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      const owner = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      if (owner === process.pid) rmSync(PID_FILE);
    }
  } catch {
    /* best effort */
  }
}

/** Entry point used by the launchd-managed daemon process. */
export function runDaemon(): void {
  if (!acquireSingletonLock()) {
    log.warn("another cursy daemon is already running; exiting", {
      pidFile: PID_FILE,
    });
    // Exit cleanly so a manual run yields to the launchd-managed daemon.
    process.exit(0);
  }

  const daemon = new Daemon();
  daemon.start();

  const shutdown = () => {
    daemon.stop();
    releaseSingletonLock();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive.
  setInterval(() => {}, 1 << 30);
}

export { normalizeHandle };
