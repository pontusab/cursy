import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  configExists,
  loadConfigOrDefault,
  saveConfig,
  type AgentMode,
  type CursyConfig,
} from "../core/config.js";
import { normalizeHandle } from "../core/handle.js";

function redact(cfg: CursyConfig): Record<string, unknown> {
  return {
    whitelist: cfg.whitelist,
    commandPrefix: cfg.commandPrefix,
    passphrase: cfg.passphrase ? "(set)" : null,
    defaultWorkspace: cfg.defaultWorkspace,
    defaultModel: cfg.defaultModel,
    defaultMode: cfg.defaultMode,
    force: cfg.force,
    threads: Object.keys(cfg.threads).length,
    watermark: cfg.watermark,
  };
}

export function showConfig(): void {
  if (!configExists()) {
    console.log(pc.yellow("No config yet. Run `cursy onboard`."));
    return;
  }
  const cfg = loadConfigOrDefault();
  console.log(JSON.stringify(redact(cfg), null, 2));
}

export async function editConfig(): Promise<void> {
  if (!configExists()) {
    console.log(pc.yellow("No config yet. Run `cursy onboard` first."));
    return;
  }
  p.intro(pc.bgCyan(pc.black(" cursy config ")));
  const cfg = loadConfigOrDefault();

  const field = await p.select({
    message: "What do you want to change?",
    options: [
      { value: "whitelist", label: `whitelist (${cfg.whitelist.join(", ")})` },
      { value: "workspace", label: `default workspace (${cfg.defaultWorkspace})` },
      { value: "model", label: `default model (${cfg.defaultModel ?? "default"})` },
      { value: "mode", label: `default mode (${cfg.defaultMode})` },
      { value: "force", label: `force (${cfg.force})` },
      { value: "prefix", label: `command prefix (${cfg.commandPrefix ?? "none"})` },
      { value: "passphrase", label: `passphrase (${cfg.passphrase ? "set" : "none"})` },
    ],
  });
  if (p.isCancel(field)) {
    p.cancel("No changes.");
    return;
  }

  switch (field) {
    case "whitelist": {
      const v = await p.text({
        message: "Comma-separated handles allowed to control the agent:",
        defaultValue: cfg.whitelist.join(", "),
        initialValue: cfg.whitelist.join(", "),
      });
      if (p.isCancel(v)) break;
      cfg.whitelist = String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizeHandle);
      break;
    }
    case "workspace": {
      const v = await p.text({
        message: "Default workspace directory:",
        defaultValue: cfg.defaultWorkspace,
        initialValue: cfg.defaultWorkspace,
        validate: (input) => {
          const dir = resolve(input.replace(/^~/, process.env.HOME ?? "~"));
          if (!existsSync(dir) || !statSync(dir).isDirectory())
            return `Not a directory: ${dir}`;
          return undefined;
        },
      });
      if (p.isCancel(v)) break;
      cfg.defaultWorkspace = resolve(
        String(v).replace(/^~/, process.env.HOME ?? "~"),
      );
      break;
    }
    case "model": {
      const v = await p.text({
        message: "Default model (blank for account default):",
        defaultValue: cfg.defaultModel ?? "",
        initialValue: cfg.defaultModel ?? "",
      });
      if (p.isCancel(v)) break;
      cfg.defaultModel = String(v).trim() || null;
      break;
    }
    case "mode": {
      const v = await p.select({
        message: "Default mode:",
        options: [
          { value: "agent", label: "agent" },
          { value: "plan", label: "plan" },
          { value: "ask", label: "ask" },
        ],
        initialValue: cfg.defaultMode,
      });
      if (p.isCancel(v)) break;
      cfg.defaultMode = v as AgentMode;
      break;
    }
    case "force": {
      const v = await p.confirm({
        message: "Run with --force (file writes + shell)?",
        initialValue: cfg.force,
      });
      if (p.isCancel(v)) break;
      cfg.force = Boolean(v);
      break;
    }
    case "prefix": {
      const v = await p.text({
        message: "Command prefix (blank to disable):",
        defaultValue: cfg.commandPrefix ?? "",
        initialValue: cfg.commandPrefix ?? "",
      });
      if (p.isCancel(v)) break;
      cfg.commandPrefix = String(v).trim() || null;
      break;
    }
    case "passphrase": {
      const v = await p.password({
        message: "New passphrase (blank to disable):",
      });
      if (p.isCancel(v)) break;
      cfg.passphrase = String(v).trim() || null;
      cfg.threads = {}; // re-gate all threads
      break;
    }
  }

  saveConfig(cfg);
  p.outro(pc.green("Saved."));
}
