import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_DIR } from "./paths.js";

/** Max characters per iMessage bubble before we split. */
const MAX_BUBBLE = 1400;
/** A fenced code block larger than this is sent as a file attachment. */
const CODE_ATTACH_CHARS = 800;
const CODE_ATTACH_LINES = 16;

export interface FormattedReply {
  /** Text bubbles to send in order. */
  bubbles: string[];
  /** Files to attach (large code/diffs extracted from the reply). */
  attachments: Array<{ path: string; language: string }>;
}

const LANG_EXT: Record<string, string> = {
  ts: "ts",
  typescript: "ts",
  js: "js",
  javascript: "js",
  py: "py",
  python: "py",
  rb: "rb",
  ruby: "rb",
  go: "go",
  rust: "rs",
  rs: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cs: "cs",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  md: "md",
};

let attachmentSeq = 0;

/** Convert lightweight markdown to plain text that reads well in Messages. */
export function stripMarkdown(text: string): string {
  return (
    text
      // Inline code -> bare text.
      .replace(/`([^`]+)`/g, "$1")
      // Bold/italic markers.
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1$2")
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1$2")
      // Headings: drop leading #'s.
      .replace(/^#{1,6}\s+/gm, "")
      // Bullet markers normalized to a dash.
      .replace(/^\s*[-*+]\s+/gm, "- ")
      // Links [text](url) -> text (url).
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      // Collapse 3+ blank lines.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

interface CodeBlock {
  language: string;
  body: string;
  full: string;
}

function findCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    blocks.push({
      language: (m[1] || "").trim().toLowerCase(),
      body: m[2] ?? "",
      full: m[0],
    });
  }
  return blocks;
}

function writeAttachment(block: CodeBlock): string {
  mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const ext = LANG_EXT[block.language] ?? "txt";
  const name = `cursy-${Date.now()}-${attachmentSeq++}.${ext}`;
  const path = join(ATTACHMENT_DIR, name);
  writeFileSync(path, block.body.replace(/\s+$/, "") + "\n");
  return path;
}

/** Split text into bubbles under MAX_BUBBLE, preferring paragraph/line breaks. */
export function chunk(text: string, max = MAX_BUBBLE): string[] {
  const out: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

/**
 * Turn raw agent output into iMessage-ready bubbles plus optional file
 * attachments for large code/diffs.
 */
export function formatReply(raw: string): FormattedReply {
  const attachments: FormattedReply["attachments"] = [];
  let text = raw;

  for (const block of findCodeBlocks(raw)) {
    const big =
      block.body.length > CODE_ATTACH_CHARS ||
      block.body.split("\n").length > CODE_ATTACH_LINES;
    if (big) {
      const path = writeAttachment(block);
      attachments.push({ path, language: block.language || "txt" });
      const label = `[sent ${block.language || "code"} as attachment]`;
      text = text.replace(block.full, label);
    } else {
      // Small code stays inline but without the fences.
      text = text.replace(block.full, block.body.trim());
    }
  }

  const plain = stripMarkdown(text);
  const bubbles = plain ? chunk(plain) : [];
  return { bubbles, attachments };
}
