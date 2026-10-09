/**
 * Telling the requester WHY a share node said no.
 *
 * bifrost 2.0.2 never answers a refused sign request, so the requester (the
 * Gateway) only ever saw "request timed out" and had to guess. Its transport
 * (@vbyte/nostr-sdk) already has reject messages, and the requester's wait
 * for answers already accepts them, so the node now answers every refusal
 * with one. The reason is a short JSON object behind a prefix:
 *
 *   cinderella-refusal:{"sighash":"<event id>","code":"locked","reason":"…","unlock_at":1759502138514}
 *
 * Codes:
 *   locked        held, delay running; unlock_at = when it unlocks here
 *   held          held, delay not started yet (veto alert not delivered) or first sighting
 *   catching_up   unlocked, but the veto feed isn't caught up on every relay yet
 *   vetoed        vetoed from the veto key; never signed
 *   rate_limited  tier rate limit; retry_at = when a slot frees up
 *   denied        refused for good (kind not allowed, no content, …)
 *   nonce         this node doesn't know the nonce used (it restarted): resync and retry
 *   error         anything else
 *
 * A requester that doesn't understand it (an older Gateway) just fails fast
 * instead of timing out. Nothing secret is in a refusal: it goes only to the
 * requester, encrypted like every bifrost message.
 *
 * The Gateway (hasky00/igloo-server) has a copy of this file. Keep in sync.
 */

export type RefusalCode = 'locked' | 'held' | 'catching_up' | 'vetoed' | 'rate_limited' | 'denied' | 'nonce' | 'error'

export interface Refusal {
  sighash    : string | null
  code       : RefusalCode
  reason     : string
  /** ms; when a 'locked' (or first-sighting 'held') event unlocks on this node. */
  unlock_at? : number | null
  /** ms; when a 'rate_limited' request may succeed. */
  retry_at?  : number | null
}

const PREFIX = 'cinderella-refusal:'
const CODES : RefusalCode[] = [ 'locked', 'held', 'catching_up', 'vetoed', 'rate_limited', 'denied', 'nonce', 'error' ]

export function encode_refusal (r : Refusal) : string {
  const out : Record<string, unknown> = { sighash: r.sighash, code: r.code, reason: r.reason.slice(0, 300) }
  if (typeof r.unlock_at === 'number') out.unlock_at = r.unlock_at
  if (typeof r.retry_at === 'number')  out.retry_at  = r.retry_at
  return PREFIX + JSON.stringify(out)
}

/** A reject message's reason, if it is a Cinderella refusal. */
export function parse_refusal (reason : unknown) : Refusal | null {
  if (typeof reason !== 'string' || !reason.startsWith(PREFIX)) return null
  try {
    const j = JSON.parse(reason.slice(PREFIX.length)) as Record<string, unknown>
    if (!CODES.includes(j.code as RefusalCode) || typeof j.reason !== 'string') return null
    const num = (v : unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      sighash   : typeof j.sighash === 'string' && /^[0-9a-f]{64}$/.test(j.sighash) ? j.sighash : null,
      code      : j.code as RefusalCode,
      reason    : j.reason,
      unlock_at : num(j.unlock_at),
      retry_at  : num(j.retry_at),
    }
  } catch {
    return null
  }
}

/** Thrown by the middleware: a refusal with its code (bifrost only keeps the message). */
export class RefusalError extends Error {
  constructor (readonly refusal : Omit<Refusal, 'sighash'>) {
    super(`cinderella: ${refusal.reason}`)
  }
}

/** The single event id a sign session asks for, if any. */
export function session_sighash (msg : any) : string | null {
  const h = msg?.data?.hashes?.[0]?.[0]
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : null
}

/** bifrost errors after our middleware allowed: the nonce ones mean "resync and retry". */
export function classify_bifrost_error (reason : string) : RefusalCode {
  return /nonce/i.test(reason) ? 'nonce' : 'error'
}
