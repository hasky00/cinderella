/**
 * Cinderella policy engine.
 *
 * Pure logic, no crypto, no network. Given a Nostr event and a config,
 * decide: allow | deny(reason). Rate limits, held (delay-gated) events and
 * vetoes are kept per node (each share node enforces independently) and can
 * be persisted across restarts (see state.ts).
 *
 * Veto (see veto.ts, alerts.ts): when alerts are required, a held event's
 * delay only starts once its alert reached at least one relay (fail-closed),
 * and a vetoed event is refused for good, even after its unlock.
 */

import { summarize_event } from './summary.js'
import type { RefusalCode } from './refusal.js'

export interface RateLimit {
  max_events  : number
  per_minutes : number
}

export interface Tier {
  kinds        : number[]
  rate_limit?  : RateLimit
  delay_hours? : number
}

export interface VetoConfig {
  /** npub or hex pubkey of the veto key (kept on your phone, never a FROSTR share). */
  pubkey          : string
  /** At least 2 relays for alerts and vetoes, e.g. your own plus a public one. */
  alert_relays    : string[]
  /** The Gateway's notice key (npub or hex), told when an event is vetoed. Optional. */
  gateway_pubkey? : string
  /**
   * The alert keys of the OTHER Cinderella nodes. Alerts become a group DM
   * with the veto key and all nodes, so one veto reply reaches every node.
   */
  peer_alert_pubkeys? : string[]
  /** How many Cinderella share nodes there are. Required, so a missing peer can't go unnoticed; with more than 1, peer_alert_pubkeys must list the others. */
  node_count : number
}

export interface CinderellaConfig {
  version         : number
  default_tier    : 'deny' | string
  require_content : boolean
  tiers           : Record<string, Tier>
  veto?           : VetoConfig
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
  | {
      ok : false, tier : string | null, reason : string,
      /** What kind of refusal, for the requester (see refusal.ts). */
      code : RefusalCode,
      /** ms; when this held event unlocks here, if known. */
      unlock_at? : number | null,
      /** ms; when a rate-limited request may pass. */
      retry_at? : number | null
    }

/** A delay-gated event this node is holding. */
export interface HeldEntry {
  held_at     : number          // ms, first time this node saw it
  unlock      : number | null   // ms; null until its alert was delivered (when alerts are required)
  kind        : number
  delay_hours : number
  summary     : string
}

/** Everything a node must remember across restarts (see state.ts). */
export interface PolicyState {
  version : 2
  history : Record<string, number[]>    // tier -> timestamps (ms)
  pending : Record<string, HeldEntry>   // event id -> held entry
  vetoed  : Record<string, number>      // event id -> vetoed at (ms)
  signed  : Record<string, number>      // held event id -> signed at (ms)
  meta    : Record<string, unknown>     // veto listener bookkeeping (veto.ts)
}

/** Version 1 (before vetoes): pending was event id -> unlock time. */
interface PolicyStateV1 {
  version : 1
  history : Record<string, number[]>
  pending : Record<string, number>
}

export type VetoResult = 'vetoed' | 'already_vetoed' | 'unknown' | 'already_signed' | 'older_than_hold'

export interface PolicyOptions {
  /** State saved by a previous run, so restarts don't reset limits or held events. */
  state?           : PolicyState | PolicyStateV1
  /** Called after every decision that changed the state, with the state to save. */
  on_change?       : (state : PolicyState) => void
  /**
   * Veto mode: a held event's delay starts only once its alert was delivered
   * (alert_delivered()), and on_hold is called so the alert can be sent.
   */
  alerts_required? : boolean
  on_hold?         : (id : string, entry : HeldEntry) => void
  /** Veto mode: false until the veto feed caught up; unlocked held events are refused meanwhile. */
  ready?           : () => boolean
}

/** Held events are forgotten this long after they unlocked (or were held, if never unlocked). */
const PENDING_RETENTION_MS = 7 * 24 * 3_600_000
/** Vetoed and signed ids are remembered this long (so a veto for a signed event is refused). */
const DECISION_RETENTION_MS = 30 * 24 * 3_600_000
/** Clock skew allowed between the phone and the node when checking "written before the hold". */
const VETO_SKEW_MS = 60_000

export class Policy {
  private readonly cfg       : CinderellaConfig
  private readonly history   = new Map<string, number[]>()     // tier -> timestamps (ms)
  private readonly pending   = new Map<string, HeldEntry>()    // event id -> held entry
  private readonly vetoed    = new Map<string, number>()       // event id -> vetoed at (ms)
  private readonly signed    = new Map<string, number>()       // held event id -> signed at (ms)
  private meta               : Record<string, unknown> = {}
  private readonly opts      : PolicyOptions

