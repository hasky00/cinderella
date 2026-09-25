/**
 * Nonce pool resync for @frostr/bifrost 2.0.2 (pinned — this reaches into
 * pool internals).
 *
 * bifrost keeps nonce pools in memory only, and nothing reconciles the two
 * sides after one of them restarts:
 *
 *  - requester restarts: the responder still counts its old outgoing nonces,
 *    never sends fresh ones, and the requester can never sign again.
 *  - responder restarts: the requester spends its stale nonces one by one,
 *    each a silent refusal that ends in a timeout.
 *
 * And specific to Cinderella: a refused request consumes the requester's
 * nonce but never marks the responder's copy spent, so refusals slowly fill
 * the responder's outgoing pool until it can no longer replenish.
 *
 * Every fix here only ever DISCARDS nonces. Discarding can never cause nonce
 * reuse (which would leak a share); the worst case is one extra ping.
 * Do not "fix" this by persisting and restoring pool state.
 */

import { CONST } from '@frostr/bifrost'
import type { BifrostNode } from '@frostr/bifrost'

type PoolMaps = { _outgoing? : unknown, _incoming? : unknown }

interface PoolStatusEntry { peer_idx : number, available : number }

/** Drop every nonce in one direction for one peer. Fails loudly if bifrost's internals moved. */
function drop (node : BifrostNode, side : '_outgoing' | '_incoming', peer_idx : number) : number {
  const map = (node.pool as unknown as PoolMaps)[side]
  if (!(map instanceof Map)) throw new Error(`cinderella: bifrost pool.${side} is not a Map — resync needs updating for this bifrost version`)
  const n = (map.get(peer_idx) as Map<string, unknown> | undefined)?.size ?? 0
  map.delete(peer_idx)
  return n
}

function member_idx (node : BifrostNode, pubkey : string) : number | undefined {
  const pk = pubkey.length === 66 ? pubkey.slice(2) : pubkey
  const members : { idx : number, pubkey : string }[] = node.group.members
  return members.find(m => m.pubkey.slice(-64) === pk)?.idx
}

function thresholds (node : BifrostNode) : { min : number, critical : number } {
  const cfg = (node.pool as unknown as { _config? : { min_threshold? : number, critical_threshold? : number } })._config
  return {
    min      : cfg?.min_threshold      ?? CONST.DEFAULT_MIN_THRESHOLD,
    critical : cfg?.critical_threshold ?? CONST.DEFAULT_CRITICAL_THRESHOLD
  }
}

export type ResyncLog = (msg : string) => void

/**
 * Responder side (every Cinderella share node).
 *
 * A ping request carries the requester's pool_status, including how many of
 * OUR nonces it holds. If it holds too few to sign with us, while we hold
 * enough outgoing for it that bifrost won't send more, our outgoing records
 * are stale (it restarted, or dropped them): discard them so this very ping
 * reply carries a fresh batch. The few the requester might still hold are
 * already unusable to it (at or below critical_threshold it cannot sign).
 *
 * Runs synchronously from '/ping/handler/req', which bifrost emits before it
 * builds the reply.
 */
export function attach_responder_resync (node : BifrostNode, log : ResyncLog = () => {}) : void {
  node.on('/ping/handler/req', (msg : any) => {
    try {
      const requester_idx = member_idx(node, String(msg?.event?.pubkey ?? ''))
      if (requester_idx === undefined) return
      const req = JSON.parse(msg?.params?.[0] ?? '{}') as { pool_status? : PoolStatusEntry[] }
      const theirs = req.pool_status?.find(s => s.peer_idx === node.signer.idx)
      if (theirs === undefined) return   // older requester, no status: leave bifrost's default

      const { critical } = thresholds(node)
      const stuck = theirs.available <= critical && !node.pool.should_send_nonces_to(requester_idx)
      if (!stuck) return

      const n = drop(node, '_outgoing', requester_idx)
      log(`resync: peer ${requester_idx} holds ${theirs.available} of our nonces but we counted ${n}; discarded ours, sending fresh`)
    } catch (err) {
      log(`resync: responder check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/**
 * Responder side: a refused sign request still consumed the requester's copy
 * of our nonce. Mark ours spent too, so refusals don't pile up in the
 * outgoing pool. Call from the sign middleware before throwing.
 */
export function spend_refused_nonce (node : BifrostNode, msg : any) : void {
  try {
    const requester_idx = member_idx(node, String(msg?.event?.pubkey ?? ''))
    const ours = (msg?.data?.nonces ?? []).find((n : any) => n?.idx === node.signer.idx)
    if (requester_idx !== undefined && typeof ours?.code === 'string') {
      node.pool.mark_spent(requester_idx, ours.code)
    }
  } catch { /* best effort: never mask the refusal itself */ }
}

/**
 * Requester side (the Gateway). Discard every nonce we hold from `peer_idx`,
 * e.g. after a sign session with that peer failed: if the peer restarted,
 * they are all dead. The next ping then shows the peer we hold none, and
 * attach_responder_resync on its side sends a fresh batch.
 */
export function discard_incoming (node : BifrostNode, peer_idx : number) : number {
  return drop(node, '_incoming', peer_idx)
}

/**
 * Requester side: ping every peer we may send to but cannot currently sign
 * with, so their replies refill our pool. Returns how many peers are
 * signable afterwards.
 */
export async function ensure_nonces (node : BifrostNode) : Promise<number> {
  const peers = node.peers.filter(p => p.policy.send)
  await Promise.allSettled(peers.map(async p => {
    const idx = member_idx(node, p.pubkey)
    if (idx !== undefined && !node.pool.can_sign(idx)) await node.req.ping(p.pubkey)
  }))
  return peers.filter(p => {
    const idx = member_idx(node, p.pubkey)
    return idx !== undefined && node.pool.can_sign(idx)
  }).length
}

/** Map peer pubkeys to member indexes (for discard_incoming after a failed session). */
export function peer_indexes (node : BifrostNode, pubkeys : string[]) : number[] {
  return pubkeys.map(pk => member_idx(node, pk)).filter((i) : i is number => i !== undefined)
}

/**
 * bifrost 2.0.2's close() calls client.clear(), which @vbyte/nostr-sdk 1.0.1
 * does not have, so it throws before closing the socket and the node keeps
 * running. Close the client directly as well.
 */
export async function close_node (node : BifrostNode) : Promise<void> {
  try { await node.close() } catch { /* expected on 2.0.2 */ }
  try { await (node.client as unknown as { close : () => unknown }).close() } catch { /* already closed */ }
}
