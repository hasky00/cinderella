/**
 * Veto listener: cancel a held (delay-gated) event from your phone.
 *
 *  - When this node holds an event it sends an alert (alerts.ts) to the veto
 *    key, a separate npub kept on your phone, never a FROSTR share. The
 *    event's delay starts only once the alert reached a relay (fail-closed);
 *    undelivered alerts are retried.
 *  - You reply `veto <exact 64-hex event id>`. Only messages signed by the veto
 *    key count, verified through the seal: nostr-tools' unwrapEvent does not
 *    check that the seal signer is the sender, so we unwrap ourselves.
 *  - A veto is refused for unknown or already-signed ids, and when it was
 *    written before the event was held, so old messages can't be replayed.
 *  - Alerts are a NIP-17 group DM with the veto key and every other node's
 *    alert key (veto.peer_alert_pubkeys), so one veto reply in that group
 *    reaches every Cinderella node. Alerts also go to the veto key's own
 *    DM inbox relays (kind 10050).
 *  - The node counts as caught up on vetoes only while at least one relay is
 *    connected and has sent a real EOSE (relay-feed.ts). Until then, and
 *    whenever all relays drop, unlocked held events are refused.
 *  - When the veto key is set for the first time or changed (phone lost:
 *    edit veto.pubkey, restart), every held event's delay restarts from the
 *    delivery of a new alert to that key.
 */

import { getEventHash, getPublicKey, nip44, verifyEvent } from 'nostr-tools'
import type { Event as NostrToolsEvent } from 'nostr-tools'
import type { HeldEntry, Policy, PolicyOptions, VetoConfig, VetoResult } from './policy.js'
import { AlertChannel, alert_text, to_hex_pubkey, type AlertKey } from './alerts.js'
import { RelayFeed } from './relay-feed.js'

export type VetoLog = (level : 'info' | 'deny' | 'allow', msg : string) => void

export interface ResolvedVetoConfig {
  veto_pubkey        : string
  alert_relays       : string[]
  gateway_pubkey     : string | null
  peer_alert_pubkeys : string[]
  node_count         : number
}

/** Validate the `veto` section of cinderella.config.json. Throws with a clear message. */
export function resolve_veto_config (cfg : VetoConfig) : ResolvedVetoConfig {
  if (!cfg || typeof cfg !== 'object') throw new Error('cinderella: veto config missing')
  const relays = Array.from(new Set((cfg.alert_relays ?? []).map(r => String(r).trim()).filter(Boolean)))
  const bad = relays.filter(r => !/^wss?:\/\/[^\s]+$/.test(r))
  if (bad.length) throw new Error(`cinderella: veto.alert_relays must be ws:// or wss:// URLs (got ${bad.join(', ')})`)
  if (relays.length < 2) {
    throw new Error('cinderella: veto.alert_relays needs at least 2 relays (e.g. your own and a public one), so one blocked relay cannot hide an alert')
  }
  const peers = Array.from(new Set((cfg.peer_alert_pubkeys ?? []).map(pk => to_hex_pubkey(pk, 'veto.peer_alert_pubkeys'))))
  // Required, never derived from the peer list: a forgotten peer must stop the node, not shrink the count.
  const node_count = cfg.node_count
  if (node_count === undefined || node_count === null) throw new Error('cinderella: veto.node_count is required: how many Cinderella share nodes you run (1 or more)')
  if (!Number.isInteger(node_count) || node_count < 1) throw new Error('cinderella: veto.node_count must be a whole number of Cinderella share nodes (1 or more)')
  if (peers.length !== node_count - 1) {
    throw new Error(`cinderella: veto.node_count is ${node_count}, so veto.peer_alert_pubkeys needs the alert npubs of the other ${node_count - 1} node(s) (got ${peers.length}); otherwise one veto reply would not reach every node`)
  }
  return {
    node_count,
    veto_pubkey    : to_hex_pubkey(cfg.pubkey ?? '', 'veto.pubkey'),
    alert_relays   : relays,
    gateway_pubkey : cfg.gateway_pubkey ? to_hex_pubkey(cfg.gateway_pubkey, 'veto.gateway_pubkey') : null,
    peer_alert_pubkeys : peers
  }
}

