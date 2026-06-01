import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getCursorVersion, resolveCursorBin } from "./cursor.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  detail: string;
}

const MIN_NODE = [20, 12, 0];
const MIN_MACOS_MAJOR = 14;

export function checkNode(): CheckResult {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  const [rMaj, rMin] = MIN_NODE;
  const ok = maj > rMaj! || (maj === rMaj && min >= rMin!);
  return {
    ok,
    detail: ok
      ? `Node ${process.versions.node}`
      : `Node ${process.versions.node} (need >= ${MIN_NODE.join(".")})`,
  };
}

export async function checkMacOS(): Promise<CheckResult> {
  if (process.platform !== "darwin") {
    return { ok: false, detail: `Unsupported platform: ${process.platform}` };
  }
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"]);
    const version = stdout.trim();
    const major = parseInt(version.split(".")[0] ?? "0", 10);
    const ok = major >= MIN_MACOS_MAJOR;
    return {
      ok,
      detail: ok
        ? `macOS ${version}`
        : `macOS ${version} (need >= ${MIN_MACOS_MAJOR})`,
    };
  } catch (err) {
    return { ok: false, detail: String((err as Error).message ?? err) };
  }
}

export async function checkCursorAgent(): Promise<CheckResult> {
  const version = await getCursorVersion();
  return version
    ? { ok: true, detail: `cursor-agent ${version}` }
    : { ok: false, detail: "cursor-agent not found on PATH" };
}

/** Run the official Cursor CLI installer. */
export async function installCursorAgent(): Promise<CheckResult> {
  try {
    await execAsync("curl https://cursor.com/install -fsS | bash", {
      timeout: 180_000,
    });
    // The installer drops the binary in ~/.local/bin; ensure it's on PATH for
    // this process so the follow-up version check can find it.
    const home = process.env.HOME ?? "";
    process.env.PATH = `${home}/.local/bin:${process.env.PATH ?? ""}`;
    return await checkCursorAgent();
  } catch (err) {
    return { ok: false, detail: String((err as Error).message ?? err) };
  }
}

/**
 * Best-effort auth check. cursor-agent needs either a login or CURSOR_API_KEY;
 * runs fail silently otherwise. We can't fully verify without spending a
 * request, so this is advisory.
 */
export async function checkCursorAuth(): Promise<CheckResult> {
  if (process.env.CURSOR_API_KEY) {
    return { ok: true, detail: "CURSOR_API_KEY is set" };
  }
  try {
    const { stdout } = await execFileAsync(resolveCursorBin(), ["status"], {
      timeout: 15_000,
    });
    const out = stdout.toLowerCase();
    // Check the negative first: "Not logged in" contains the substring
    // "logged in", so a naive positive match gives a false positive.
    if (/not\s+(logged in|authenticated|signed in)|no\s+credentials/.test(out)) {
      return { ok: false, detail: "Not logged in (run: cursor-agent login)" };
    }
    if (/logged in|authenticated|signed in|@/.test(out)) {
      return { ok: true, detail: "Logged in" };
    }
    return { ok: false, detail: "Not logged in (run: cursor-agent login)" };
  } catch {
    return {
      ok: false,
      detail: "Could not verify auth (run: cursor-agent login)",
    };
  }
}

/**
 * Run `cursor-agent login` interactively. It opens a browser and blocks until
 * the user completes the flow (or it times out). stdio is inherited so the user
 * sees the login URL / prompts. Returns the post-login auth check.
 */
export async function loginCursorAgent(): Promise<CheckResult> {
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(resolveCursorBin(), ["login"], { stdio: "inherit" });
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });
  if (code === null) {
    return { ok: false, detail: "Could not launch cursor-agent login" };
  }
  return checkCursorAuth();
}

/** Whether ~/.local/bin is on PATH (cursor-agent install location). */
export function localBinOnPath(): boolean {
  const home = process.env.HOME ?? "";
  return (process.env.PATH ?? "")
    .split(":")
    .includes(`${home}/.local/bin`);
}
