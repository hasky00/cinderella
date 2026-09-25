/**
 * Cinderella share middleware.
 *
 * Plugs into bifrost's `middleware.sign` hook, which runs on every
 * signer node BEFORE it produces a partial signature. Throwing here
 * makes this share refuse. Because every share runs it, a compromised
 * node cannot relax the policy — it can only vote yes, and it still
 * needs the others.
 *
 * Key rule: a bare hash is never signed. The requester MUST attach the
 * full event as `session.content` (hex-encoded JSON, see content.ts), and
 * we prove it matches the sighash before looking at the kind.
 * No content → no signature.
 */

import { sha256 }     from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { Policy }     from './policy.js'
import { decode_event_content } from './content.js'
import { spend_refused_nonce }  from './resync.js'
import type { NostrEvent } from './policy.js'

/** NIP-01 event id: sha256 of the canonical serialization. */
export function nostr_event_id (ev : NostrEvent) : string {
  const ser = JSON.stringify([ 0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content ])
  return bytesToHex(sha256(new TextEncoder().encode(ser)))
}

export interface MiddlewareLogger {
  (level : 'allow' | 'deny' | 'info', msg : string) : void
}

/**
 * Build the middleware.sign function for a BifrostNode.
 * Typed loosely on purpose: bifrost's RpcMessageData carries `data`
 * as the sign session package (content, type, hashes, ...).
 */
export function cinderella_middleware (policy : Policy, log : MiddlewareLogger = () => {}) {
  const check = cinderella_check(policy, log)
  return (node : unknown, msg : any) => {
    try {
      return check(msg)
    } catch (err) {
      // The requester already consumed its copy of our nonce; spend ours too.
      if (node) spend_refused_nonce(node as any, msg)
      throw err
    }
  }
}

function cinderella_check (policy : Policy, log : MiddlewareLogger) {
  return (msg : any) => {
    const session = msg?.data ?? {}
    const hashes  : string[][] = session.hashes ?? []
    const content : string | null = session.content ?? null

    if (content === null) {
      log('deny', 'sign request without event content (blind hash) — refused')
      throw new Error('cinderella: blind sign requests are not allowed')
    }

    let ev : NostrEvent
    try {
      ev = decode_event_content(content)
    } catch {
      log('deny', 'content is not hex-encoded event JSON — refused')
      throw new Error('cinderella: content is not hex-encoded event JSON')
    }

    // Prove the content is what we are actually being asked to sign.
    const id = nostr_event_id(ev)
    const requested = hashes.map(h => h[0])
    if (!requested.includes(id)) {
      log('deny', `content hash ${id.slice(0, 8)} does not match requested sighash`)
      throw new Error('cinderella: content does not match sighash')
    }
    if (requested.length !== 1) {
      throw new Error('cinderella: batched multi-hash sessions not supported')
    }
    ev.id = id

    const v = policy.evaluate(ev)
    if (!v.ok) {
      log('deny', `kind ${ev.kind} [${v.tier ?? '-'}]: ${v.reason}`)
      throw new Error(`cinderella: ${v.reason}`)
    }

    log('allow', `kind ${ev.kind} [${v.tier}] ${id.slice(0, 8)}`)
    return msg
  }
}
