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

/** Everything a node must remember across restarts (see state.ts). */
export interface PolicyState {
  version : 1
  history : Record<string, number[]>   // tier -> timestamps (ms)
  pending : Record<string, number>     // event id -> unlock time (ms)
}

export interface PolicyOptions {
  /** State saved by a previous run, so restarts don't reset limits or held events. */
  state?     : PolicyState
  /** Called after every decision that changed the state, with the state to save. */
  on_change? : (state : PolicyState) => void
}

/** Held events are forgotten this long after they unlocked without being re-requested. */
const PENDING_RETENTION_MS = 7 * 24 * 3_600_000

export class Policy {
  private readonly cfg       : CinderellaConfig
  private readonly history   = new Map<string, number[]>()   // tier -> timestamps (ms)
  private readonly pending   = new Map<string, number>()     // event id -> unlock time (ms)
  private readonly on_change : ((state : PolicyState) => void) | undefined

  constructor (cfg : CinderellaConfig, options : PolicyOptions = {}) {
    this.cfg       = cfg
    this.on_change = options.on_change
    if (options.state) this.load(options.state)
  }

  /** The state to persist, without entries that can no longer matter. */
  export_state (now = Date.now()) : PolicyState {
    const history : Record<string, number[]> = {}
    for (const [ name, stamps ] of this.history) {
      const limit = this.cfg.tiers[name]?.rate_limit
      if (!limit) continue
      const window = limit.per_minutes * 60_000
      const live   = stamps.filter(t => now - t < window)
      if (live.length) history[name] = live
    }
    const pending : Record<string, number> = {}
    for (const [ id, unlock ] of this.pending) {
      if (now - unlock < PENDING_RETENTION_MS) pending[id] = unlock
    }
    return { version: 1, history, pending }
  }

  private load (state : PolicyState) : void {
    if (state.version !== 1) throw new Error(`policy state: unsupported version ${String(state.version)}`)
    for (const [ name, stamps ] of Object.entries(state.history ?? {})) {
      if (Array.isArray(stamps)) this.history.set(name, stamps.filter(t => typeof t === 'number'))
    }
    for (const [ id, unlock ] of Object.entries(state.pending ?? {})) {
      if (typeof unlock === 'number') this.pending.set(id, unlock)
    }
  }

  private changed (now : number) : void {
    this.on_change?.(this.export_state(now))
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
        this.changed(now)
        return {
          ok: false, tier: name,
          reason: `queued: kind ${event.kind} unlocks at ${new Date(at).toISOString()} (veto by posting a kind 1)`
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
    this.changed(now)
    return { ok: true, tier: name }
  }

  /** Veto: a kind 1 from a hot signer cancels everything queued. */
  veto_all () : number {
    const n = this.pending.size
    this.pending.clear()
    if (n) this.changed(Date.now())
    return n
  }
}
