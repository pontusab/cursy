import { describe, expect, test } from "bun:test";
import { chunk, formatReply, stripMarkdown } from "./format.js";

describe("stripMarkdown", () => {
  test("removes inline code backticks", () => {
    expect(stripMarkdown("run `npm test` now")).toBe("run npm test now");
  });

  test("strips bold and headings", () => {
    expect(stripMarkdown("# Title\n**bold** text")).toBe("Title\nbold text");
  });

  test("normalizes bullets and links", () => {
    expect(stripMarkdown("* item\n[docs](http://x.io)")).toBe(
      "- item\ndocs (http://x.io)",
    );
  });
});

describe("chunk", () => {
  test("short text is a single bubble", () => {
    expect(chunk("hello", 100)).toEqual(["hello"]);
  });

  test("splits long text and respects max length", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = chunk(text, 80);
    expect(out.length).toBeGreaterThan(1);
    for (const b of out) expect(b.length).toBeLessThanOrEqual(80);
  });

  test("reassembles to the original words", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const out = chunk(text, 12);
    expect(out.join(" ").split(/\s+/)).toEqual(text.split(" "));
  });
});

describe("formatReply", () => {
  test("small code blocks stay inline (no attachment)", () => {
    const r = formatReply("Here:\n```js\nconst a = 1;\n```\ndone");
    expect(r.attachments).toHaveLength(0);
    expect(r.bubbles.join("\n")).toContain("const a = 1;");
  });

  test("large code blocks become attachments", () => {
    const big = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join(
      "\n",
    );
    const r = formatReply("Result:\n```js\n" + big + "\n```");
    expect(r.attachments.length).toBe(1);
    expect(r.attachments[0]!.language).toBe("js");
    expect(r.bubbles.join("\n")).toContain("attachment");
  });
});
