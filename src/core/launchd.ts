import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import {
  CONFIG_DIR,
  DAEMON_ERR_LOG,
  DAEMON_OUT_LOG,
  INSTALL_BIN,
  LAUNCHD_LABEL,
  LAUNCHD_PLIST,
} from "./paths.js";
import { homedir } from "node:os";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

/** True when running as the Bun-compiled single-file binary (not via bun/node). */
function isCompiled(): boolean {
  const exe = basename(process.execPath).toLowerCase();
  return exe !== "bun" && exe !== "node" && exe !== "node.exe";
}

/**
 * Copy the running compiled binary to the stable install path so the
 * LaunchAgent always points at a fixed location (which keeps the Full Disk
 * Access grant attached to one binary across rebuilds in the same location).
 * No-op in dev (running via bun/node).
 */
export function installBinary(): string | null {
  if (!isCompiled()) return null;
  if (process.execPath === INSTALL_BIN) return INSTALL_BIN;
  try {
    mkdirSync(dirname(INSTALL_BIN), { recursive: true });
    // Atomic install: copy to a temp file then rename into place. Renaming
    // (vs copying over) avoids corrupting a daemon that is currently executing
    // the existing binary - the running process keeps the old inode while the
    // directory entry is swapped to the new file.
    const tmp = `${INSTALL_BIN}.new`;
    copyFileSync(process.execPath, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, INSTALL_BIN);
    return INSTALL_BIN;
  } catch (err) {
    log.warn("failed to install binary to stable path", String(err));
    return null;
  }
}

/**
 * The path users must grant Full Disk Access to (and that macOS attributes the
 * daemon's access to). When compiled, this is the cursy binary itself.
 */
export function daemonBinaryPath(): string {
  if (existsSync(INSTALL_BIN)) return INSTALL_BIN;
  return process.execPath;
}

/** ProgramArguments for the LaunchAgent, resolving compiled vs dev modes. */
function daemonProgramArgs(): string[] {
  if (existsSync(INSTALL_BIN)) return [INSTALL_BIN, "__daemon"];
  if (isCompiled()) return [process.execPath, "__daemon"];
  // Dev: bun running the TS entry directly.
  return [process.execPath, "run", `${process.cwd()}/src/cli.ts`, "__daemon"];
}

function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the LaunchAgent plist. The daemon is started via the same node binary
 * running `cursy __daemon`. PATH is extended with ~/.local/bin so the
 * launchd-spawned process can find the cursor-agent binary.
 */
export function buildPlist(): string {
  const home = homedir();
  const path = `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const progArgs = daemonProgramArgs()
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(home)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(DAEMON_OUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(DAEMON_ERR_LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
  </dict>
</dict>
</plist>
`;
}

export function writePlist(): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true });
  writeFileSync(LAUNCHD_PLIST, buildPlist());
  return LAUNCHD_PLIST;
}

export function plistExists(): boolean {
  return existsSync(LAUNCHD_PLIST);
}

/** Load the agent (modern `bootstrap`, fall back to legacy `load`). */
export async function bootstrap(): Promise<void> {
  installBinary();
  writePlist();
  try {
    await execFileAsync("launchctl", ["bootstrap", guiDomain(), LAUNCHD_PLIST]);
  } catch {
    // Already bootstrapped or older launchctl: try legacy load.
    await execFileAsync("launchctl", ["load", "-w", LAUNCHD_PLIST]).catch(
      () => undefined,
    );
  }
}

/** Unload the agent. */
export async function bootout(): Promise<void> {
  try {
    await execFileAsync("launchctl", [
      "bootout",
      `${guiDomain()}/${LAUNCHD_LABEL}`,
    ]);
  } catch {
    await execFileAsync("launchctl", ["unload", "-w", LAUNCHD_PLIST]).catch(
      () => undefined,
    );
  }
}

/** Restart the running agent. */
export async function kickstart(): Promise<void> {
  await execFileAsync("launchctl", [
    "kickstart",
    "-k",
    `${guiDomain()}/${LAUNCHD_LABEL}`,
  ]).catch(async () => {
    await bootout();
    await bootstrap();
  });
}

export interface DaemonStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

/** Query launchd for the agent's current state. */
export async function status(): Promise<DaemonStatus> {
  try {
    const { stdout } = await execFileAsync("launchctl", [
      "print",
      `${guiDomain()}/${LAUNCHD_LABEL}`,
    ]);
    const pidMatch = stdout.match(/pid\s*=\s*(\d+)/);
    const stateMatch = stdout.match(/state\s*=\s*(\w+)/);
    const pid = pidMatch ? parseInt(pidMatch[1]!, 10) : null;
    const running = stateMatch ? stateMatch[1] === "running" : pid !== null;
    return { loaded: true, running, pid };
  } catch {
    return { loaded: false, running: false, pid: null };
  }
}
