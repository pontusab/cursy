#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { onboardCommand } from "./commands/onboard.js";
import { doctorCommand } from "./commands/doctor.js";
import {
  logsCommand,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
  uninstallCommand,
} from "./commands/daemon.js";
import { editConfig, showConfig } from "./commands/config.js";
import { qrCommand } from "./commands/qr.js";
import { runDaemon } from "./core/daemon.js";
import { augmentPath } from "./core/cursor.js";

// GUI/launchd-spawned processes inherit a minimal PATH that omits ~/.local/bin
// (where cursor-agent installs). Restore the common bin dirs up front.
augmentPath();

const program = new Command();

program
  .name("cursy")
  .description("Control Cursor from iMessage. Runs locally on your Mac.")
  .version("0.1.3");

program
  .command("onboard")
  .description("Guided setup: dependencies, permissions, whitelist, daemon")
  .action(async () => {
    await onboardCommand();
  });

program
  .command("doctor")
  .description("Check and install dependencies (cursor-agent, versions, auth)")
  .action(async () => {
    await doctorCommand();
  });

program
  .command("start")
  .description("Start the background daemon (runs onboarding if unconfigured)")
  .action(async () => {
    await startCommand();
  });

program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    await stopCommand();
  });

program
  .command("restart")
  .description("Restart the background daemon")
  .action(async () => {
    await restartCommand();
  });

program
  .command("uninstall")
  .description("Stop the daemon and remove the LaunchAgent (optionally purge config)")
  .action(async () => {
    await uninstallCommand();
  });

program
  .command("status")
  .description("Show daemon state, config, and permission checks")
  .action(async () => {
    await statusCommand();
  });

program
  .command("logs")
  .description("Show daemon activity log")
  .option("-f, --follow", "follow the log", false)
  .action((opts: { follow?: boolean }) => {
    logsCommand(Boolean(opts.follow));
  });

program
  .command("config")
  .description("View or edit configuration")
  .option("--show", "print the current config and exit", false)
  .action(async (opts: { show?: boolean }) => {
    if (opts.show) showConfig();
    else await editConfig();
  });

program
  .command("qr")
  .description("Show a QR that opens Messages on your phone, prefilled to text cursy")
  .argument("[prompt...]", "optional starter prompt to prefill")
  .action(async (prompt: string[]) => {
    await qrCommand(prompt?.join(" "));
  });

// Hidden command launched by launchd; runs the long-lived daemon process.
program
  .command("__daemon", { hidden: true })
  .description("Internal: run the daemon loop in the foreground")
  .action(() => {
    runDaemon();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red("cursy error:"), err);
  process.exit(1);
});
