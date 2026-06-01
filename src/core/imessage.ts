import { execFile } from "node:child_process";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import { CHAT_DB } from "./paths.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

export type MessageService = "iMessage" | "SMS" | "RCS" | string;

export interface IncomingMessage {
  rowid: number;
  guid: string;
  text: string;
  /** Sender handle (phone/email), null for messages we sent. */
  handle: string | null;
  service: MessageService;
  /** Chat GUID used to reply in the same thread, e.g. "iMessage;-;+155...". */
  chatGuid: string | null;
  isFromMe: boolean;
  isGroup: boolean;
}

/** Open the Messages database read-only. Never writes. */
export function openDb(): Database {
  return new Database(CHAT_DB, { readonly: true });
}

/**
 * Decode the `attributedBody` blob used by modern macOS when the plain `text`
 * column is empty. The blob is an Apple "streamtyped" archive; the message
 * text is stored as a length-prefixed NSString. This parses the common case
 * and is tolerant of failure (returns null).
 */
function decodeAttributedBody(blob: Buffer): string | null {
  const marker = blob.indexOf("NSString");
  if (marker === -1) return null;
  // After the class name comes a small struct then a '+' (0x2b) sentinel that
  // immediately precedes the length-prefixed UTF-8 payload.
  const plus = blob.indexOf(0x2b, marker);
  if (plus === -1) return null;
  let i = plus + 1;
  if (i >= blob.length) return null;
  let len = blob[i]!;
  i += 1;
  if (len === 0x81) {
    if (i + 2 > blob.length) return null;
    len = blob.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > blob.length) return null;
    len = blob.readUInt32LE(i);
    i += 4;
  }
  if (len <= 0 || i + len > blob.length) return null;
  const text = blob.toString("utf8", i, i + len);
  // Reject obviously-binary results.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return null;
  return text;
}

interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  // bun:sqlite returns BLOB columns as Uint8Array.
  attributedBody: Uint8Array | null;
  isFromMe: number;
  service: string | null;
  handle: string | null;
  chatGuid: string | null;
  roomName: string | null;
}

const SELECT_NEW = `
  SELECT
    m.ROWID            AS rowid,
    m.guid             AS guid,
    m.text             AS text,
    m.attributedBody   AS attributedBody,
    m.is_from_me       AS isFromMe,
    m.service          AS service,
    h.id               AS handle,
    c.guid             AS chatGuid,
    c.room_name        AS roomName
  FROM message m
  LEFT JOIN handle h ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.ROWID > ?
    AND m.item_type = 0
    AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
  ORDER BY m.ROWID ASC
`;

function rowToMessage(row: MessageRow): IncomingMessage {
  let text = row.text ?? "";
  if (!text && row.attributedBody) {
    text = decodeAttributedBody(Buffer.from(row.attributedBody)) ?? "";
  }
  return {
    rowid: row.rowid,
    guid: row.guid,
    text: text.trim(),
    handle: row.handle,
    service: (row.service as MessageService) ?? "iMessage",
    chatGuid: row.chatGuid,
    isFromMe: row.isFromMe === 1,
    isGroup: Boolean(row.roomName),
  };
}

/** Read all messages with ROWID greater than `sinceRowid`, oldest first. */
export function readNewMessages(
  db: Database,
  sinceRowid: number,
): IncomingMessage[] {
  const rows = db.prepare(SELECT_NEW).all(sinceRowid) as MessageRow[];
  return rows.map(rowToMessage);
}

/** Current highest message ROWID, used to seed the watermark. */
export function getMaxRowid(db: Database): number {
  const row = db.prepare("SELECT MAX(ROWID) AS max FROM message").get() as {
    max: number | null;
  };
  return row.max ?? 0;
}

export interface WatchOptions {
  sinceRowid: number;
  /** Polling fallback interval in ms (default 2000). */
  pollMs?: number;
  onMessage: (msg: IncomingMessage) => void | Promise<void>;
  onWatermark?: (rowid: number) => void;
}

/**
 * Watch the Messages database for new rows. Uses filesystem events on chat.db
 * and its WAL/SHM sidecars, backed by a polling fallback (macOS occasionally
 * drops FS events and SQLite rotates sidecar files). Returns a stop function.
 */
