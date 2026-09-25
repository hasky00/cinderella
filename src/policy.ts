/**
 * Cinderella policy engine.
 *
 * Pure logic, no crypto, no network. Given a Nostr event and a config,
 * decide: allow | deny(reason). Rate limits and delay gates are tracked
 * in memory per process (each share node enforces independently).
 */

export interface RateLimit {
  max_events  : number
  per_minutes : number
}

export interface Tier {
  kinds        : number[]
  rate_limit?  : RateLimit
  delay_hours? : number
}

export interface CinderellaConfig {
  version         : number
  default_tier    : 'deny' | string
  require_content : boolean
  tiers           : Record<string, Tier>
}

export interface NostrEvent {
  id         : string
  pubkey     : string
  created_at : number
  kind       : number
  tags       : string[][]
  content    : string
  sig?       : string
}

export type Verdict =
  | { ok : true,  tier : string }
  | { ok : false, tier : string | null, reason : string }

export class Policy {
  private readonly cfg     : CinderellaConfig
  private readonly history = new Map<string, number[]>()   // tier -> timestamps (ms)
  private readonly pending = new Map<string, number>()     // event id -> unlock time (ms)

  constructor (cfg : CinderellaConfig) {
    this.cfg = cfg
  }

  /** Find the tier whose kinds list contains this kind. */
  tier_for (kind : number) : string | null {
    for (const [ name, tier ] of Object.entries(this.cfg.tiers)) {
      if (tier.kinds.includes(kind)) return name
    }
    return null
  }

  /**
   * Evaluate an event. Call this from the bifrost sign middleware.
   * `now` is injectable for tests.
   */
  evaluate (event : NostrEvent, now = Date.now()) : Verdict {
    const name = this.tier_for(event.kind)

    if (name === null) {
      if (this.cfg.default_tier === 'deny') {
        return { ok: false, tier: null, reason: `kind ${event.kind} not in any tier (default deny)` }
      }
      return this.evaluate_tier(this.cfg.default_tier, event, now)
    }

    return this.evaluate_tier(name, event, now)
  }

  private evaluate_tier (name : string, event : NostrEvent, now : number) : Verdict {
    const tier = this.cfg.tiers[name]
    if (!tier) return { ok: false, tier: name, reason: `unknown tier ${name}` }

    // 1. Delay gate (vault behaviour): first sighting queues, later sighting after unlock passes.
    if (tier.delay_hours && tier.delay_hours > 0) {
      const unlock = this.pending.get(event.id)
      if (unlock === undefined) {
        const at = now + tier.delay_hours * 3_600_000
        this.pending.set(event.id, at)
        return {
          ok: false, tier: name,
          reason: `queued: kind ${event.kind} unlocks at ${new Date(at).toISOString()} (sign by requesting the same event again after that)`
        }
      }
      if (now < unlock) {
        return { ok: false, tier: name, reason: `still locked until ${new Date(unlock).toISOString()}` }
      }
    }

    // 2. Rate limit (sliding window).
    if (tier.rate_limit) {
      const { max_events, per_minutes } = tier.rate_limit
      const window = per_minutes * 60_000
      const stamps = (this.history.get(name) ?? []).filter(t => now - t < window)
      if (stamps.length >= max_events) {
        this.history.set(name, stamps)
        return { ok: false, tier: name, reason: `rate limit: ${max_events}/${per_minutes}min exceeded` }
      }
      stamps.push(now)
      this.history.set(name, stamps)
    }

    this.pending.delete(event.id)
    return { ok: true, tier: name }
  }

  /**
   * Veto: clear everything queued. Not wired to anything yet: the veto
   * listener that would call this is still on the roadmap.
   */
  veto_all () : number {
    const n = this.pending.size
    this.pending.clear()
    return n
  }
}
