/**
 * The 4-5 Oct pass-test failures, reproduced with real bifrost nodes on a
 * relay that replays bifrost's (ephemeral) messages to new subscribers, as
 * the dry-run relay does.
 *
 *  1. a share node that restarts does not answer the pings and sign requests
 *     the requester sent while it was down (they made it hand out nonce
 *     batches the requester never stored)
 *  2. the requester restarts and says so: the share node drops the nonces it
 *     counted as given to it, in both directions
 *  3. an event allowed after its delay whose signature then failed: asking
 *     again passes, with no new delay, no new alert and no new rate-limit slot
 */

import { BifrostNode, Lib } from '@frostr/bifrost'
import { Policy }        from './policy.js'
import type { CinderellaConfig } from './policy.js'
import { create_share_node } from './share-node.js'
import { cinderella_sign } from './request.js'
import { announce_nonce_reset, close_node, ignore_stale_messages, single_flight_pings } from './resync.js'
import { TestRelay }     from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const sleep  = (ms : number) => new Promise(r => setTimeout(r, ms))
async function until (check : () => boolean, ms = 6000) : Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await sleep(50) }
  return check()
}

const relay = new TestRelay()
await relay.start()
relay.store_ephemeral = true

const { group, shares } = Lib.generate_dealer_package(2, 3)
const opts = { node_config: { msg_timeout: 2000, sub_timeout: 2000 } }
const now_s = () => Math.floor(Date.now() / 1000)
const cfg : CinderellaConfig = {
  version: 1, default_tier: 'deny', require_content: true,
  tiers: { daily: { kinds: [ 1 ] }, identity: { kinds: [ 0 ], delay_hours: 0.0003, rate_limit: { max_events: 1, per_minutes: 1440 } } }
}
const gw_idx = shares[0].idx

const mk_gw = () => { const n = new BifrostNode(group, shares[0], [ relay.url ], opts); single_flight_pings(n); ignore_stale_messages(n); return n }
const gw = mk_gw()
let policy = new Policy(cfg)
const mk_cindy = () => create_share_node(group, shares[1], [ relay.url ], policy, () => {}, opts)
let cindy = mk_cindy()

try {
  await gw.connect()
  await cindy.connect()
  await cinderella_sign(gw, { kind: 1, created_at: now_s(), tags: [], content: 'warm up' })

  console.log('1) a restarted share node ignores what was sent while it was down')
  await close_node(cindy)
  // While it is down, the requester pings it and asks for a signature (both time out).
  await gw.req.ping(cindy.pubkey).catch(() => undefined)
  await gw.req.ping(cindy.pubkey).catch(() => undefined)
  await cinderella_sign(gw, { kind: 1, created_at: now_s(), tags: [], content: 'while down' }).catch(() => undefined)
  await sleep(6000)                                                    // it comes back a little later (more than the clock-skew allowance)
  cindy = mk_cindy()
  let pings = 0, signs = 0
  cindy.on('/ping/handler/req', () => { pings += 1 })
  cindy.on('/sign/handler/req', () => { signs += 1 })
  await cindy.connect()
  await sleep(1500)                                                    // the relay replays its stored messages now
  assert(pings === 0,                                                  `no replayed ping answered (${pings})`)
  assert(signs === 0,                                                  `no replayed sign request handled (${signs})`)
  assert(cindy.pool.get_outgoing_count(gw_idx) === 0,                  'so it handed out no nonces the requester never stored')

  console.log('2) the requester restarts and says so')
  await cinderella_sign(gw, { kind: 1, created_at: now_s(), tags: [], content: 'fresh batch' })
  assert(cindy.pool.get_outgoing_count(gw_idx) > 0,                    'the share node counts nonces as given to the requester')
  announce_nonce_reset(gw)                                             // what the Gateway does on start
  assert(await until(() => cindy.pool.get_outgoing_count(gw_idx) === 0), 'after its restart notice the share node drops them')

  console.log('3) allowed after the delay, signature failed, asked again')
  policy = new Policy(cfg)
  await close_node(cindy); cindy = mk_cindy(); await cindy.connect()
  const ev = { id: '', pubkey: group.group_pk.slice(-64), kind: 0, created_at: now_s(), tags: [], content: '{"name":"x"}' }
  const { getEventHash } = await import('nostr-tools')
  ev.id = getEventHash(ev)
  const t0 = Date.now()
  policy.evaluate(ev, t0)                                              // held
  const unlock = policy.held()[0]![1].unlock!
  const first  = policy.evaluate(ev, unlock + 1)                       // allowed (uses the one rate-limit slot)
  const again  = policy.evaluate(ev, unlock + 60_000)                  // the signature failed: asked again
  const entry  = policy.held().find(([ id ]) => id === ev.id)?.[1]
  assert(first.ok && again.ok,                                         `allowed, and allowed again (${again.ok ? 'ok' : (again as { reason : string }).reason})`)
  assert(entry?.unlock === unlock && entry.allowed_at !== undefined,   'same unlock time: no new delay')
  assert(policy.restart_delays() === 0 && policy.held().find(([ id ]) => id === ev.id)?.[1].unlock === unlock, 'a veto-key change does not re-lock it')
  assert(policy.veto(ev.id, Date.now()) === 'already_signed',          'a veto after it was allowed is refused (it may be signed)')
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  await Promise.allSettled([ close_node(gw), close_node(cindy) ])
  await relay.close()
  process.exit()
}
