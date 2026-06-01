/**
 * Normalize an iMessage handle (phone number or email) into a canonical form
 * for stable comparison and map keys.
 *
 * - Emails are lowercased.
 * - Phone numbers are reduced to digits; a leading "+" is preserved as part of
 *   E.164. Numbers without a country code are matched on their trailing digits
 *   so "+15551234567", "15551234567" and "(555) 123-4567" all compare equal.
 */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits;
}

/** True if two handles refer to the same person, tolerant of country codes. */
export function handlesMatch(a: string, b: string): boolean {
  const na = normalizeHandle(a);
  const nb = normalizeHandle(b);
  if (na === nb) return true;
  // Email vs phone never match beyond exact equality.
  if (na.includes("@") || nb.includes("@")) return false;
  if (!na || !nb) return false;
  // Compare on the last 10 digits to bridge missing/extra country codes.
  const tailA = na.slice(-10);
  const tailB = nb.slice(-10);
  return tailA.length >= 7 && tailA === tailB;
}

/** Find the whitelisted handle matching `handle`, or undefined. */
export function matchWhitelist(
  handle: string,
  whitelist: string[],
): string | undefined {
  return whitelist.find((w) => handlesMatch(w, handle));
}