  constructor (cfg : CinderellaConfig, options : PolicyOptions = {}) {
    this.cfg  = cfg
    this.opts = options
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
    const pending : Record<string, HeldEntry> = {}
    for (const [ id, entry ] of this.pending) {
      if (now - (entry.unlock ?? entry.held_at) < PENDING_RETENTION_MS) pending[id] = entry
    }
    const keep = (m : Map<string, number>) =>
      Object.fromEntries([ ...m ].filter(([ , at ]) => now - at < DECISION_RETENTION_MS))
    return { version: 2, history, pending, vetoed: keep(this.vetoed), signed: keep(this.signed), meta: this.meta }
  }

  private load (state : PolicyState | PolicyStateV1) : void {
    if (state.version !== 1 && state.version !== 2) {
      throw new Error(`policy state: unsupported version ${String((state as { version : unknown }).version)}`)
    }
    for (const [ name, stamps ] of Object.entries(state.history ?? {})) {
      if (Array.isArray(stamps)) this.history.set(name, stamps.filter(t => typeof t === 'number'))
    }
    if (state.version === 1) {
      // Held before vetoes existed: unlock known, kind and summary not.
      for (const [ id, unlock ] of Object.entries(state.pending ?? {})) {
        if (typeof unlock === 'number') {
          this.pending.set(id, { held_at: 0, unlock, kind: -1, delay_hours: 0, summary: '(held before vetoes existed)' })
        }
      }
      return
    }
    for (const [ id, entry ] of Object.entries(state.pending ?? {})) {
      if (entry && typeof entry.held_at === 'number') this.pending.set(id, entry)
    }
    for (const [ id, at ] of Object.entries(state.vetoed ?? {})) if (typeof at === 'number') this.vetoed.set(id, at)
    for (const [ id, at ] of Object.entries(state.signed ?? {})) if (typeof at === 'number') this.signed.set(id, at)
    this.meta = state.meta && typeof state.meta === 'object' ? { ...state.meta } : {}
  }

  private changed (now : number) : void {
    this.opts.on_change?.(this.export_state(now))
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
    if (this.vetoed.has(event.id)) {
      return { ok: false, tier: this.tier_for(event.kind), code: 'vetoed', reason: `vetoed: ${event.id.slice(0, 8)} was vetoed from the veto key` }
    }

    const name = this.tier_for(event.kind)

    if (name === null) {
      if (this.cfg.default_tier === 'deny') {
        return { ok: false, tier: null, code: 'denied', reason: `kind ${event.kind} not in any tier (default deny)` }
      }
      return this.evaluate_tier(this.cfg.default_tier, event, now)
    }

    return this.evaluate_tier(name, event, now)
  }

