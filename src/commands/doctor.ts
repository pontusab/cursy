import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  checkCursorAgent,
  checkCursorAuth,
  checkMacOS,
  checkNode,
  installCursorAgent,
  localBinOnPath,
  loginCursorAgent,
  type CheckResult,
} from "../core/deps.js";

export interface DoctorOptions {
  /** Prompt before installing/fixing. When false, only reports. */
  interactive?: boolean;
}

function line(label: string, res: CheckResult): void {
  const icon = res.ok ? pc.green("ok") : pc.red("missing");
  p.log.message(`${icon}  ${pc.bold(label)} ${pc.dim("- " + res.detail)}`);
  if (res.warn) p.log.warn(res.warn);
}

/**
 * Check (and optionally install) all dependencies. Returns true when every
 * required dependency is satisfied.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<boolean> {
  const interactive = opts.interactive ?? true;
  let allRequired = true;

  // Node (check only).
  const node = checkNode();
  line("Node.js", node);
  if (!node.ok) allRequired = false;

  // macOS (check only).
  const macos = await checkMacOS();
  line("macOS", macos);
  if (!macos.ok) allRequired = false;

  // cursor-agent CLI (installable).
  let cursor = await checkCursorAgent();
  if (!cursor.ok && interactive) {
    const doInstall = await p.confirm({
      message: "cursor-agent is not installed. Install it now?",
    });
    if (!p.isCancel(doInstall) && doInstall) {
      const s = p.spinner();
      s.start("Installing cursor-agent (curl https://cursor.com/install)");
      cursor = await installCursorAgent();
      s.stop(cursor.ok ? "cursor-agent installed" : "Install failed");
      if (cursor.ok && !localBinOnPath()) {
        p.log.warn(
          "Add ~/.local/bin to your PATH, e.g.:\n" +
            pc.dim(`  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`),
        );
      }
    }
  }
  line("cursor-agent", cursor);
  if (!cursor.ok) allRequired = false;

  // cursor-agent auth. Required for the agent to respond, so offer to log in.
  if (cursor.ok) {
    let auth = await checkCursorAuth();
    if (!auth.ok && interactive) {
      const doLogin = await p.confirm({
        message:
          "cursor-agent isn't logged in. Log in now? (opens a browser via `cursor-agent login`)",
        initialValue: true,
      });
      if (!p.isCancel(doLogin) && doLogin) {
        p.log.info("Launching cursor-agent login - complete it in your browser...");
        auth = await loginCursorAgent();
      }
    }
    line("cursor-agent auth", auth);
    if (!auth.ok) {
      allRequired = false;
      p.log.warn(
        "cursor-agent is not authenticated. Run " +
          pc.cyan("cursor-agent login") +
          " before starting, or the agent can't respond.",
      );
    }
  }

  return allRequired;
}

/** Standalone `cursy doctor` command. */
export async function doctorCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" cursy doctor ")));
  const ok = await runDoctor({ interactive: true });
  if (ok) {
    p.outro(pc.green("All required dependencies are satisfied."));
  } else {
    p.outro(pc.red("Some required dependencies are missing. See above."));
    process.exitCode = 1;
  }
}
