import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { CONFIG_DIR, LOG_FILE } from "./paths.js";

type Level = "info" | "warn" | "error" | "debug";

/** Rotate the log once it grows past this size (keeps one .1 backup). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// In-memory byte counter so we don't stat() the file on every write. Seeded
// lazily from the existing file size on the first write of the process.
let bytesWritten = -1;

function rotateIfNeeded(lineBytes: number): void {
  if (bytesWritten < 0) {
    try {
      bytesWritten = statSync(LOG_FILE).size;
    } catch {
      bytesWritten = 0;
    }
  }
  bytesWritten += lineBytes;
  if (bytesWritten < MAX_LOG_BYTES) return;
  try {
    // Single rolling backup: cursy.log -> cursy.log.1 (overwrites old backup).
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // If rename fails, fall through; appendFileSync will keep appending.
  }
  bytesWritten = 0;
}

function write(level: Level, msg: string, meta?: unknown): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta !== undefined ? { meta } : {}),
  });
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    rotateIfNeeded(Buffer.byteLength(line) + 1);
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Logging must never crash the daemon.
  }
  // Mirror to stderr so launchd captures it in daemon.err.log too.
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  }
}

export const log = {
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (process.env.CURSY_DEBUG) write("debug", msg, meta);
  },
};