  private evaluate_tier (name : string, event : NostrEvent, now : number) : Verdict {
    const tier = this.cfg.tiers[name]
    if (!tier) return { ok: false, tier: name, code: 'denied', reason: `unknown tier ${name}` }

    // 1. Delay gate (vault behaviour): first sighting holds, a later sighting after unlock passes.
    const delayed = !!(tier.delay_hours && tier.delay_hours > 0)
    if (delayed) {
      const entry = this.pending.get(event.id)
      if (entry === undefined) {
        const held : HeldEntry = {
          held_at     : now,
          unlock      : this.opts.alerts_required ? null : now + tier.delay_hours! * 3_600_000,
          kind        : event.kind,
          delay_hours : tier.delay_hours!,
          summary     : summarize_event(event)
        }
        this.pending.set(event.id, held)
        this.changed(now)
        this.opts.on_hold?.(event.id, held)
        return {
          ok: false, tier: name, code: 'held', unlock_at: held.unlock,
          reason: held.unlock === null
            ? `queued: kind ${event.kind} held; its ${tier.delay_hours}h delay starts when the veto alert is delivered`
            : `queued: kind ${event.kind} unlocks at ${new Date(held.unlock).toISOString()}`
        }
      }
      if (entry.unlock === null) {
        return { ok: false, tier: name, code: 'held', unlock_at: null, reason: 'held: veto alert not delivered yet, so the delay has not started' }
      }
      if (now < entry.unlock) {
        return { ok: false, tier: name, code: 'locked', unlock_at: entry.unlock, reason: `still locked until ${new Date(entry.unlock).toISOString()}` }
      }
      if (this.opts.ready && !this.opts.ready()) {
        return { ok: false, tier: name, code: 'catching_up', reason: 'held: catching up on vetoes first' }
      }
    }

    // 2. Rate limit (sliding window).
    if (tier.rate_limit) {
      const { max_events, per_minutes } = tier.rate_limit
      const window = per_minutes * 60_000
      const stamps = (this.history.get(name) ?? []).filter(t => now - t < window)
      if (stamps.length >= max_events) {
        this.history.set(name, stamps)
        return { ok: false, tier: name, code: 'rate_limited', retry_at: stamps[0]! + window, reason: `rate limit: ${max_events}/${per_minutes}min exceeded` }
      }
      stamps.push(now)
      this.history.set(name, stamps)
    }

    if (delayed) {
      this.pending.delete(event.id)
      this.signed.set(event.id, now)
    }
    this.changed(now)
    return { ok: true, tier: name }
  }

  /**
   * Veto mode: (re)start the delay of every held event from its next alert's
   * delivery. Used when the veto key is set for the first time or changed:
   * events held before then were never seen by the (new) veto key. Entries
   * that don't know their delay (from version 1 state) get the longest one.
   */
  restart_delays (now = Date.now()) : number {
    const longest = Math.max(0, ...Object.values(this.cfg.tiers).map(t => t.delay_hours ?? 0))
    for (const entry of this.pending.values()) {
      if (!(entry.delay_hours > 0)) entry.delay_hours = longest
      entry.unlock = null
    }
    if (this.pending.size) this.changed(now)
    return this.pending.size
  }

  /** Veto mode: the alert for a held event reached a relay, so its delay starts now. */
  alert_delivered (id : string, at = Date.now()) : boolean {
    const entry = this.pending.get(id)
    if (!entry || entry.unlock !== null) return false
    entry.unlock = at + entry.delay_hours * 3_600_000
    this.changed(at)
    return true
  }

  /**
   * Veto a held event by its exact id. `written_at` is when the veto message
   * was written (ms); a veto written before the event was held is refused, so
   * an old message can't cancel a later identical event.
   */
  veto (id : string, written_at : number, now = Date.now()) : VetoResult {
    if (this.vetoed.has(id))  return 'already_vetoed'
    if (this.signed.has(id))  return 'already_signed'
    const entry = this.pending.get(id)
    if (!entry)               return 'unknown'
    if (written_at < entry.held_at - VETO_SKEW_MS) return 'older_than_hold'
    this.pending.delete(id)
    this.vetoed.set(id, now)
    this.changed(now)
    return 'vetoed'
  }

  /** Held events, e.g. to re-send alerts. */
  held () : [ string, HeldEntry ][] {
    return [ ...this.pending ]
  }

  /** Bookkeeping for the veto listener, persisted with the policy state. */
  get_meta<T> (key : string) : T | undefined {
    return this.meta[key] as T | undefined
  }

  set_meta (key : string, value : unknown, now = Date.now()) : void {
    this.meta = { ...this.meta, [key]: value }
    this.changed(now)
  }
}