/** A relay can send anything: only a well-formed Nostr event goes on to handle(). */
export function is_event_shape (ev : unknown) : ev is NostrToolsEvent {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false
  const e = ev as Record<string, unknown>
  return typeof e.id === 'string' && /^[0-9a-f]{64}$/.test(e.id)
    && typeof e.pubkey === 'string' && /^[0-9a-f]{64}$/.test(e.pubkey)
    && typeof e.sig === 'string' && /^[0-9a-f]{128}$/.test(e.sig)
    && Number.isInteger(e.kind) && Number.isInteger(e.created_at)
    && Array.isArray(e.tags) && typeof e.content === 'string'
}

/**
 * The node runs without veto: forget the veto key, so turning veto on again
 * (even with the same key) re-alerts every held event and restarts its delay.
 */
export function mark_veto_disabled (policy : Policy) : void {
  if (policy.get_meta<string | null>('veto_pubkey')) policy.set_meta('veto_pubkey', null)
}

/** `veto <64-hex id>`, nothing else. */
export function parse_veto_command (text : string) : string | null {
  const m = text.trim().toLowerCase().match(/^veto\s+([0-9a-f]{64})$/)
  return m ? m[1]! : null
}

export interface Unwrapped {
  sender     : string   // hex pubkey that signed the seal (= rumor author)
  content    : string
  created_at : number   // seconds, when the message was written
}

/**
 * Open a NIP-17 gift wrap addressed to us and verify who sent it: the seal
 * must be a valid signed kind 13, and the message's author must be the seal's
 * signer. Returns null for anything else.
 */
export function unwrap_verified (wrap : NostrToolsEvent, sk : Uint8Array) : Unwrapped | null {
  try {
    if (wrap.kind !== 1059 || !verifyEvent(wrap)) return null
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey))) as NostrToolsEvent
    if (seal.kind !== 13 || !verifyEvent(seal)) return null
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey))) as {
      id : string, pubkey : string, kind : number, created_at : number, tags : string[][], content : string
    }
    if (rumor.pubkey !== seal.pubkey) return null
    if (rumor.kind !== 14 || typeof rumor.content !== 'string' || typeof rumor.created_at !== 'number') return null
    if (getEventHash({ ...rumor, sig: '' } as unknown as Parameters<typeof getEventHash>[0]) !== rumor.id) return null
    return { sender: seal.pubkey, content: rumor.content, created_at: rumor.created_at }
  } catch {
    return null
  }
}

const REPLIES : Record<VetoResult, (id : string) => string> = {
  vetoed          : id => `vetoed ${id}: it will not be signed.`,
  already_vetoed  : id => `ignored ${id}: already vetoed.`,
  unknown         : id => `ignored ${id}: not held by this node (unknown id).`,
  already_signed  : id => `ignored ${id}: already signed after its delay.`,
  older_than_hold : id => `ignored ${id}: this message was written before the event was held.`,
}

// NIP-59 gift wraps carry a random timestamp up to 2 days in the past.
const WRAP_JITTER_S       = 2 * 24 * 3600
const SEEN_RETENTION_MS   = 3 * 24 * 3_600_000
const RETRY_INTERVAL_MS   = 60_000

export interface VetoControllerOptions {
  config      : ResolvedVetoConfig
  key         : AlertKey
  log?        : VetoLog
  retry_ms?   : number
  /** Reconnect backoff for the veto feed (tests use short values). */
  backoff_ms? : { min : number, max : number }
  /** No traffic from a relay for this long = dead connection (default 60 s). */
  idle_ms?    : number
}

export class VetoController {
  readonly channel  : AlertChannel
  private policy    : Policy | null = null
  private feed      : RelayFeed | null = null
  private timer     : ReturnType<typeof setInterval> | null = null
  private readonly log : VetoLog

