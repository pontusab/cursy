import { describe, expect, test } from "bun:test";
import { LoopBreaker } from "./breaker.js";

describe("LoopBreaker", () => {
  test("hard backstop bounds a loop even when soft tier is reset every iteration", () => {
    // Simulate the failure mode: a slipped self-echo looks like fresh inbound,
    // so it resets the soft tier before each reply. Without the hard tier this
    // would allow replies forever; the hard tier must still cap it.
    let t = 0;
    const b = new LoopBreaker({ now: () => t });
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 200; i++) {
      b.resetSoft("h"); // the slipped echo clears the soft breaker
      if (b.allow("h")) allowed++;
      else blocked++;
      t += 1000; // 1s between iterations -> 200s total
    }
    // The hard ceiling (default 16 per 60s, 60s cooldown) means the vast
    // majority of attempts are blocked; nowhere near the 200 attempts pass.
    expect(blocked).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(70);
  });

  test("rapid sends with no inbound trips and stays tripped (true infinite-loop case)", () => {
    let t = 0;
    const b = new LoopBreaker({ now: () => t });
    let allowed = 0;
    for (let i = 0; i < 50; i++) {
      if (b.allow("h")) allowed++;
      t += 100; // 100ms apart, all inside both windows
    }
    // Soft tier (6) trips first; never reset, so only the first handful pass.
    expect(allowed).toBeLessThanOrEqual(7);
  });

  test("resetSoft lets a genuine user continue after a soft trip", () => {
    let t = 0;
    const b = new LoopBreaker({ now: () => t, softMax: 3, hardMax: 1000 });
    expect(b.allow("h")).toBe(true);
    expect(b.allow("h")).toBe(true);
    expect(b.allow("h")).toBe(true);
    expect(b.allow("h")).toBe(false); // soft tripped on the 4th
    b.resetSoft("h"); // a real inbound message arrives
    expect(b.allow("h")).toBe(true);
  });

  test("hard cooldown clears after the window elapses", () => {
    let t = 0;
    const b = new LoopBreaker({
      now: () => t,
      softMax: 1000,
      hardMax: 3,
      hardWindowMs: 10_000,
      hardCooldownMs: 30_000,
    });
    for (let i = 0; i < 4; i++) {
      b.allow("h");
      t += 100;
    }
    expect(b.allow("h")).toBe(false); // in cooldown
    t += 30_000; // wait out the cooldown
    expect(b.allow("h")).toBe(true);
  });

  test("a null handle is always allowed", () => {
    const b = new LoopBreaker();
    for (let i = 0; i < 100; i++) expect(b.allow(null)).toBe(true);
  });
});
