import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  defaultConfig,
  saveConfig,
  loadConfigOrDefault,
  type CursyConfig,
} from "../core/config.js";
import { normalizeHandle } from "../core/handle.js";
import {
  checkAccessibility,
  checkAutomationPermission,
  checkFullDiskAccess,
  checkMessagesSignedIn,
  detectHostApp,
  openPrivacyPane,
  resetAutomation,
} from "../core/permissions.js";
import { bootstrap, daemonBinaryPath, status } from "../core/launchd.js";
import { LOG_FILE } from "../core/paths.js";
import { runDoctor } from "./doctor.js";
import { printConnectQr } from "./qr.js";

/**
 * The daemon runs under launchd as the `node` binary, which has its OWN TCC
 * identity - separate from the terminal you onboarded in. So even a clean
 * onboarding can leave a daemon that can't read chat.db or send. After starting
 * it, inspect the fresh log for permission errors and give exact guidance.
 */
async function verifyDaemonHealth(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3500));
  let recent = "";
  try {
    if (existsSync(LOG_FILE)) {
      const lines = readFileSync(LOG_FILE, "utf8").trim().split("\n");
      recent = lines.slice(-40).join("\n");
    }
  } catch {
    return;
  }

  const fdaProblem =
    /unable to open database|SQLITE_CANTOPEN|EPERM|authorization denied/i.test(
      recent,
    );
  const autoProblem = /-1743|not authorized|not allowed/i.test(recent);

  if (!fdaProblem && !autoProblem) {
    p.log.success("Daemon health check passed - it can read Messages.");
    return;
  }

  const binPath = daemonBinaryPath();
  const binName = binPath.split("/").pop() || "cursy";
  if (fdaProblem) {
    p.log.warn(
      "The background daemon can't read your Messages database yet.\n" +
        pc.dim(
          "Because it runs via launchd, macOS attributes its access to the\n" +
            "daemon binary, not your terminal. Add THIS binary to Full Disk Access:\n",
        ) +
        pc.cyan(`  ${binPath}\n`) +
        pc.dim("Tip: in the Full Disk Access list, click +, press Cmd+Shift+G, and paste that path."),
    );
    await openPrivacyPane("FullDiskAccess");
  }
  if (autoProblem) {
    p.log.warn(
      "The daemon was blocked from controlling Messages. The first time it\n" +
        "tries to reply, macOS should show a " +
        pc.bold(`"${binName} wants to control Messages"`) +
        " prompt - approve it.",
    );
  }
  p.log.message(
    pc.dim("After granting, run `cursy restart`, then text yourself to test."),
  );
}

function bail(value: unknown): asserts value is never {
  if (p.isCancel(value)) {
    p.cancel("Onboarding cancelled.");
    process.exit(130);
  }
}

const MAX_PERM_ATTEMPTS = 3;

type PermFlow = "granted" | "skipped" | "aborted";

/**
 * After a bounded number of failed attempts, stop looping and let the user
 * choose what to do, so onboarding can never get stuck retrying forever.
 */
async function stuckChoice(what: string): Promise<"retry" | "skip" | "abort"> {
  const choice = await p.select({
    message: `Still can't verify ${what}. What now?`,
    options: [
      { value: "retry", label: "Retry the check" },
      { value: "skip", label: "Skip for now (cursy won't fully work until granted)" },
      { value: "abort", label: "Abort onboarding" },
    ],
    initialValue: "retry",
  });
  bail(choice);
  return choice as "retry" | "skip" | "abort";
}

async function ensureFullDiskAccess(): Promise<PermFlow> {
  const host = detectHostApp();
  let res = checkFullDiskAccess();
  let attempts = 0;
  while (!res.ok) {
    attempts++;
    p.log.warn(
      "cursy needs Full Disk Access to read your Messages database.\n" +
        pc.dim(
          `In the window that opens, add and enable ${pc.bold(host.name)} ` +
            `(the app you ran cursy from).\n` +
            `You will NOT see "cursy" listed - macOS grants access to the host app.\n` +
            `If it still fails after enabling, fully quit and reopen ${host.name}.`,
        ),
    );
    await openPrivacyPane("FullDiskAccess");
    if (attempts >= MAX_PERM_ATTEMPTS) {
      const choice = await stuckChoice("Full Disk Access");
      if (choice === "abort") return "aborted";
      if (choice === "skip") return "skipped";
    } else {
      const retry = await p.confirm({
        message: `Enabled ${host.name} in Full Disk Access? Retry check?`,
      });
      bail(retry);
      if (!retry) return "aborted";
    }
    res = checkFullDiskAccess();
  }
  p.log.success("Full Disk Access granted.");
  return "granted";
}