  constructor (private readonly opts : VetoControllerOptions) {
    this.channel = new AlertChannel(opts.key, opts.config.alert_relays)
    this.log     = opts.log ?? (() => {})
  }

  get alert_pubkey () : string { return getPublicKey(this.opts.key.sk) }

  /** Caught up: EVERY alert relay connected and past a real EOSE since its last reconnect. */
  get ready () : boolean { return this.feed?.all_caught_up ?? false }

  /** The group every alert and reply goes to: the veto key plus the other nodes. */
  private get members () : string[] {
    return [ this.opts.config.veto_pubkey, ...this.opts.config.peer_alert_pubkeys ]
  }

  /** Options to pass to `new Policy(...)`. */
  policy_options () : Pick<PolicyOptions, 'alerts_required' | 'on_hold' | 'ready'> {
    return {
      alerts_required : true,
      on_hold         : (id, entry) => { void this.alert(id, entry) },
      ready           : () => this.ready,
    }
  }

  /**
   * Send the alert for one held event. Its delay starts only when one of the
   * veto key's own DM inbox relays (its kind 10050) accepted it: that is
   * where the phone listens. No inbox list = not delivered, retried.
   */
  async alert (id : string, entry : HeldEntry) : Promise<boolean> {
    const veto    = this.opts.config.veto_pubkey
    const results = await this.channel.send_group(this.members, alert_text(id, entry))
    const inbox   = await this.channel.inbox_relays(veto)
    const to_veto = results.get(veto)
    const hit     = (to_veto?.accepted ?? []).filter(r => inbox.includes(r))
    if (!inbox.length) {
      this.log('deny', `veto alert for ${id.slice(0, 8)} not delivered: the veto key has no DM inbox list (kind 10050); publish one from your phone app. Retrying`)
      return false
    }
    if (!hit.length) {
      const why = to_veto ? Object.entries(to_veto.failed).map(([ r, e ]) => `${r}: ${e}`).join('; ') : 'not sent'
      this.log('deny', `veto alert for ${id.slice(0, 8)} not accepted by any of the veto key's inbox relays (${inbox.join(', ')}; ${why}); retrying`)
      return false
    }
    if (this.policy?.alert_delivered(id)) {
      this.log('info', `veto alert for ${id.slice(0, 8)} delivered to the veto key's inbox (${hit.join(', ')}); delay started`)
    }
    return true
  }

  private say (text : string) : void {
    void this.channel.send_group(this.members, `Cinderella: ${text}`)
  }

