import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isConfigured, loadConfigOrDefault } from "../core/config.js";
import {
  CONFIG_DIR,
  INSTALL_BIN,
  LAUNCHD_PLIST,
  LOG_FILE,
  PID_FILE,
} from "../core/paths.js";
import {
  bootout,
  bootstrap,
  daemonBinaryPath,
  kickstart,
  status as launchdStatus,
} from "../core/launchd.js";
import {
  checkAccessibility,
  checkAutomationPermission,
  checkFullDiskAccess,
} from "../core/permissions.js";
import {
  checkCursorAgent,
  checkCursorAuth,
  loginCursorAgent,
} from "../core/deps.js";
import { onboardCommand } from "./onboard.js";

/**
 * Ensure cursor-agent is logged in before the daemon starts; otherwise every
 * prompt fails with an auth error. If not logged in, runs `cursor-agent login`
 * automatically (it opens a browser and blocks until done).
 */
async function ensureCursorLogin(): Promise<void> {
  const cursor = await checkCursorAgent();
  if (!cursor.ok) return; // doctor/onboard handle install; nothing to log into.
  if (cursor.warn) p.log.warn(cursor.warn);
  const auth = await checkCursorAuth();
  if (auth.ok) {
    p.log.success("cursor-agent is logged in.");
    return;
  }
  p.log.warn("cursor-agent isn't logged in - launching login...");
  p.log.info("Complete the login in your browser, then setup continues.");
  const res = await loginCursorAgent();
  if (res.ok) {
    p.log.success("Logged in to cursor-agent.");
  } else {
    p.log.warn(
      `${res.detail}. Run ${pc.cyan("cursor-agent login")} manually if the ` +
        "agent doesn't respond.",
    );
  }
}

export async function startCommand(): Promise<void> {
  if (!isConfigured()) {
    p.log.info("No configuration found - starting onboarding first.");
    await onboardCommand();
    return; // onboard installs + starts the daemon.
  }
  p.intro(pc.bgCyan(pc.black(" cursy start ")));
  await ensureCursorLogin();
  const s = p.spinner();
  s.start("Starting daemon");
  await bootstrap();
  await new Promise((r) => setTimeout(r, 1200));
  const st = await launchdStatus();
  s.stop(
    st.running
      ? `Daemon running (pid ${st.pid})`
      : "Daemon loaded (starting...)",
  );
  p.outro(pc.green("cursy is listening for your messages."));
}

export async function stopCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" cursy stop ")));
  const s = p.spinner();
  s.start("Stopping daemon");
  await bootout();
  s.stop("Daemon stopped");
  p.outro("Done.");
}

export async function uninstallCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" cursy uninstall ")));

  const purge = await p.confirm({
    message: "Also delete your config, logs, and session data?",
    initialValue: false,
  });
  if (p.isCancel(purge)) {
    p.cancel("Aborted.");
    return;
  }

  const s = p.spinner();
  s.start("Stopping and removing the LaunchAgent");
  await bootout();
  for (const f of [LAUNCHD_PLIST, PID_FILE]) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      /* best effort */
    }
  }
  s.stop("LaunchAgent removed");

  if (purge) {
    try {
      if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true });
      p.log.success("Removed ~/.config/cursy");
    } catch (err) {
      p.log.warn(`Could not remove config dir: ${String(err)}`);
    }
  } else {
    p.log.info(`Config kept at ${CONFIG_DIR}`);
  }

  if (existsSync(INSTALL_BIN)) {
    p.log.message(
      pc.dim(`The binary remains at ${INSTALL_BIN}. Remove it with:\n`) +
        pc.cyan(`  rm ${INSTALL_BIN}`),
    );
  }
  p.outro(pc.green("cursy uninstalled."));
}

export async function restartCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" cursy restart ")));
  const s = p.spinner();
  s.start("Restarting daemon");
  await kickstart();
  await new Promise((r) => setTimeout(r, 1200));
  const st = await launchdStatus();
  s.stop(st.running ? `Daemon running (pid ${st.pid})` : "Daemon restarted");
  p.outro("Done.");
}

