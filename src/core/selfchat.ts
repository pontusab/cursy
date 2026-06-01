import { handlesMatch, matchWhitelist } from "./handle.js";
import { hasOwnMarker, stripMarker, type IncomingMessage } from "./imessage.js";

/** How long paired self-chat rows (is_from_me=0/1 twins) stay deduplicated. */
const TWIN_WINDOW_MS = 15_000;

/** How long recent outbound text is remembered to catch marker-stripped echoes. */
const OUTBOUND_ECHO_WINDOW_MS = 120_000;

/**
 * True when the message belongs to a 1:1 chat with a whitelisted handle — i.e.
 * the user texting their own number (or a whitelisted contact in a direct chat).
 * Used to apply self-chat-specific dedup rules without affecting other threads.
 */
export function isSelfChat(
  msg: IncomingMessage,
  whitelist: string[],
): boolean {
  if (!msg.chatGuid || !msg.handle) return false;
  if (!matchWhitelist(msg.handle, whitelist)) return false;
  const parts = msg.chatGuid.split(";-;");
  if (parts.length !== 2) return false;
  return handlesMatch(parts[1]!, msg.handle);
}

interface TwinRecord {
  text: string;
  fromMe: boolean;
  at: number;
}

/**
 * Tracks processed message GUIDs, self-chat twin pairs, and recent outbound
 * text so we never run the agent twice for one send and never re-process our
 * own echoed replies (even if Messages strips the invisible marker).
 */
export class SelfChatDeduper {
  private processedGuids = new Set<string>();
  private twins = new Map<string, TwinRecord[]>();
  private outbound = new Map<string, Array<{ text: string; at: number }>>();

  /** Record a message GUID we acted on (or intentionally skipped). */
  markSeen(guid: string): void {
    this.processedGuids.add(guid);
    if (this.processedGuids.size > 500) {
      // Bound memory; GUIDs are only needed for short-term replay protection.
      const drop = [...this.processedGuids].slice(0, 100);
      for (const g of drop) this.processedGuids.delete(g);
    }
  }

  hasSeen(guid: string): boolean {
    return this.processedGuids.has(guid);
  }

  /** Remember which side of a self-chat twin pair we processed. */
  recordTwin(handle: string, text: string, fromMe: boolean): void {
    const key = handle;
    const now = Date.now();
    const list = (this.twins.get(key) ?? []).filter(
      (t) => now - t.at < TWIN_WINDOW_MS,
    );
    list.push({ text, fromMe, at: now });
    this.twins.set(key, list);
  }

  /** True if the opposite is_from_me twin was already processed recently. */
  isTwinDuplicate(handle: string, text: string, fromMe: boolean): boolean {
    const now = Date.now();
    const list = this.twins.get(handle) ?? [];
    return list.some(
      (t) =>
        t.text === text &&
        t.fromMe !== fromMe &&
        now - t.at < TWIN_WINDOW_MS,
    );
  }

  /** Call after every successful outbound send. */
  recordOutbound(handle: string | null, text: string): void {
    if (!handle) return;
    const now = Date.now();
    const clean = stripMarker(text);
    const list = (this.outbound.get(handle) ?? []).filter(
      (e) => now - e.at < OUTBOUND_ECHO_WINDOW_MS,
    );
    list.push({ text: clean, at: now });
    this.outbound.set(handle, list);
  }

  /** True if inbound text matches something we recently sent (echo without marker). */
  isOutboundEcho(handle: string | null, text: string): boolean {
    if (!handle) return false;
    const now = Date.now();
    const clean = stripMarker(text);
    return (this.outbound.get(handle) ?? []).some(
      (e) => e.text === clean && now - e.at < OUTBOUND_ECHO_WINDOW_MS,
    );
  }
}

export type SelfChatDecision =
  | { action: "process" }
  | { action: "skip"; reason: string; markGuid?: boolean };

/**
 * Decide whether an incoming row should be processed, with self-chat-aware
 * filtering for is_from_me twins and outbound echoes.
 */
export function decideSelfChat(
  msg: IncomingMessage,
  whitelist: string[],
  deduper: SelfChatDeduper,
  cleanText: string,
): SelfChatDecision {
  if (deduper.hasSeen(msg.guid)) {
    return { action: "skip", reason: "duplicate guid", markGuid: true };
  }

  if (hasOwnMarker(cleanText)) {
    return { action: "skip", reason: "own marker", markGuid: true };
  }

  const selfChat = isSelfChat(msg, whitelist);

  // Empty is_from_me=1 rows are send receipts — never actionable.
  if (msg.isFromMe && !cleanText) {
    return { action: "skip", reason: "empty sent receipt", markGuid: true };
  }

  // Non-self-chat: ignore our own sends (only inbound from others matters).
  if (msg.isFromMe && !selfChat) {
    return { action: "skip", reason: "is_from_me", markGuid: true };
  }

  // Self-chat outbound echo without marker (Messages sometimes strips it).
  if (!msg.isFromMe && deduper.isOutboundEcho(msg.handle, cleanText)) {
    return { action: "skip", reason: "outbound echo", markGuid: true };
  }

  // Self-chat twin: macOS writes both is_from_me=1 (sent) and is_from_me=0
  // (received) rows for a single user message — process only one.
  if (selfChat && msg.handle && deduper.isTwinDuplicate(msg.handle, cleanText, msg.isFromMe)) {
    return { action: "skip", reason: "self-chat twin", markGuid: true };
  }

  return { action: "process" };
}