  /** Start: inbox list, key check, live veto feed, retry loop. */
  async start (policy : Policy) : Promise<void> {
    this.policy = policy
    const { veto_pubkey } = this.opts.config

    void this.channel.publish_inbox()

    // Veto key set for the first time or changed: every held event restarts its
    // delay from a new alert to this key (the key never saw them before).
    const previous = policy.get_meta<string>('veto_pubkey')
    if (previous !== veto_pubkey) {
      const n = policy.restart_delays()
      policy.set_meta('veto_pubkey', veto_pubkey)
      this.log('info', previous
        ? `veto key changed: restarting the delay of ${n} held event(s) from new alerts`
        : `veto enabled: restarting the delay of ${n} held event(s) from new alerts`)
      this.say(previous
        ? 'this npub is now the veto key for this node. Held events follow; their delays restart.'
        : 'veto alerts are now on for this node. Held events follow; their delays restart.')
    }

    // Live veto feed, with a catch-up point per relay: each relay's `since` follows what
    // THAT relay was seen to deliver, minus the gift-wrap jitter.
    const seen_until = () : Record<string, number> => {
      const v = policy.get_meta<number | Record<string, number>>('veto_seen_until')
      if (typeof v === 'number') return Object.fromEntries(this.opts.config.alert_relays.map(r => [ r, v ]))   // older single point
      return v && typeof v === 'object' ? { ...v } : {}
    }
    const advance = (relays : string[]) => {
      if (!relays.length) return
      const now = Date.now(), next = seen_until()
      for (const r of relays) next[r] = now
      policy.set_meta('veto_seen_until', next, now)
    }
    this.feed = new RelayFeed(this.opts.config.alert_relays, {
      filter : (relay) => {
        const seen = seen_until()
        const from = seen[relay] ?? (Object.values(seen).length ? Math.min(...Object.values(seen)) : Date.now())
        return { kinds: [ 1059 ], '#p': [ this.alert_pubkey ], since: Math.floor(from / 1000) - WRAP_JITTER_S - 60 }
      },
      onevent : (ev, relay) => {
        if (!is_event_shape(ev)) { this.log('deny', `veto feed: ignored a malformed event from ${relay}`); return }
        this.handle(ev).catch(err => this.log('deny', `veto feed: error handling an event from ${relay}: ${err instanceof Error ? err.message : String(err)}`))
      },
      oncaughtup : (relay) => advance([ relay ]),
      onstate : (all) => {
        if (all) this.log('info', 'veto feed caught up on every alert relay')
        else this.log('deny', `veto feed: not every alert relay is live and caught up (${this.feed?.caught_up_relays.join(', ') || 'none'}); refusing unlocked held events`)
      },
      min_backoff_ms : this.opts.backoff_ms?.min,
      max_backoff_ms : this.opts.backoff_ms?.max,
      idle_ms        : this.opts.idle_ms,
    })
    this.feed.start()

    // Retry undelivered alerts; advance each relay's catch-up point only while it is live.
    this.timer = setInterval(() => {
      for (const [ id, entry ] of policy.held()) if (entry.unlock === null) void this.alert(id, entry)
      advance(this.feed?.caught_up_relays ?? [])
    }, this.opts.retry_ms ?? RETRY_INTERVAL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()

    // Alerts not yet delivered (new, restarted, or from before a restart).
    for (const [ id, entry ] of policy.held()) if (entry.unlock === null) void this.alert(id, entry)
  }

  /** One incoming gift wrap. Recorded as handled only once verified and from the veto key. */
  async handle (wrap : NostrToolsEvent) : Promise<void> {
    const policy = this.policy
    if (!policy) return
    const seen = policy.get_meta<Record<string, number>>('veto_seen_wraps') ?? {}
    if (seen[wrap.id]) return

    const msg = unwrap_verified(wrap, this.opts.key.sk)
    if (!msg) { this.log('deny', 'veto feed: ignored a message that failed verification'); return }
    if (this.opts.config.peer_alert_pubkeys.includes(msg.sender)) return     // another node's alert or reply
    if (msg.sender !== this.opts.config.veto_pubkey) {
      this.log('deny', `veto feed: ignored a message from ${msg.sender.slice(0, 8)} (not the veto key)`)
      return
    }

    const now  = Date.now()
    const next = { ...seen }
    for (const [ id, at ] of Object.entries(next)) if (now - at > SEEN_RETENTION_MS) delete next[id]
    next[wrap.id] = now
    policy.set_meta('veto_seen_wraps', next, now)

    const id = parse_veto_command(msg.content)
    if (!id) {
      this.say('to cancel a held event, reply exactly "veto <64-character event id>" as given in its alert.')
      return
    }

    const result = policy.veto(id, msg.created_at * 1000, now)
    this.log(result === 'vetoed' ? 'deny' : 'info', `veto ${id.slice(0, 8)}: ${result}`)
    this.say(REPLIES[result](id))
    if (result === 'vetoed' && this.opts.config.gateway_pubkey) {
      void this.channel.send_dm(this.opts.config.gateway_pubkey, JSON.stringify({ type: 'cinderella-veto', id, status: 'vetoed' }))
    }
  }

  stop () : void {
    if (this.timer) clearInterval(this.timer)
    this.feed?.stop()
    this.channel.close()
  }
}
