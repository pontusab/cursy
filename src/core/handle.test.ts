import { describe, expect, test } from "bun:test";
import { handlesMatch, matchWhitelist, normalizeHandle } from "./handle.js";

describe("normalizeHandle", () => {
  test("lowercases emails", () => {
    expect(normalizeHandle("Foo@Bar.COM")).toBe("foo@bar.com");
  });

  test("reduces phone numbers to digits", () => {
    expect(normalizeHandle("+1 (555) 123-4567")).toBe("15551234567");
  });

  test("trims whitespace", () => {
    expect(normalizeHandle("  +46 70 082 1951 ")).toBe("46700821951");
  });
});

describe("handlesMatch", () => {
  test("exact phone match", () => {
    expect(handlesMatch("+15551234567", "15551234567")).toBe(true);
  });

  test("matches across missing country code (last 10 digits)", () => {
    expect(handlesMatch("+1 (555) 123-4567", "5551234567")).toBe(true);
  });

  test("email equality is case-insensitive", () => {
    expect(handlesMatch("Me@Example.com", "me@example.com")).toBe(true);
  });

  test("email never matches a phone", () => {
    expect(handlesMatch("me@example.com", "15551234567")).toBe(false);
  });

  test("different numbers do not match", () => {
    expect(handlesMatch("+15551234567", "+15559999999")).toBe(false);
  });

  test("too-short numbers do not loosely match", () => {
    expect(handlesMatch("12345", "99345")).toBe(false);
  });
});

describe("matchWhitelist", () => {
  const whitelist = ["46700821951", "me@example.com"];

  test("finds a phone by trailing digits", () => {
    expect(matchWhitelist("+46 700 82 19 51", whitelist)).toBe("46700821951");
  });

  test("finds an email", () => {
    expect(matchWhitelist("ME@example.com", whitelist)).toBe("me@example.com");
  });

  test("returns undefined for non-member", () => {
    expect(matchWhitelist("+15550000000", whitelist)).toBeUndefined();
  });
});
