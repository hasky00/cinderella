/**
 * End-to-end: real bifrost nodes over a local relay.
 *
 * A throwaway 2-of-3 group. Share 1 is a plain requester (the Gateway's
 * role), share 2 runs Cinderella, share 3 stays offline — so every
 * signature must go through the Cinderella node.
 */

import { readFileSync }  from 'node:fs'
import { schnorr }       from '@noble/curves/secp256k1.js'
import { hexToBytes }    from '@noble/hashes/utils'
import { BifrostNode, Lib } from '@frostr/bifrost'
import { Policy }        from './policy.js'
import { nostr_event_id }  from './middleware.js'
import { create_share_node } from './share-node.js'
import { cinderella_sign, group_pubkey } from './request.js'
import { encode_event_content, SESSION_TYPE } from './content.js'
import { TestRelay }     from './test/relay.js'
import { ensure_nonces, single_flight_pings } from './resync.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const now    = () => Math.floor(Date.now() / 1000)

const relay = new TestRelay()
await relay.start()

const { group, shares } = Lib.generate_dealer_package(2, 3)
const opts = { node_config: { msg_timeout: 2000, sub_timeout: 3000 } }   // refusals are silent: they cost one sub_timeout

const denials : string[] = []
const cfg     = JSON.parse(readFileSync('./cinderella.config.json', 'utf8'))
const gateway = new BifrostNode(group, shares[0], [ relay.url ], opts)
single_flight_pings(gateway)
const cindy   = create_share_node(group, shares[1], [ relay.url ], new Policy(cfg),
  (lvl, m) => { if (lvl === 'deny') denials.push(m) }, opts)

try {
  await gateway.connect()
  await cindy.connect()

  // Exchange nonces both ways (this is how live nodes do it too).
  const p1 = await gateway.req.ping(cindy.pubkey)
  const p2 = await cindy.req.ping(gateway.pubkey)
  console.log('setup')
  assert(p1.ok && p2.ok, 'nodes ping each other over the relay')

  const last_denial = () => denials.at(-1) ?? ''
  const refused = async (label : string, fn : () => Promise<unknown>, reason : RegExp) => {
    const before = denials.length
    let failed = false
    try { await fn() } catch { failed = true }
    assert(failed && denials.length > before && reason.test(last_denial()), `${label}  (${last_denial()})`)
  }

  console.log('allowed')
  const note = await cinderella_sign(gateway, { kind: 1, created_at: now(), tags: [], content: 'hello from cinderella ✨' })
  assert(note.pubkey === group_pubkey(gateway), 'signed as the group pubkey')
  assert(note.id === nostr_event_id(note), 'event id is NIP-01 correct')
  assert(schnorr.verify(hexToBytes(note.sig!), hexToBytes(note.id), hexToBytes(note.pubkey)), 'BIP-340 signature verifies')

  console.log('refused')
  await refused('kind 0 held by delay gate', () =>
    cinderella_sign(gateway, { kind: 0, created_at: now(), tags: [], content: '{"name":"mallory"}' }), /queued/)
  await refused('kind 1984 denied (default deny)', () =>
    cinderella_sign(gateway, { kind: 1984, created_at: now(), tags: [], content: '' }), /default deny/)

  const blind_id = nostr_event_id({ id: '', pubkey: group_pubkey(gateway), created_at: now(), kind: 1, tags: [], content: 'blind' })
  await refused('blind req.sign(id) refused', async () => {
    await ensure_nonces(gateway)   // raw bifrost calls don't refill nonces themselves
    const r = await gateway.req.sign(blind_id)
    if (!r.ok) throw new Error(r.err)
  }, /blind/)

  const shown  = { pubkey: group_pubkey(gateway), created_at: now(), kind: 1, tags: [], content: 'harmless note' }
  const hidden = nostr_event_id({ ...shown, id: '', kind: 5, tags: [[ 'e', 'ab'.repeat(32) ]] })
  await refused('content for a kind 1, sighash of a kind 5 refused', async () => {
    await ensure_nonces(gateway)
    const r = await gateway.req.sign_batch([ [ hidden ] ], { content: encode_event_content(shown), type: SESSION_TYPE, retries: 0 })
    if (!r.ok) throw new Error(r.err)
  }, /does not match/)

  console.log('offline peer')
  // Share 3 is never online. With nonces from cindy in hand, signing must not
  // wait for a ping to share 3 to time out (sub_timeout here is 3000ms).
  await ensure_nonces(gateway)
  const t0 = Date.now()
  await cinderella_sign(gateway, { kind: 1, created_at: now(), tags: [], content: 'no waiting' })
  const ms = Date.now() - t0
  assert(ms < 1500, `signing does not wait for the offline third share (${ms}ms)`)

  console.log('after refusals')
  const again = await cinderella_sign(gateway, { kind: 7, created_at: now(), tags: [[ 'e', note.id ]], content: '+' })
  assert(schnorr.verify(hexToBytes(again.sig!), hexToBytes(again.id), hexToBytes(again.pubkey)), 'kind 7 still signs (nonce pools not wedged)')
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  await Promise.allSettled([ gateway.close(), cindy.close() ])
  await relay.close()
  process.exit()
}
