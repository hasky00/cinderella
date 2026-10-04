/**
 * Requester side: ask the group to sign a Nostr event.
 *
 * This is what the Gateway calls instead of `node.req.sign(id)`.
 * `req.sign` goes through bifrost's batcher, which never sets `content`
 * (every Cinderella node refuses it as blind) and may merge several ids
 * into one multi-hash session (also refused). So we open one session per
 * event with the event attached.
 *
 * Refusals: Cinderella nodes answer a refusal with a reject message carrying
 * the reason and a code (refusal.ts). They end the session at once (no
 * timeout) and come back on the thrown SignRefusedError. A node that doesn't
 * (an older one, or offline) still shows up as a timeout.
 *
 * Nonces: before signing we ping any peer we lack nonces from. If a node
 * refuses with code 'nonce' (it restarted, so the nonce we used is dead), we
 * drop that peer's nonces, ping it for fresh ones and run the round once
 * more; that round is safe to repeat because the node refused before its
 * policy counted anything. After any other failure we discard the nonces we
 * hold from peers that didn't answer (they may have restarted). See resync.ts.
 */

import type { BifrostNode, SignatureEntry } from '@frostr/bifrost'
import { nostr_event_id }         from './middleware.js'
import { encode_event_content, SESSION_TYPE } from './content.js'
import type { NostrEvent }        from './policy.js'
import { ensure_nonces, discard_incoming, peer_indexes } from './resync.js'
import { parse_refusal, type Refusal } from './refusal.js'

export type EventTemplate = Pick<NostrEvent, 'created_at' | 'kind' | 'tags' | 'content'>

/** The group's x-only pubkey, i.e. the npub every share signs for. */
export function group_pubkey (node : BifrostNode) : string {
  const pk = node.group.group_pk
  return pk.length === 66 ? pk.slice(2) : pk
}

export interface SignOptions {
  /**
   * Only use these peers (x-only or compressed pubkeys). The gateway uses this
   * to show a delay-gated event to every share node, so each starts its clock.
   */
  peers? : string[]
}

/** A peer's refusal, with the member index and pubkey it came from. */
export interface PeerRefusal extends Refusal { peer : string, idx : number | undefined }

/** Signing failed; `refusals` holds what the share nodes said, if they said anything. */
export class SignRefusedError extends Error {
  constructor (message : string, readonly refusals : PeerRefusal[]) { super(message) }
}

export async function cinderella_sign (node : BifrostNode, tmpl : EventTemplate, options : SignOptions = {}) : Promise<NostrEvent> {
  const ev : NostrEvent = { ...tmpl, pubkey: group_pubkey(node), id: '' }
  ev.id = nostr_event_id(ev)

  const first = await sign_round(node, ev, options)
  if (first.ok) return first.event

  // A node didn't know our nonce (it restarted): fresh nonces from it, then once more.
  const stale = first.refusals.filter(r => r.code === 'nonce')
  if (stale.length) {
    for (const r of stale) if (r.idx !== undefined) discard_incoming(node, r.idx)
    const again = await sign_round(node, ev, options)
    if (again.ok) return again.event
    throw failure(again)
  }
  throw failure(first)
}

type RoundResult =
  | { ok : true, event : NostrEvent }
  | { ok : false, err : string, refusals : PeerRefusal[] }

function failure (r : Extract<RoundResult, { ok : false }>) : SignRefusedError {
  const said = r.refusals.map(x => x.reason)
  const message = said.length
    ? `cinderella: refused by share node${said.length > 1 ? 's' : ''}: ${Array.from(new Set(said)).join('; ')}`
    : `cinderella: signing failed: ${r.err}`
  return new SignRefusedError(message, r.refusals)
}

async function sign_round (node : BifrostNode, ev : NostrEvent, options : SignOptions) : Promise<RoundResult> {
  await ensure_nonces(node, options.peers)

  // Remember which members were in our session, so a failure only resets those peers.
  let members : number[] = []
  const refusals = new Map<string, PeerRefusal>()
  const on_rej = (_reason : unknown, session : any) => {              // [reason, session]
    if (session?.hashes?.some((h : string[]) => h[0] === ev.id)) members = session.members ?? []
  }
  const on_err = (_reason : unknown, msgs : any) => {                 // [reason, peer responses]
    if (Array.isArray(msgs)) members = peer_indexes(node, msgs.map((m : any) => String(m?.event?.pubkey ?? '')))
  }
  const on_msg = (msg : any) => {                                     // a node's reject, with its reason
    if (msg?.type !== 'reject') return
    const r = parse_refusal(msg.reason)
    if (!r || r.sighash !== ev.id) return
    const peer = String(msg?.event?.pubkey ?? '')
    refusals.set(peer, { ...r, peer, idx: peer_indexes(node, [ peer ])[0] })
  }
  node.on('/sign/sender/rej', on_rej)
  node.on('/sign/sender/err', on_err)
  node.on('message', on_msg)

  let res
  try {
    res = await node.req.sign_batch([ [ ev.id ] ], {
      content : encode_event_content(ev),
      type    : SESSION_TYPE,
      retries : 0,           // a retry would count twice against rate limits
      ...(options.peers ? { peers: options.peers.map(pk => pk.length === 66 ? pk.slice(2) : pk) } : {})
    })
  } finally {
    node.off('/sign/sender/rej', on_rej)
    node.off('/sign/sender/err', on_err)
    node.off('message', on_msg)
  }
  if (!res.ok) {
    // A peer that answered with a policy refusal still holds good nonces from us
    // (it spent its copy of the one we used); only the silent ones may have restarted.
    const answered = new Set(Array.from(refusals.values()).filter(r => r.code !== 'nonce').map(r => r.idx))
    for (const idx of members) if (idx !== node.signer.idx && !answered.has(idx)) discard_incoming(node, idx)
    return { ok: false, err: String(res.err), refusals: Array.from(refusals.values()) }
  }

  // bifrost's .d.ts uses an unresolvable '@/types' alias, so annotate.
  const sigs  : SignatureEntry[] = res.data
  const entry = sigs.find(([ sighash ]) => sighash === ev.id)
  if (!entry) return { ok: false, err: 'signature missing from response', refusals: [] }
  return { ok: true, event: { ...ev, sig: entry[2] } }
}