export async function statusCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" cursy status ")));

  const st = await launchdStatus();
  const stateText = st.running
    ? pc.green(`running (pid ${st.pid})`)
    : st.loaded
      ? pc.yellow("loaded, not running")
      : pc.red("not installed");
  p.log.message(`${pc.bold("daemon")}      ${stateText}`);

  const cfg = loadConfigOrDefault();
  if (isConfigured()) {
    p.log.message(`${pc.bold("workspace")}   ${pc.dim(cfg.defaultWorkspace)}`);
    p.log.message(
      `${pc.bold("model")}       ${pc.dim(cfg.defaultModel ?? "(default)")}`,
    );
    p.log.message(`${pc.bold("mode")}        ${pc.dim(cfg.defaultMode)}`);
    p.log.message(
      `${pc.bold("whitelist")}   ${pc.dim(cfg.whitelist.join(", ") || "(none)")}`,
    );
    p.log.message(
      `${pc.bold("threads")}     ${pc.dim(String(Object.keys(cfg.threads).length))}`,
    );
  } else {
    p.log.warn("Not configured. Run `cursy onboard` or `cursy start`.");
  }

  // Quick permission probes. NOTE: these run as THIS process, so they reflect
  // the host terminal's permissions - not the launchd daemon's identity.
  const fda = checkFullDiskAccess();
  p.log.message(
    `${pc.bold("full disk")}   ${fda.ok ? pc.green("ok") : pc.red(fda.detail)} ${pc.dim("(this terminal)")}`,
  );
  const auto = await checkAutomationPermission();
  p.log.message(
    `${pc.bold("automation")}  ${auto.ok ? pc.green("ok") : pc.red(auto.detail)} ${pc.dim("(this terminal)")}`,
  );
  const cursor = await checkCursorAgent();
  p.log.message(
    `${pc.bold("cursor-agent")} ${cursor.ok ? pc.green("ok") : pc.red(cursor.detail)}`,
  );
  if (cursor.warn) p.log.warn(cursor.warn);
  if (cfg.reactions) {
    const ax = await checkAccessibility();
    p.log.message(
      `${pc.bold("accessibility")} ${ax.ok ? pc.green("ok") : pc.yellow(ax.detail)} ${pc.dim("(tapbacks; this terminal)")}`,
    );
  }

  // The real signal: what is the running daemon actually able to do? Inspect
  // its recent log for permission errors.
  if (st.running) {
    const health = daemonReadHealth();
    if (health === "blocked") {
      p.log.error(
        `${pc.bold("daemon reads")} ${pc.red("BLOCKED")} - grant Full Disk Access to:\n` +
          pc.cyan(`  ${daemonBinaryPath()}`),
      );
    } else if (health === "ok") {
      p.log.message(`${pc.bold("daemon reads")} ${pc.green("ok")}`);
    } else {
      p.log.message(`${pc.bold("daemon reads")} ${pc.dim("unknown (no recent log)")}`);
    }
  }

  p.outro(pc.dim("cursy logs -f  to follow activity"));
}

/**
 * Inspect the daemon log for recent permission failures. This reflects the
 * daemon's real (launchd) TCC identity, unlike the in-process probes above.
 */
function daemonReadHealth(): "ok" | "blocked" | "unknown" {
  if (!existsSync(LOG_FILE)) return "unknown";
  let lines: string[];
  try {
    lines = readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-60);
  } catch {
    return "unknown";
  }
  // Only consider events emitted since the most recent "daemon starting":
  // earlier denials may belong to a prior (pre-grant) process and would
  // otherwise produce a false "blocked".
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.includes('"msg":"daemon starting"')) {
      startIdx = i;
      break;
    }
  }
  const relevant = lines.slice(startIdx);
  let sawError = false;
  let sawRead = false;
  for (const line of relevant) {
    try {
      const e = JSON.parse(line) as { msg?: string; meta?: unknown };
      const meta =
        typeof e.meta === "string" ? e.meta : JSON.stringify(e.meta ?? "");
      if (/authorization denied|unable to open|SQLITE_CANTOPEN|EPERM/i.test(meta)) {
        sawError = true;
      }
      if (e.msg === "read ok") sawRead = true;
    } catch {
      /* ignore non-JSON */
    }
  }
  if (sawError && !sawRead) return "blocked";
  if (sawRead) return "ok";
  return "unknown";
}

export function logsCommand(follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log(pc.dim(`No log file yet at ${LOG_FILE}`));
    return;
  }
  const args = ["-n", "200"];
  if (follow) args.push("-f");
  args.push(LOG_FILE);
  const child = spawn("tail", args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error("Failed to tail logs:", err);
  });
}
