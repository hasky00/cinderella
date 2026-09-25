/**
 * Wire encoding for the event attached to a sign session.
 *
 * bifrost hashes `session.content` into the session id with
 * `Buff.bytes(content)`, which only accepts hex — raw JSON throws before
 * the request is ever sent. So the event JSON travels as hex(utf8(json)).
 * It is still bound to the session id, so it cannot be swapped in transit.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { NostrEvent }        from './policy.js'

/** Session `type` used for Cinderella requests. */
export const SESSION_TYPE = 'nostr-event'

export function encode_event_content (ev : Omit<NostrEvent, 'id' | 'sig'>) : string {
  const { pubkey, created_at, kind, tags, content } = ev
  return bytesToHex(new TextEncoder().encode(JSON.stringify({ pubkey, created_at, kind, tags, content })))
}

/** Throws if `hex` is not hex-encoded UTF-8 JSON. */
export function decode_event_content (hex : string) : NostrEvent {
  if (!/^([0-9a-f]{2})*$/.test(hex)) throw new Error('content is not lowercase hex')
  const json = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(hex))
  return JSON.parse(json)
}
