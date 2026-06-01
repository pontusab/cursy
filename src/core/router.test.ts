import { describe, expect, test } from "bun:test";
import { parseInput } from "./router.js";

describe("parseInput", () => {
  test("empty input is ignored", () => {
    expect(parseInput("   ", null)).toEqual({ kind: "ignored", reason: "empty" });
  });

  test("plain text is a prompt", () => {
    expect(parseInput("list the files", null)).toEqual({
      kind: "prompt",
      prompt: "list the files",
    });
  });

  test("known slash command parses name + arg", () => {
    expect(parseInput("/workspace ~/code/app", null)).toEqual({
      kind: "command",
      name: "workspace",
      arg: "~/code/app",
    });
  });

  test("slash command without arg has empty arg", () => {
    expect(parseInput("/status", null)).toEqual({
      kind: "command",
      name: "status",
      arg: "",
    });
  });

  test("command name is lowercased", () => {
    expect(parseInput("/HELP", null)).toEqual({
      kind: "command",
      name: "help",
      arg: "",
    });
  });

  test("unknown slash command is ignored (not sent to agent)", () => {
    const r = parseInput("/frobnicate now", null);
    expect(r.kind).toBe("ignored");
  });

  test("respects a configured prefix", () => {
    expect(parseInput("cursy: build it", "cursy:")).toEqual({
      kind: "prompt",
      prompt: "build it",
    });
  });

  test("drops messages missing the configured prefix", () => {
    expect(parseInput("build it", "cursy:")).toEqual({
      kind: "ignored",
      reason: "missing prefix",
    });
  });

  test("prefix + command works", () => {
    expect(parseInput("cursy: /mode plan", "cursy:")).toEqual({
      kind: "command",
      name: "mode",
      arg: "plan",
    });
  });
});
