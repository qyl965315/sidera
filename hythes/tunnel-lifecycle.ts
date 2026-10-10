export interface TunnelState {
  state: "closed" | "backoff" | "open" | "authentication_required";
  consecutive429: number;
  nextEstablishmentAt: number;
}

/** Establishment only. This never stores, dispatches or retries an Agent action. */
export class TunnelLifecycle {
  private current: TunnelState;
  private cached?: { until: number; ready: boolean };
  private inFlight?: Promise<boolean>;
  private generation = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(options: { now?: () => number; random?: () => number; state?: TunnelState } = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.current = options.state ?? { state: "closed", consecutive429: 0, nextEstablishmentAt: 0 };
  }
  snapshot(): TunnelState { return { ...this.current }; }
  invalidate(): void { this.cached = undefined; this.generation++; }
  authenticationRequired(): void {
    this.current = { ...this.current, state: "authentication_required" };
    this.invalidate();
  }
  recovered(): void {
    this.current = { state: "closed", consecutive429: 0, nextEstablishmentAt: 0 };
    this.invalidate();
  }
  rateLimited(retryAfter: string | null, nativeRetryMs = 0): TunnelState {
    const at = this.now(), count = this.current.consecutive429 + 1;
    const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
    const until = retryAfter ? Date.parse(retryAfter) : NaN;
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(until) ? Math.max(0, until - at) : 0;
    const exponential = Math.min(60_000, 1000 * 2 ** Math.min(10, count - 1));
    const delay = Math.max(headerDelay, nativeRetryMs, exponential, count >= 3 ? 300_000 : 0) + Math.floor(this.random() * 250);
    this.current = { state: count >= 3 ? "open" : "backoff", consecutive429: count, nextEstablishmentAt: at + delay };
    this.invalidate();
    return this.snapshot();
  }
  async readiness(probe: () => Promise<boolean>): Promise<boolean> {
    if (this.current.state === "authentication_required") return false;
    if (this.now() < this.current.nextEstablishmentAt) return false;
    if (this.cached && this.cached.until > this.now()) return this.cached.ready;
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = (async () => {
      let ready = false;
      try { ready = await probe(); } catch { /* loss invalidates readiness */ }
      // A late probe cannot erase a newer disconnect, 429 or authentication block.
      if (generation !== this.generation) return false;
      if (ready) this.recovered();
      // recovered invalidates the old cache; retain this actual fresh observation.
      this.cached = { ready, until: this.now() + (ready ? 5000 : 1000) };
      return ready;
    })();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
}
