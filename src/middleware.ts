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
 *
 * Every refusal is answered with a reject message carrying the reason and a
 * code (refusal.ts), so the requester knows "still locked until …" instead
 * of timing out. And before the policy runs, we check we still hold the
 * nonce the requester used: if we restarted, we don't, and the policy must
 * not record the event as signed for a round that can't produce a signature.
 */

import { sha256 }     from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { Policy }     from './policy.js'
import { decode_event_content } from './content.js'
import { spend_refused_nonce }  from './resync.js'
import { RefusalError, classify_bifrost_error, encode_refusal, session_sighash, type Refusal } from './refusal.js'
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
      if (node) check_nonce(node as any, msg)
      return check(msg)
    } catch (err) {
      // The requester already consumed its copy of our nonce; spend ours too.
      if (node) spend_refused_nonce(node as any, msg)
      if (node) {
        const r = err instanceof RefusalError ? err.refusal : { code: 'denied' as const, reason: err instanceof Error ? err.message.replace(/^cinderella: /, '') : String(err) }
        send_refusal(node as any, msg, { ...r, sighash: session_sighash(msg) })
      }
      throw err
    }
  }
}

/** Requests we already answered with a refusal (so the bifrost error hook doesn't answer twice). */
const answered = new WeakSet<object>()

/** Answer a sign request with a reject message carrying a Cinderella refusal. Best effort. */
export function send_refusal (node : any, msg : any, refusal : Refusal) : void {
  if (!msg || typeof msg !== 'object' || answered.has(msg)) return
  answered.add(msg)
  try {
    const p = node?.client?.respond?.(msg)?.reject?.(encode_refusal(refusal))
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch { /* never mask the refusal itself */ }
}

/**
 * A sign session that failed inside bifrost after our middleware allowed it
 * (e.g. the nonce vanished in between): answer it too. Attach once per node.
 */
export function attach_refusal_replies (node : any) : void {
  node.on('/sign/handler/rej', (reason : unknown, msg : any) => {   // bifrost spreads [reason, msg]
    const text = String(reason)
    send_refusal(node, msg, { sighash: session_sighash(msg), code: classify_bifrost_error(text), reason: text })
  })
}

/**
 * Do we still hold the nonce the requester used for us? After a restart we
 * don't: refuse with code 'nonce' BEFORE the policy runs, so a round that
 * can't produce a signature never counts as signed (or against a limit).
 */
function check_nonce (node : any, msg : any) : void {
  const pool = node?.pool
  if (!pool || typeof pool.derive_secret_for_signing !== 'function') return
  const ours = (msg?.data?.nonces ?? []).find((n : any) => n?.idx === node.signer?.idx)
  const pk = String(msg?.event?.pubkey ?? '')
  const x = pk.length === 66 ? pk.slice(2) : pk
  const requester = (node.group?.members ?? []).find((m : any) => String(m.pubkey).slice(-64) === x)
  if (!ours || !requester) return   // bifrost itself refuses these
  if (pool.derive_secret_for_signing(requester.idx, ours) === null) {
    throw new RefusalError({ code: 'nonce', reason: 'this node does not hold the nonce you used (it restarted or discarded it); resync nonces and retry' })
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
      throw new RefusalError({ code: v.code, reason: v.reason, unlock_at: v.unlock_at, retry_at: v.retry_at })
    }

    log('allow', `kind ${ev.kind} [${v.tier}] ${id.slice(0, 8)}`)
    return msg
  }
}
