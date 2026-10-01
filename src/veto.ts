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
 *  - On startup the node catches up on vetoes it missed while offline and
 *    refuses unlocked held events until it has.
 *  - If the veto key changes (phone lost: edit veto.pubkey, restart), every
 *    held event is alerted again to the new key.
 */

import { getEventHash, getPublicKey, nip44, verifyEvent } from 'nostr-tools'
import type { Event as NostrToolsEvent, Filter } from 'nostr-tools'
import type { HeldEntry, Policy, PolicyOptions, VetoConfig, VetoResult } from './policy.js'
import { AlertChannel, alert_text, to_hex_pubkey, type AlertKey } from './alerts.js'

export type VetoLog = (level : 'info' | 'deny' | 'allow', msg : string) => void

export interface ResolvedVetoConfig {
  veto_pubkey    : string
  alert_relays   : string[]
  gateway_pubkey : string | null
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
  return {
    veto_pubkey    : to_hex_pubkey(cfg.pubkey ?? '', 'veto.pubkey'),
    alert_relays   : relays,
    gateway_pubkey : cfg.gateway_pubkey ? to_hex_pubkey(cfg.gateway_pubkey, 'veto.gateway_pubkey') : null
  }
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
const EOSE_MAX_WAIT_MS    = 10_000

export interface VetoControllerOptions {
  config     : ResolvedVetoConfig
  key        : AlertKey
  log?       : VetoLog
  retry_ms?  : number
}

export class VetoController {
  readonly channel  : AlertChannel
  private policy    : Policy | null = null
  private caught_up = false
  private timer     : ReturnType<typeof setInterval> | null = null
  private sub       : { close : () => void } | null = null
  private readonly log : VetoLog

  constructor (private readonly opts : VetoControllerOptions) {
    this.channel = new AlertChannel(opts.key, opts.config.alert_relays)
    this.log     = opts.log ?? (() => {})
  }

  get alert_pubkey () : string { return getPublicKey(this.opts.key.sk) }
  get ready () : boolean { return this.caught_up }

  /** Options to pass to `new Policy(...)`. */
  policy_options () : Pick<PolicyOptions, 'alerts_required' | 'on_hold' | 'ready'> {
    return {
      alerts_required : true,
      on_hold         : (id, entry) => { void this.alert(id, entry) },
      ready           : () => this.caught_up,
    }
  }

  /** Send the alert for one held event; on delivery its delay starts. */
  async alert (id : string, entry : HeldEntry) : Promise<boolean> {
    const res = await this.channel.send_dm(this.opts.config.veto_pubkey, alert_text(id, entry))
    if (res.accepted.length === 0) {
      this.log('deny', `veto alert for ${id.slice(0, 8)} not delivered (${Object.entries(res.failed).map(([r, e]) => `${r}: ${e}`).join('; ')}); retrying`)
      return false
    }
    if (this.policy?.alert_delivered(id)) {
      this.log('info', `veto alert for ${id.slice(0, 8)} delivered to ${res.accepted.join(', ')}; delay started`)
    }
    return true
  }

  /** Start: inbox list, key-change check, catch-up subscription, retry loop. */
  async start (policy : Policy) : Promise<void> {
    this.policy = policy
    const { veto_pubkey } = this.opts.config

    void this.channel.publish_inbox()

    // Veto key changed (or first start): alert every held event to the current key.
    const previous = policy.get_meta<string>('veto_pubkey')
    if (previous !== veto_pubkey) {
      if (previous) {
        this.log('info', 'veto key changed: alerting all held events to the new key')
        void this.channel.send_dm(veto_pubkey, 'Cinderella: this npub is now the veto key for this node. Held events follow.')
        for (const [ id, entry ] of policy.held()) void this.alert(id, entry)
      }
      policy.set_meta('veto_pubkey', veto_pubkey)
    }

    // Catch up from the last time we were listening (minus the gift-wrap jitter).
    const seen_until = policy.get_meta<number>('veto_seen_until') ?? Date.now()
    const since = Math.floor(seen_until / 1000) - WRAP_JITTER_S - 60
    this.sub = this.channel.pool.subscribeMany(
      this.opts.config.alert_relays,
      { kinds: [ 1059 ], '#p': [ this.alert_pubkey ], since } as Filter,
      {
        maxWait : EOSE_MAX_WAIT_MS,
        onevent : (ev : NostrToolsEvent) => { void this.handle(ev) },
        oneose  : () => {
          if (!this.caught_up) {
            this.caught_up = true
            this.log('info', 'veto feed caught up')
          }
          policy.set_meta('veto_seen_until', Date.now())
        }
      }
    )

    // Retry undelivered alerts; keep the catch-up point fresh.
    this.timer = setInterval(() => {
      for (const [ id, entry ] of policy.held()) if (entry.unlock === null) void this.alert(id, entry)
      if (this.caught_up) policy.set_meta('veto_seen_until', Date.now())
    }, this.opts.retry_ms ?? RETRY_INTERVAL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()

    // Alerts that were never delivered before a restart.
    for (const [ id, entry ] of policy.held()) if (entry.unlock === null) void this.alert(id, entry)
  }

  /** One incoming gift wrap. */
  async handle (wrap : NostrToolsEvent) : Promise<void> {
    const policy = this.policy
    if (!policy) return
    const now  = Date.now()
    const seen = { ...(policy.get_meta<Record<string, number>>('veto_seen_wraps') ?? {}) }
    if (seen[wrap.id]) return
    for (const [ id, at ] of Object.entries(seen)) if (now - at > SEEN_RETENTION_MS) delete seen[id]
    seen[wrap.id] = now
    policy.set_meta('veto_seen_wraps', seen, now)

    const msg = unwrap_verified(wrap, this.opts.key.sk)
    if (!msg) { this.log('deny', 'veto feed: ignored a message that failed verification'); return }
    if (msg.sender !== this.opts.config.veto_pubkey) {
      this.log('deny', `veto feed: ignored a message from ${msg.sender.slice(0, 8)} (not the veto key)`)
      return
    }

    const id = parse_veto_command(msg.content)
    if (!id) {
      void this.channel.send_dm(this.opts.config.veto_pubkey, 'Cinderella: to cancel a held event, reply exactly "veto <64-character event id>" as given in its alert.')
      return
    }

    const result = policy.veto(id, msg.created_at * 1000, now)
    this.log(result === 'vetoed' ? 'deny' : 'info', `veto ${id.slice(0, 8)}: ${result}`)
    void this.channel.send_dm(this.opts.config.veto_pubkey, `Cinderella: ${REPLIES[result](id)}`)
    if (result === 'vetoed' && this.opts.config.gateway_pubkey) {
      void this.channel.send_dm(this.opts.config.gateway_pubkey, JSON.stringify({ type: 'cinderella-veto', id, status: 'vetoed' }))
    }
  }

  stop () : void {
    if (this.timer) clearInterval(this.timer)
    try { this.sub?.close() } catch { /* closed */ }
    this.channel.close()
  }
}

