import { homedir } from "node:os";
import { join } from "node:path";

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

/** Stable install location for the compiled single-file binary. */
export const INSTALL_BIN = join(homedir(), ".local", "bin", "cursy");

export const CONFIG_DIR = join(XDG_CONFIG, "cursy");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const LOG_FILE = join(CONFIG_DIR, "cursy.log");
export const DAEMON_OUT_LOG = join(CONFIG_DIR, "daemon.out.log");
export const DAEMON_ERR_LOG = join(CONFIG_DIR, "daemon.err.log");
export const PID_FILE = join(CONFIG_DIR, "daemon.pid");
export const ATTACHMENT_DIR = join(CONFIG_DIR, "outgoing");

/** Path to the local Messages SQLite database. */
export const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");

export const LAUNCHD_LABEL = "dev.cursy.daemon";
export const LAUNCHD_PLIST = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
