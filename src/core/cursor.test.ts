import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCursorBin, runAgent, workspaceError } from "./cursor.js";

const ORIG_HOME = process.env.HOME;
const ORIG_BIN = process.env.CURSY_CURSOR_BIN;

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_BIN === undefined) delete process.env.CURSY_CURSOR_BIN;
  else process.env.CURSY_CURSOR_BIN = ORIG_BIN;
});

describe("resolveCursorBin", () => {
  test("honors CURSY_CURSOR_BIN override verbatim", () => {
    process.env.CURSY_CURSOR_BIN = "/custom/path/cursor-agent";
    expect(resolveCursorBin()).toBe("/custom/path/cursor-agent");
  });

  test("resolves a ~/.local/bin/cursor-agent symlink to its real target", () => {
    delete process.env.CURSY_CURSOR_BIN;
    const home = mkdtempSync(join(tmpdir(), "cursy-home-"));
    try {
      const binDir = join(home, ".local", "bin");
      mkdirSync(binDir, { recursive: true });
      // The concrete versioned launcher the symlink points at - resolving to
      // this is what keeps spawns stable while the symlink is swapped.
      const versioned = join(home, ".local", "share", "cursor-agent", "v1");
      mkdirSync(versioned, { recursive: true });
      const target = join(versioned, "cursor-agent");
      writeFileSync(target, "#!/usr/bin/env bash\n", { mode: 0o755 });
      symlinkSync(target, join(binDir, "cursor-agent"));

      process.env.HOME = home;
      expect(resolveCursorBin()).toBe(realpathSync(target));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to bare 'cursor-agent' when none is installed", () => {
    delete process.env.CURSY_CURSOR_BIN;
    const home = mkdtempSync(join(tmpdir(), "cursy-empty-"));
    try {
      process.env.HOME = home;
      expect(resolveCursorBin()).toBe("cursor-agent");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("workspaceError", () => {
  test("returns null for an existing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursy-ws-"));
    try {
      expect(workspaceError(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for empty workspace (daemon uses cwd)", () => {
    expect(workspaceError("")).toBeNull();
  });

  test("errors when the path does not exist", () => {
    const err = workspaceError("/tmp/cursy-nonexistent-workspace-xyz");
    expect(err).toContain("does not exist");
    expect(err).toContain("cursy config");
  });

  test("errors when the path is a file, not a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursy-ws-file-"));
    const file = join(dir, "not-a-dir");
    try {
      writeFileSync(file, "");
      expect(workspaceError(file)).toContain("not a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runAgent --workspace fallback", () => {
  test("retries without --workspace when the agent rejects the flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursy-fallback-"));
    try {
      // Fake cursor-agent: reject --workspace (like older builds), otherwise
      // emit a stream-json result. Logs each call so we can assert the retry.
      const fake = join(dir, "cursor-agent");
      const calls = join(dir, "calls.log");
      writeFileSync(
        fake,
        [
          "#!/usr/bin/env bash",
          `echo "$@" >> "${calls}"`,
          'for a in "$@"; do',
          '  if [ "$a" = "--workspace" ]; then',
          `    echo "error: unknown option '--workspace'" >&2`,
          "    exit 1",
          "  fi",
          "done",
          `echo '{"type":"result","result":"ok-no-workspace"}'`,
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.CURSY_CURSOR_BIN = fake;

      const res = await runAgent({ prompt: "hi", workspace: dir });
      expect(res.result).toBe("ok-no-workspace");
      expect(res.timedOut).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