async function ensureAutomation(): Promise<PermFlow> {
  const host = detectHostApp();
  // Use a long timeout so the probe waits for the user to answer the dialog.
  let res = await checkAutomationPermission(120_000);
  let attempts = 0;
  while (!res.ok) {
    attempts++;

    if (res.denied) {
      // The prompt will NOT re-appear while a denial is on record. Offer to
      // reset it so the next probe can trigger a fresh consent dialog. This is
      // the key fix for the "retry forever" dead-end.
      p.log.warn(
        `Automation is currently denied for ${pc.bold(host.name)}.\n` +
          pc.dim("macOS won't ask again until the old decision is cleared."),
      );
      const doReset = await p.confirm({
        message: `Reset the Automation permission so macOS asks again${
          host.bundleId ? ` (just for ${host.name})` : ""
        }?`,
      });
      bail(doReset);
      if (doReset) {
        const s = p.spinner();
        s.start("Resetting Automation permission");
        const ok = await resetAutomation(host.bundleId);
        s.stop(
          ok
            ? "Reset done - the consent dialog should appear on the next check"
            : "Reset failed; enable it manually in System Settings",
        );
      } else {
        await openPrivacyPane("Automation");
      }
    } else {
      p.log.warn(
        "A macOS dialog should appear: " +
          pc.bold(`"${host.name} wants to control Messages"`) +
          " - click OK.\n" +
          pc.dim(
            `If you don't see it, enable ${host.name} > Messages under\n` +
              "System Settings > Privacy & Security > Automation.",
          ),
      );
      await openPrivacyPane("Automation");
    }

    if (attempts >= MAX_PERM_ATTEMPTS) {
      const choice = await stuckChoice("Automation");
      if (choice === "abort") return "aborted";
      if (choice === "skip") return "skipped";
    } else {
      const retry = await p.confirm({
        message: "Retry the Automation check now? (a dialog may appear)",
      });
      bail(retry);
      if (!retry) return "aborted";
    }
    res = await checkAutomationPermission(120_000);
  }
  p.log.success(`Messages automation authorized (${host.name}).`);
  return "granted";
}

/**
 * Accessibility is only needed for tapbacks, which gracefully fall back to text.
 * So this step is advisory and bounded - never blocks onboarding.
 */
async function ensureAccessibility(): Promise<void> {
  const host = detectHostApp();
  let res = await checkAccessibility();
  let attempts = 0;
  while (!res.ok && attempts < MAX_PERM_ATTEMPTS) {
    attempts++;
    p.log.warn(
      "Tapbacks need Accessibility permission.\n" +
        pc.dim(
          `In the window that opens, add and enable ${pc.bold(host.name)} ` +
            "under Accessibility.\n" +
            "Without it, cursy still works - it just sends an \"on it...\" text instead of a 👍.",
        ),
    );
    await openPrivacyPane("Accessibility");
    const retry = await p.confirm({
      message: `Enabled ${host.name} in Accessibility? Retry check? (No = skip, reactions fall back to text)`,
    });
    bail(retry);
    if (!retry) break;
    res = await checkAccessibility();
  }
  if (res.ok) {
    p.log.success("Accessibility granted - tapbacks enabled.");
  } else {
    p.log.warn(
      "Continuing without Accessibility. Reactions will fall back to text " +
        "until granted (re-run `cursy onboard` or grant it in System Settings).",
    );
  }
}

function validateDir(input: string): string | undefined {
  if (!input) return "Please enter a path";
  const dir = resolve(input.replace(/^~/, process.env.HOME ?? "~"));
  if (!existsSync(dir)) return `Does not exist: ${dir}`;
  if (!statSync(dir).isDirectory()) return `Not a directory: ${dir}`;
  return undefined;
}

