/**
 * Requester side: ask the group to sign a Nostr event.
 *
 * This is what the Gateway calls instead of `node.req.sign(id)`.
 * `req.sign` goes through bifrost's batcher, which never sets `content`
 * (every Cinderella node refuses it as blind) and may merge several ids
 * into one multi-hash session (also refused). So we open one session per
 * event with the event attached.
 *
 * Note: bifrost does not send refusals back — a share that says no just
 * stays silent, so a denied request surfaces here as a timeout.
 *
 * Nonces: before signing we ping any peer we lack nonces from, and after a
 * failed session we discard the nonces we hold from the peers in it (they
 * may have restarted). See resync.ts.
 */

import type { BifrostNode, SignatureEntry } from '@frostr/bifrost'
import { nostr_event_id }         from './middleware.js'
import { encode_event_content, SESSION_TYPE } from './content.js'
import type { NostrEvent }        from './policy.js'
import { ensure_nonces, discard_incoming, peer_indexes } from './resync.js'

export type EventTemplate = Pick<NostrEvent, 'created_at' | 'kind' | 'tags' | 'content'>

/** The group's x-only pubkey, i.e. the npub every share signs for. */
export function group_pubkey (node : BifrostNode) : string {
  const pk = node.group.group_pk
  return pk.length === 66 ? pk.slice(2) : pk
}

export async function cinderella_sign (node : BifrostNode, tmpl : EventTemplate) : Promise<NostrEvent> {
  const ev : NostrEvent = { ...tmpl, pubkey: group_pubkey(node), id: '' }
  ev.id = nostr_event_id(ev)

  await ensure_nonces(node)

  // Remember which members were in our session, so a failure only resets those peers.
  let members : number[] = []
  const on_rej = (_reason : unknown, session : any) => {              // [reason, session]
    if (session?.hashes?.some((h : string[]) => h[0] === ev.id)) members = session.members ?? []
  }
  const on_err = (_reason : unknown, msgs : any) => {                 // [reason, peer responses]
    if (Array.isArray(msgs)) members = peer_indexes(node, msgs.map((m : any) => String(m?.event?.pubkey ?? '')))
  }
  node.on('/sign/sender/rej', on_rej)
  node.on('/sign/sender/err', on_err)

  let res
  try {
    res = await node.req.sign_batch([ [ ev.id ] ], {
      content : encode_event_content(ev),
      type    : SESSION_TYPE,
      retries : 0            // a retry would count twice against rate limits
    })
  } finally {
    node.off('/sign/sender/rej', on_rej)
    node.off('/sign/sender/err', on_err)
  }
  if (!res.ok) {
    for (const idx of members) if (idx !== node.signer.idx) discard_incoming(node, idx)
    throw new Error(`cinderella: signing failed: ${res.err}`)
  }

  // bifrost's .d.ts uses an unresolvable '@/types' alias, so annotate.
  const sigs  : SignatureEntry[] = res.data
  const entry = sigs.find(([ sighash ]) => sighash === ev.id)
  if (!entry) throw new Error('cinderella: signature missing from response')
  return { ...ev, sig: entry[2] }
}
