/**
 * Veto alerts: private Nostr DMs (NIP-17) from this node's alert key.
 *
 * The alert key is generated on the node and stored next to the policy state
 * (mode 600). It is NOT a FROSTR share; it only signs alerts, replies and the
 * node's DM inbox list. Alerts go to every alert relay; an alert counts as
 * delivered once at least one relay accepted it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip17, nip19 } from 'nostr-tools'
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

export class AlertChannel {
  readonly pool = new SimplePool()

  constructor (
    private readonly key    : AlertKey,
    readonly relays         : string[]
  ) {}

  private async publish (event : Parameters<SimplePool['publish']>[1]) : Promise<SendResult> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event).map(p => within(p, PUBLISH_TIMEOUT_MS)))
    const accepted : string[] = []
    const failed : Record<string, string> = {}
    results.forEach((r, i) => {
      const relay = this.relays[i]!
      if (r.status === 'fulfilled') accepted.push(relay)
      else failed[relay] = String((r.reason as Error)?.message ?? r.reason)
    })
    return { accepted, failed }
  }

  /** NIP-17 private message to `to` (hex pubkey). */
  send_dm (to : string, text : string) : Promise<SendResult> {
    return this.publish(nip17.wrapEvent(this.key.sk, { publicKey: to }, text))
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
