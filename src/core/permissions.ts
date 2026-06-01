import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import { CHAT_DB } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface PermissionStatus {
  ok: boolean;
  detail: string;
}

export interface AutomationStatus extends PermissionStatus {
  /** True when macOS has an explicit denial recorded (prompt won't re-fire). */
  denied: boolean;
}

export interface HostApp {
  /** Friendly name to show the user (the app TCC attributes grants to). */
  name: string;
  /** Bundle id for a scoped `tccutil reset`, if known. */
  bundleId: string | null;
}

const BUNDLE_NAMES: Record<string, string> = {
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.vscodium.codium": "VSCodium",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "dev.warp.Warp-Stable": "Warp",
  "co.zeit.hyper": "Hyper",
  "com.mitchellh.ghostty": "Ghostty",
};

const TERM_NAMES: Record<string, string> = {
  Apple_Terminal: "Terminal",
  "iTerm.app": "iTerm",
  vscode: "Cursor / VS Code",
  WarpTerminal: "Warp",
  Hyper: "Hyper",
  ghostty: "Ghostty",
};

/**
 * Identify the app macOS attributes Automation/Full Disk Access to. osascript
 * runs as a child of cursy, but TCC credits the *responsible* GUI app - i.e.
 * the terminal (or editor) the user launched cursy from. Users will see THAT
 * app in System Settings, never "cursy" or "node".
 */
export function detectHostApp(): HostApp {
  const bundleId = process.env.__CFBundleIdentifier || null;
  const term = process.env.TERM_PROGRAM || "";
  let name: string | null = null;
  if (bundleId && BUNDLE_NAMES[bundleId]) name = BUNDLE_NAMES[bundleId]!;
  if (!name && TERM_NAMES[term]) name = TERM_NAMES[term]!;
  if (!name && bundleId) name = bundleId;
  return { name: name || "your terminal app", bundleId };
}

/**
 * Full Disk Access is required to read ~/Library/Messages/chat.db. We detect it
 * by attempting an actual read-only query; macOS returns an EPERM/SQLITE error
 * when access is not granted to the host process.
 */
export function checkFullDiskAccess(): PermissionStatus {
  try {
    const db = new Database(CHAT_DB, { readonly: true });
    try {
      db.prepare("SELECT COUNT(*) AS n FROM message LIMIT 1").get();
    } finally {
      db.close();
    }
    return { ok: true, detail: "chat.db is readable" };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (
      /SQLITE_CANTOPEN|EPERM|not authorized|authorization denied|unable to open/i.test(
        msg,
      )
    ) {
      return {
        ok: false,
        detail: "Cannot read chat.db (grant Full Disk Access)",
      };
    }
    return { ok: false, detail: msg };
  }
}

/**
 * Automation permission lets us script Messages.app via osascript. We probe by
 * asking Messages for its account list, which requires the Automation grant but
 * has no side effects.
 *
 * When the grant is undecided, macOS shows the consent dialog and the command
 * blocks until the user responds - so pass a generous timeout when probing
 * interactively. Once denied, macOS returns error -1743 immediately and will
 * NOT re-prompt; we surface that as `denied` so the caller can offer a reset.
 */
export async function checkAutomationPermission(
  timeoutMs = 15000,
): Promise<AutomationStatus> {
  // `get version` always succeeds when authorized; avoids -1728 false
  // negatives from probing object properties that may not exist.
  const script = `tell application "Messages" to get version`;
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: timeoutMs });
    return { ok: true, detail: "Messages automation authorized", denied: false };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const denied = /-1743|not authorized|not allowed/i.test(msg);
    return {
      ok: false,
      denied,
      detail: denied
        ? "Automation denied for the host app (needs reset to re-prompt)"
        : msg,
    };
  }
}

/**
 * Reset recorded Automation (Apple Events) decisions so macOS will prompt
 * again. Scoped to the host app's bundle id when known, otherwise global.
 */
export async function resetAutomation(
  bundleId?: string | null,
): Promise<boolean> {
  try {
    const args = ["reset", "AppleEvents"];
    if (bundleId) args.push(bundleId);
    await execFileAsync("tccutil", args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accessibility permission is required to send tapbacks, which are driven by
 * synthesizing keystrokes via System Events. We probe with `UI elements
 * enabled`, which reports whether the *calling* process has the grant without
 * any side effects. Only needed when `reactions` is enabled.
 */
export async function checkAccessibility(
  timeoutMs = 10000,
): Promise<PermissionStatus> {
  const script = `tell application "System Events" to get UI elements enabled`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: timeoutMs,
    });
    const ok = stdout.trim() === "true";
    return {
      ok,
      detail: ok
        ? "Accessibility authorized"
        : "Accessibility not granted (needed for tapbacks)",
    };
  } catch (err) {
    return { ok: false, detail: String((err as Error).message ?? err) };
  }
}

/** Open the relevant System Settings privacy pane (best effort). */
export async function openPrivacyPane(
  pane: "FullDiskAccess" | "Automation" | "Accessibility",
): Promise<void> {
  const urls: Record<typeof pane, string> = {
    FullDiskAccess:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    Automation:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    Accessibility:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  };
  try {
    await execFileAsync("open", [urls[pane]]);
  } catch {
    /* best effort */
  }
}

/** Verify Messages.app is signed in to at least one iMessage account. */
export async function checkMessagesSignedIn(): Promise<PermissionStatus> {
  const script = `tell application "Messages" to get count of (accounts whose enabled is true)`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 15000,
    });
    const count = parseInt(stdout.trim(), 10);
    if (Number.isFinite(count) && count > 0) {
      return { ok: true, detail: `${count} active account(s)` };
    }
    return { ok: false, detail: "No enabled Messages accounts" };
  } catch (err) {
    return { ok: false, detail: String((err as Error).message ?? err) };
  }
}
