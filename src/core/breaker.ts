import { log } from "./log.js";

/**
 * Two-tier loop guard for outbound replies, keyed by handle.
 *
 * Texting your own number makes Messages echo cursy's replies back as inbound
 * rows. Several guards (the invisible/robot marker and outbound-echo matching)
 * normally recognize those echoes, but a transport that strips the marker and
 * segments the text (SMS/RCS bridges) can let one slip through - and a slipped
 * echo looks exactly like a fresh human message.
 *
 *  - Soft tier: trips after a few replies in a short window, but `resetSoft`
 *    (called on every genuine inbound) clears it so real users aren't blocked.
 *  - Hard tier: an absolute ceiling that inbound CANNOT reset. Because a
 *    slipped echo would otherwise reset the soft tier on every iteration and
 *    loop forever, the hard tier is what actually guarantees termination: once
 *    exceeded it pauses replies for a fixed, time-based cooldown.
 */
export interface LoopBreakerOptions {
  softMax?: number;
  softWindowMs?: number;
  hardMax?: number;
  hardWindowMs?: number;
  hardCooldownMs?: number;
  now?: () => number;
}

export class LoopBreaker {
  private readonly softMax: number;
  private readonly softWindowMs: number;
  private readonly hardMax: number;
  private readonly hardWindowMs: number;
  private readonly hardCooldownMs: number;
  private readonly now: () => number;

  private replyTimes = new Map<string, number[]>();
  private softTripped = new Set<string>();
  private hardSendTimes = new Map<string, number[]>();
  private hardCooldownUntil = new Map<string, number>();

  constructor(opts: LoopBreakerOptions = {}) {
    this.softMax = opts.softMax ?? 6;
    this.softWindowMs = opts.softWindowMs ?? 30_000;
    this.hardMax = opts.hardMax ?? 16;
    this.hardWindowMs = opts.hardWindowMs ?? 60_000;
    this.hardCooldownMs = opts.hardCooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Record an outbound send and return whether it's allowed to proceed. */
  allow(handle: string | null): boolean {
    if (!handle) return true;
    const now = this.now();

    // Hard tier first: a fixed cooldown a new inbound cannot clear.
    if (now < (this.hardCooldownUntil.get(handle) ?? 0)) return false;
    const hard = (this.hardSendTimes.get(handle) ?? []).filter(
      (t) => now - t < this.hardWindowMs,
    );
    hard.push(now);
    this.hardSendTimes.set(handle, hard);
    if (hard.length > this.hardMax) {
      this.hardCooldownUntil.set(handle, now + this.hardCooldownMs);
      log.error("hard loop backstop tripped; pausing replies", {
        handle,
        window_ms: this.hardWindowMs,
        max: this.hardMax,
        cooldown_ms: this.hardCooldownMs,
      });
      return false;
    }

    // Soft tier: trips sooner, but resettable by a genuine inbound (good UX).
    if (this.softTripped.has(handle)) return false;
    const times = (this.replyTimes.get(handle) ?? []).filter(
      (t) => now - t < this.softWindowMs,
    );
    times.push(now);
    this.replyTimes.set(handle, times);
    if (times.length > this.softMax) {
      this.softTripped.add(handle);
      log.warn("loop circuit breaker tripped; pausing replies", {
        handle,
        window_ms: this.softWindowMs,
        max: this.softMax,
      });
      return false;
    }
    return true;
  }

  /** Clear the soft tier for a handle. The hard tier intentionally persists. */
  resetSoft(handle: string): void {
    this.softTripped.delete(handle);
    this.replyTimes.delete(handle);
  }
}
