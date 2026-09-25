/**
 * Nonce pools across restarts (see resync.ts).
 *
 * bifrost 2.0.2 keeps nonce pools in memory only. Without resync:
 *  A) after the requester restarts, it can never sign again;
 *  B) after a share node restarts, the requester burns its stale nonces
 *     one timeout at a time;
 *  C) every refusal leaks one of the share node's outgoing nonces;
 *  D) two pings in flight at once make the share node discard the fresh
 *     batch its first reply just delivered.
 */

import { readFileSync }  from 'node:fs'
import { BifrostNode, Lib } from '@frostr/bifrost'
import { Policy }        from './policy.js'
import { create_share_node } from './share-node.js'
import { cinderella_sign } from './request.js'
import { close_node, discard_incoming, single_flight_pings } from './resync.js'
import { TestRelay }     from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const note   = (kind = 1) => ({ kind, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'n' + Math.random() })
const signs  = async (gw : BifrostNode, kind = 1) => { try { await cinderella_sign(gw, note(kind)); return true } catch { return false } }

const relay = new TestRelay()
await relay.start()

const { group, shares } = Lib.generate_dealer_package(2, 3)
const opts   = { node_config: { msg_timeout: 2000, sub_timeout: 2000 } }
const cfg    = JSON.parse(readFileSync('./cinderella.config.json', 'utf8'))
const mk_gw    = () => { const n = new BifrostNode(group, shares[0], [ relay.url ], opts); single_flight_pings(n); return n }
const mk_cindy = () => create_share_node(group, shares[1], [ relay.url ], new Policy(cfg), () => {}, opts)

let gw    = mk_gw()
let cindy = mk_cindy()

try {
  await gw.connect()
  await cindy.connect()

  console.log('baseline')
  assert(await signs(gw), 'first sign pings for nonces by itself and succeeds')

  console.log('A) requester restarts, share node stays up')
  await close_node(gw)
  gw = mk_gw()
  await gw.connect()
  assert(await signs(gw), 'restarted requester signs on its first attempt')

  console.log('B) share node restarts, requester stays up')
  await close_node(cindy)
  cindy = mk_cindy()
  await cindy.connect()
  const first  = await signs(gw)
  const second = await signs(gw)
  assert(second, `signs again after at most one failed attempt (first: ${first ? 'signed' : 'failed'}, second: ${second ? 'signed' : 'failed'})`)
  assert(await signs(gw), 'and keeps signing')

  console.log('C) refusals do not leak the share node\'s nonces')
  // Measure one refusal in isolation: the requester still holds nonces, so no
  // resync runs, and the share node's outgoing count must drop by exactly one.
  const gw_idx = shares[0].idx
  const before = cindy.pool.get_outgoing_count(gw_idx)
  await signs(gw, 1984)                                         // default deny
  const after  = cindy.pool.get_outgoing_count(gw_idx)
  assert(after === before - 1, `one refusal spends one of the share node's nonces (${before} -> ${after})`)
  for (let i = 0; i < 2; i++) await signs(gw, 1984)
  assert(await signs(gw), 'kind 1 still signs after repeated refusals')

  console.log('D) two pings at once after the requester dropped its nonces')
  // As in the dry run: the keepalive ping and a signature's ensure_nonces
  // both ask while the requester holds none.
  discard_incoming(gw, shares[1].idx)
  await Promise.all([ gw.req.ping(cindy.pubkey), gw.req.ping(cindy.pubkey) ])
  assert(await signs(gw), 'first signature after the double ping succeeds')
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  await Promise.allSettled([ close_node(gw), close_node(cindy) ])
  await relay.close()
  process.exit()
}
