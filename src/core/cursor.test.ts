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
import { resolveCursorBin } from "./cursor.js";

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
