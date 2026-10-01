/**
 * Veto alerts: private Nostr DMs (NIP-17) from this node's alert key.
 *
 * The alert key is generated on the node and stored next to the policy state
 * (mode 600). It is NOT a FROSTR share; it only signs alerts, replies and the
 * node's DM inbox list. Alerts go to every alert relay; an alert counts as
 * delivered once at least one relay accepted it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip17, nip19, nip59 } from 'nostr-tools'
import type { Event as NostrToolsEvent } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { HeldEntry } from './policy.js'

export interface AlertKey {
  sk      : Uint8Array
  pubkey  : string   // hex
  created : boolean
}

/** Load the node's alert key, or create it (mode 600) on first start. */
export function load_or_create_alert_key (path : string) : AlertKey {
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`cinderella: alert key ${path} is not 64 hex characters`)
    const sk = hexToBytes(hex)
    return { sk, pubkey: getPublicKey(sk), created: false }
  }
  const sk = generateSecretKey()
  writeFileSync(path, bytesToHex(sk) + '\n', { mode: 0o600, flag: 'wx' })
  return { sk, pubkey: getPublicKey(sk), created: true }
}

/** npub… or 64-hex -> 64-hex. Throws on anything else. */
export function to_hex_pubkey (value : string, what : string) : string {
  const v = value.trim()
  if (/^[0-9a-f]{64}$/.test(v)) return v
  if (v.startsWith('npub1')) {
    try {
      const d = nip19.decode(v)
      if (d.type === 'npub') return d.data as string
    } catch { /* not a valid npub: fall through */ }
  }
  throw new Error(`cinderella: ${what} must be an npub or a 64-hex pubkey`)
}

export interface SendResult {
  accepted : string[]
  failed   : Record<string, string>
}

const PUBLISH_TIMEOUT_MS = 8_000

function within<T> (p : Promise<T>, ms : number) : Promise<T> {
  return Promise.race([ p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)) ])
}

/**
 * A NIP-17 group message: ONE rumor listing every member, sealed and wrapped
 * separately for each. (nostr-tools' nip17.wrapManyEvents sends separate 1:1
 * messages instead, so a reply would reach only one member.) A reply in the
 * same group reaches every member, e.g. every Cinderella node at once.
 */
export function wrap_group (sk : Uint8Array, members : string[], text : string) : Map<string, NostrToolsEvent> {
  const sender = getPublicKey(sk)
  const others = Array.from(new Set(members)).filter(pk => pk !== sender)
  const rumor  = nip59.createRumor({ kind: 14, tags: others.map(pk => [ 'p', pk ]), content: text }, sk)
  const wraps  = new Map<string, NostrToolsEvent>()
  for (const pk of others) wraps.set(pk, nip59.createWrap(nip59.createSeal(rumor, sk, pk), pk))
  return wraps
}

const INBOX_TTL_MS = 10 * 60_000

export class AlertChannel {
  readonly pool = new SimplePool()
  private readonly inboxes = new Map<string, { relays : string[], at : number }>()

  constructor (
    private readonly key    : AlertKey,
    readonly relays         : string[]
  ) {}

  private async publish_to (relays : string[], event : Parameters<SimplePool['publish']>[1]) : Promise<SendResult> {
    const results = await Promise.allSettled(this.pool.publish(relays, event).map(p => within(p, PUBLISH_TIMEOUT_MS)))
    const accepted : string[] = []
    const failed : Record<string, string> = {}
    results.forEach((r, i) => {
      const relay = relays[i]!
      if (r.status === 'fulfilled') accepted.push(relay)
      else failed[relay] = String((r.reason as Error)?.message ?? r.reason)
    })
    return { accepted, failed }
  }

  private publish (event : Parameters<SimplePool['publish']>[1]) : Promise<SendResult> {
    return this.publish_to(this.relays, event)
  }

  /** A pubkey's NIP-17 DM inbox relays (kind 10050), looked up on our relays, cached. */
  async inbox_relays (pubkey : string) : Promise<string[]> {
    const cached = this.inboxes.get(pubkey)
    if (cached && Date.now() - cached.at < INBOX_TTL_MS) return cached.relays
    let relays : string[] = []
    try {
      const events = await within(this.pool.querySync(this.relays, { kinds: [ 10050 ], authors: [ pubkey ] }, { maxWait: 5_000 }), 6_000)
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
      relays = (newest?.tags ?? [])
        .filter(t => t[0] === 'relay' && typeof t[1] === 'string' && /^wss?:\/\/\S+$/.test(t[1]))
        .map(t => t[1]!)
    } catch { /* none found: our relays only */ }
    this.inboxes.set(pubkey, { relays, at: Date.now() })
    return relays
  }

  /** Our alert relays plus the recipient's inbox relays. */
  async relays_for (pubkey : string) : Promise<string[]> {
    return Array.from(new Set([ ...this.relays, ...(await this.inbox_relays(pubkey)) ]))
  }

  /** NIP-17 private message to `to` (hex pubkey), also to its inbox relays. */
  async send_dm (to : string, text : string) : Promise<SendResult> {
    return this.publish_to(await this.relays_for(to), nip17.wrapEvent(this.key.sk, { publicKey: to }, text))
  }

  /**
   * NIP-17 group message to `members` (hex pubkeys; we are added implicitly).
   * Returns the result per member; each wrap goes to our relays plus that
   * member's inbox relays.
   */
  async send_group (members : string[], text : string) : Promise<Map<string, SendResult>> {
    const wraps = wrap_group(this.key.sk, members, text)
    const out = new Map<string, SendResult>()
    await Promise.all([ ...wraps ].map(async ([ pk, wrap ]) => {
      out.set(pk, await this.publish_to(await this.relays_for(pk), wrap))
    }))
    return out
  }

  /** NIP-17 DM inbox list (kind 10050), so replies are sent to our alert relays. */
  publish_inbox () : Promise<SendResult> {
    return this.publish(finalizeEvent({
      kind       : 10050,
      created_at : Math.floor(Date.now() / 1000),
      tags       : this.relays.map(r => [ 'relay', r ]),
      content    : ''
    }, this.key.sk))
  }

  close () : void {
    try { this.pool.close(this.relays) } catch { /* already closed */ }
  }
}

const KIND_NAMES : Record<number, string> = { 0: 'profile change', 5: 'deletion', 10063: 'media server list' }

/** `sent_at`: when this alert goes out; the delay counts from its delivery (about the same moment). */
export function alert_text (id : string, entry : HeldEntry, sent_at = Date.now()) : string {
  const what   = KIND_NAMES[entry.kind] ?? `kind ${entry.kind} event`
  const unlock = entry.unlock ?? sent_at + entry.delay_hours * 3_600_000
  return [
    `Cinderella: held a ${what} (kind ${entry.kind}): ${entry.summary}`,
    `Unlocks ${new Date(unlock).toISOString().replace('T', ' ').slice(0, 16)} UTC (${entry.delay_hours}h), unless you veto it.`,
    `To cancel, reply exactly:`,
    `veto ${id}`
  ].join('\n')
}
