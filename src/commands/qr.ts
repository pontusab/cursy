import * as p from "@clack/prompts";
import pc from "picocolors";
import QRCode from "qrcode";
import { loadConfigOrDefault } from "../core/config.js";

/** Default starter prompt prefilled in the message when the QR is scanned. */
const DEFAULT_PROMPT = "Hey Cursy! Build me a small new feature in this project.";

/**
 * Turn a stored handle back into an addressable target for an `sms:` URL.
 * Whitelist phone numbers are stored as digits only; re-add a leading "+" so
 * iOS treats it as E.164. Emails (iMessage) are passed through unchanged.
 */
function handleToAddress(handle: string): string {
  if (handle.includes("@")) return handle;
  const digits = handle.replace(/[^\d]/g, "");
  return `+${digits}`;
}

/**
 * Build the `sms:` URL that, when opened on iPhone, launches Messages with the
 * recipient and body prefilled. iOS accepts `sms:<addr>&body=<encoded>` and
 * routes to iMessage automatically when available.
 */
export function buildSmsUrl(handle: string, prompt: string): string {
  const addr = handleToAddress(handle);
  return `sms:${addr}&body=${encodeURIComponent(prompt)}`;
}

/**
 * Print a scannable QR code (in the terminal) that opens Messages on the user's
 * iPhone, addressed to their cursy number with a starter prompt prefilled.
 */
export async function printConnectQr(prompt = DEFAULT_PROMPT): Promise<void> {
  const cfg = loadConfigOrDefault();
  const handle = cfg.whitelist[0];
  if (!handle) {
    p.log.warn("No whitelisted handle yet - run `cursy onboard` first.");
    return;
  }
  const url = buildSmsUrl(handle, prompt);
  // IMPORTANT: print the QR RAW to stdout. Wrapping it in a clack note box adds
  // a left border + per-char colors that corrupt the module grid and quiet
  // zone, making it unscannable.
  // `small: true` packs two module-rows into one line (half-block chars), so the
  // code is ~half the height and one char per module wide - compact but still
  // scannable. Low error correction + a short prompt keep the module count down.
  const qr = await QRCode.toString(url, {
    type: "terminal",
    small: true,
    margin: 1,
    errorCorrectionLevel: "L",
  });

  p.log.step(pc.cyan("Scan to connect your phone"));
  // eslint-disable-next-line no-console
  console.log("\n" + qr);
  console.log(
    pc.dim("  Point your iPhone camera at the code above. It opens Messages\n") +
      pc.dim("  to ") +
      pc.white(handleToAddress(handle)) +
      pc.dim(", prefilled with:\n\n") +
      pc.cyan(`    "${prompt}"`) +
      pc.dim("\n\n  cursy will build in: ") +
      pc.white(cfg.defaultWorkspace) +
      pc.dim("\n  (change with `cursy config`)\n"),
  );
}

/** Standalone `cursy qr` command. */
export async function qrCommand(prompt?: string): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" cursy qr ")));
  await printConnectQr(prompt && prompt.trim() ? prompt : undefined);
  p.outro(pc.dim("Tip: pass a custom prompt, e.g. `cursy qr \"what can you do?\"`"));
}