export async function onboardCommand(): Promise<CursyConfig> {
  p.intro(pc.bgCyan(pc.black(" cursy onboarding ")));
  p.note(
    "Control Cursor from iMessage. Everything runs locally on this Mac.",
    "Welcome",
  );

  // 1. Dependencies.
  p.log.step("Checking dependencies");
  const depsOk = await runDoctor({ interactive: true });
  if (!depsOk) {
    const cont = await p.confirm({
      message: "Some required dependencies are missing. Continue anyway?",
      initialValue: false,
    });
    bail(cont);
    if (!cont) {
      p.cancel("Resolve dependencies and re-run `cursy onboard`.");
      process.exit(1);
    }
  }

  // 2. Permissions.
  p.log.step("Checking macOS permissions");
  const signedIn = await checkMessagesSignedIn();
  if (!signedIn.ok) {
    p.log.warn(
      `Messages may not be signed in (${signedIn.detail}). ` +
        "Open Messages.app and sign in to iMessage.",
    );
  }
  const fda = await ensureFullDiskAccess();
  if (fda === "aborted") {
    p.cancel("Full Disk Access is required. Re-run `cursy onboard` when ready.");
    process.exit(1);
  }
  if (fda === "skipped") {
    p.log.warn(
      "Continuing without Full Disk Access. The daemon can't read messages " +
        "until you grant it; re-run `cursy onboard` or use `cursy doctor`.",
    );
  }

  const automation = await ensureAutomation();
  if (automation === "aborted") {
    p.cancel(
      "Automation permission is required. Re-run `cursy onboard` when ready.",
    );
    process.exit(1);
  }
  if (automation === "skipped") {
    p.log.warn(
      "Continuing without Automation. cursy can't send replies until you " +
        "grant it (re-run onboarding to retry, including an auto-reset option).",
    );
  }

  // 3. Identity / whitelist. The only question we truly need.
  p.log.step("Who can control the agent?");
  const selfHandle = await p.text({
    message: "Your phone number or iMessage email (used to whitelist you):",
    placeholder: "+15551234567",
    validate: (v) => (v.trim() ? undefined : "Required"),
  });
  bail(selfHandle);

  const whitelist = [String(selfHandle).trim()]
    .filter(Boolean)
    .map(normalizeHandle);

  p.note(
    "Heads up: when you text your OWN number, Messages shows your message\n" +
      "twice (once sent, once received). That's an Apple quirk for self-chats,\n" +
      "not a cursy bug - your prompt still runs once and gets one reply.\n" +
      "Want a clean thread? See \"Clean thread (optional)\" in the README.",
    "Texting yourself",
  );

  // 4. Workspace - the actual project the agent will build in.
  p.log.step("Which project should cursy work in?");
  p.note(
    "This is the repo cursy opens for every message - it reads, edits, and\n" +
      "runs commands here. Point it at a real project you want to build on.\n" +
      "Tip: run `cursy onboard` from inside that repo so this defaults to it.",
    "Project workspace",
  );
  const workspace = await p.text({
    message: "Project directory the agent should build in:",
    placeholder: process.cwd(),
    defaultValue: process.cwd(),
    validate: validateDir,
  });
  bail(workspace);

  // Everything else uses sensible defaults (change later via `cursy config`):
  // mode=agent, model=account default, force=true, reactions=off, no passphrase.
  const base = loadConfigOrDefault();
  const cfg: CursyConfig = {
    ...defaultConfig(),
    ...base,
    whitelist,
    commandPrefix: null,
    passphrase: null,
    defaultWorkspace: resolve(
      String(workspace || process.cwd()).replace(/^~/, process.env.HOME ?? "~"),
    ),
    defaultModel: null,
    defaultMode: "agent",
    force: true,
    reactions: false,
    // Reset auth gating for all threads when (re)onboarding.
    threads: {},
  };
  saveConfig(cfg);
  p.log.success("Saved config to ~/.config/cursy/config.json");

  // Install + start daemon automatically (the whole point of onboarding).
  {
    const s = p.spinner();
    s.start("Installing LaunchAgent");
    await bootstrap();
    await new Promise((r) => setTimeout(r, 1500));
    const st = await status();
    s.stop(
      st.running
        ? `Daemon running (pid ${st.pid})`
        : st.loaded
          ? "Daemon installed (starting...)"
          : "Daemon installed",
    );
    await verifyDaemonHealth();
  }

  // Show a QR that opens Messages (prefilled) on the user's iPhone.
  await printConnectQr();

  p.outro(
    pc.green("Setup complete!") +
      pc.dim(
        `\nScan the QR above with your iPhone, or text your own number.\n` +
          `cursy builds in ${cfg.defaultWorkspace}.\n` +
          `Point it at another project anytime with \`cursy config\`, then \`cursy restart\`.`,
      ),
  );
  return cfg;
}