export function watch(opts: WatchOptions): () => void {
  const pollMs = opts.pollMs ?? 2000;
  let watermark = opts.sinceRowid;
  let draining = false;
  let stopped = false;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  let lastHeartbeat = 0;
  const drain = async (): Promise<void> => {
    if (draining || stopped) return;
    draining = true;
    try {
      const db = openDb();
      try {
        const messages = readNewMessages(db, watermark);
        // A successful read proves Full Disk Access; emit an occasional
        // heartbeat so `cursy status` can confirm the daemon is healthy even
        // when there's no message traffic.
        const now = Date.now();
        if (now - lastHeartbeat > 60_000) {
          lastHeartbeat = now;
          log.info("read ok", { watermark });
        }
        for (const msg of messages) {
          if (stopped) break;
          watermark = Math.max(watermark, msg.rowid);
          try {
            await opts.onMessage(msg);
          } catch (err) {
            log.error("onMessage handler threw", String(err));
          }
          opts.onWatermark?.(watermark);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      log.error("drain failed", String(err));
    } finally {
      draining = false;
    }
  };

  const schedule = () => {
    void drain();
  };

  // Filesystem watchers on the Messages directory catch WAL/SHM churn.
  const dir = dirname(CHAT_DB);
  try {
    const w = fsWatch(dir, { persistent: true }, (_event, filename) => {
      if (!filename) return schedule();
      if (filename.startsWith("chat.db")) schedule();
    });
    watchers.push(w);
  } catch (err) {
    log.warn("fs.watch on Messages dir failed; relying on polling", String(err));
  }

  // Polling fallback also re-arms watches that macOS may have dropped.
  timer = setInterval(schedule, pollMs);

  // Initial drain in case messages arrived before we started.
  schedule();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Invisible sentinel appended to every message cursy sends. When you text your
 * OWN number, Messages echoes the daemon's replies back into the same chat as
 * incoming (is_from_me=0) rows - so without a marker the agent would answer its
 * own replies forever. We tag outgoing text with these zero-width "invisible
 * separator" characters (rendered as nothing) and drop any inbound message that
 * carries them. U+2063 is not stripped by JS String.prototype.trim().
 */
export const CURSY_MARKER = "\u2063\u2063\u2063";

/** True if text was produced by cursy (carries the invisible marker). */
export function hasOwnMarker(text: string): boolean {
  return text.includes(CURSY_MARKER);
}

/** Remove the invisible cursy marker before comparing or displaying text. */
export function stripMarker(text: string): string {
  return text.split(CURSY_MARKER).join("");
}

/** Append the invisible self-echo marker to an outgoing message. */
function tag(text: string): string {
  return text + CURSY_MARKER;
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const SEND_TEXT_SCRIPT = `on run {targetGuid, msgText}
  tell application "Messages"
    send msgText to chat id targetGuid
  end tell
end run`;

const SEND_TO_HANDLE_SCRIPT = `on run {targetHandle, msgText, svc}
  tell application "Messages"
    set targetService to 1st account whose service type = (svc as service type)
    set targetBuddy to participant targetHandle of targetService
    send msgText to targetBuddy
  end tell
end run`;

const SEND_FILE_SCRIPT = `on run {targetGuid, filePath}
  tell application "Messages"
    send (POSIX file filePath) to chat id targetGuid
  end tell
end run`;

/**
 * Send a text message. Prefers replying into the existing chat by GUID; if
 * that fails (e.g. chat not addressable by id), falls back to addressing the
 * handle directly on the given service.
 */
export async function sendText(
  text: string,
  opts: { chatGuid?: string | null; handle?: string | null; service?: string },
): Promise<void> {
  // Tag with the invisible marker so our own echoes (in self-chats) are
  // recognizable and never re-processed as user prompts.
  const tagged = tag(text);
  if (opts.chatGuid) {
    try {
      await execFileAsync("osascript", [
        "-e",
        SEND_TEXT_SCRIPT,
        opts.chatGuid,
        tagged,
      ]);
      return;
    } catch (err) {
      log.warn("send by chat guid failed, trying handle", String(err));
    }
  }
  if (opts.handle) {
    const svc = opts.service === "SMS" ? "SMS" : "iMessage";
    await execFileAsync("osascript", [
      "-e",
      SEND_TO_HANDLE_SCRIPT,
      opts.handle,
      tagged,
      svc,
    ]);
    return;
  }
  throw new Error("sendText: no chatGuid or handle to address");
}

/** Send a file attachment into the given chat. */
export async function sendFile(
  filePath: string,
  chatGuid: string,
): Promise<void> {
  await execFileAsync("osascript", ["-e", SEND_FILE_SCRIPT, chatGuid, filePath]);
}

/** Standard iMessage tapbacks. The number is the key pressed in the picker. */
export type ReactionType =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasis"
  | "question";

const REACTION_KEY: Record<ReactionType, string> = {
  love: "1",
  like: "2",
  dislike: "3",
  laugh: "4",
  emphasis: "5",
  question: "6",
};

export const REACTION_EMOJI: Record<ReactionType, string> = {
  love: "\u2764\uFE0F",
  like: "\uD83D\uDC4D",
  dislike: "\uD83D\uDC4E",
  laugh: "\uD83D\uDE02",
  emphasis: "\u203C\uFE0F",
  question: "\u2753",
};

// Reacts to the MOST RECENT message in the target chat by driving the Messages
// UI: open the chat, then Cmd+T (tapback picker) -> digit -> Return. This is the
// only SIP-safe way to send tapbacks (Apple exposes no scripting verb for them).
// Mirrors steipete/imsg's `react` recipe. Requires Accessibility permission.
const SEND_REACTION_SCRIPT = `on run argv
  set chatGUID to item 1 of argv
  set chatLookup to item 2 of argv
  set reactionKey to item 3 of argv

  tell application "Messages"
    activate
    set targetChat to chat id chatGUID
  end tell

  delay 0.3

  tell application "System Events"
    tell process "Messages"
      keystroke "f" using command down
      delay 0.15
      keystroke "a" using command down
      keystroke chatLookup
      delay 0.25
      key code 36
      delay 0.35
      keystroke "t" using command down
      delay 0.2
      keystroke reactionKey
      delay 0.1
      key code 36
    end tell
  end tell
end run`;

/**
 * Send a standard tapback to the most recent message in a chat via UI
 * automation. Throws on failure (caller should fall back to a text reply).
 *
 * @param chatLookup A string to type into Messages search to navigate to the
 *   conversation (contact name, phone, or email).
 */
export async function sendReaction(
  type: ReactionType,
  opts: { chatGuid: string; chatLookup: string },
): Promise<void> {
  const key = REACTION_KEY[type];
  await execFileAsync(
    "osascript",
    ["-e", SEND_REACTION_SCRIPT, opts.chatGuid, opts.chatLookup, key],
    { timeout: 15000 },
  );
}

/** Fire a no-op AppleScript send to self to trigger the Automation TCC prompt. */
export async function probeAutomationPermission(
  selfHandle: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(
      "osascript",
      ["-e", SEND_TO_HANDLE_SCRIPT, selfHandle, "cursy: setup test", "iMessage"],
      { timeout: 15000 },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/** Used to escape values when building ad-hoc scripts (exported for reuse). */
export { escapeAppleScript };
