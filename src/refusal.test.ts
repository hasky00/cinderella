/**
 * Refusal reasons and nonce desync, with real bifrost nodes on a local relay.
 *
 *  1. every refusal reaches the requester at once, with its reason and code
 *     (no "request timed out"): denied, held + unlock time, locked + unlock
 *     time, rate limited + retry time, vetoed
 *  2. the share node lost its nonces (requester still holds stale ones):
 *     the round is refused with 'nonce', resynced and retried once, and signs
 *  3. same for an UNLOCKED held event: signed, and not held a second time
 *     (the node refuses before its policy counts the round)
 *  4. a restarted share node tells the requester to drop its nonces, so the
 *     first round after the restart already signs (no nonce refusal at all)
 */

import { BifrostNode, Lib } from '@frostr/bifrost'
import { Policy }        from './policy.js'
import type { CinderellaConfig } from './policy.js'
import { create_share_node } from './share-node.js'
import { cinderella_sign, SignRefusedError } from './request.js'
import { attach_requester_resync, close_node, single_flight_pings } from './resync.js'
import { parse_refusal } from './refusal.js'
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

const { group, shares } = Lib.generate_dealer_package(2, 3)
const SUB_TIMEOUT = 4000
const opts     = { node_config: { msg_timeout: 2000, sub_timeout: SUB_TIMEOUT } }
const DELAY_H  = 0.0005                                         // 1.8 s
const DELAY_MS = DELAY_H * 3_600_000
const cfg : CinderellaConfig = {
  version: 1, default_tier: 'deny', require_content: true,
  tiers: {
    daily    : { kinds: [ 1 ], rate_limit: { max_events: 3, per_minutes: 60 } },
    identity : { kinds: [ 0 ], delay_hours: DELAY_H },
  }
}
const now_s = () => Math.floor(Date.now() / 1000)
const tmpl  = (kind : number, content = 'n' + Math.random()) => ({ kind, created_at: now_s(), tags: [], content })

const gw = new BifrostNode(group, shares[0], [ relay.url ], opts)
single_flight_pings(gw)
const gw_idx = shares[0].idx

// Count the nonce refusals the requester receives.
let nonce_refusals = 0
gw.on('message', (msg : any) => { if (msg?.type === 'reject' && parse_refusal(msg.reason)?.code === 'nonce') nonce_refusals += 1 })

let policy = new Policy(cfg)
const mk_cindy = () => create_share_node(group, shares[1], [ relay.url ], policy, () => {}, opts)
let cindy = mk_cindy()
const cindy_idx = shares[1].idx
const drop_cindy_nonces = () => (cindy.pool as unknown as { _outgoing : Map<number, unknown> })._outgoing.delete(gw_idx)

async function attempt (t : ReturnType<typeof tmpl>) {
  const t0 = Date.now()
  try {
    await cinderella_sign(gw, t)
    return { ok: true as const, ms: Date.now() - t0 }
  } catch (err) {
    const refusals = err instanceof SignRefusedError ? err.refusals : []
    return { ok: false as const, ms: Date.now() - t0, message: String((err as Error).message), refusal: refusals[0] }
  }
}

try {
  await gw.connect()
  await cindy.connect()

  console.log('1) refusals come back with their reason')
  const denied = await attempt(tmpl(1984))
  assert(!denied.ok && denied.refusal?.code === 'denied' && denied.message.includes('not in any tier'), `kind not allowed: 'denied' with the reason (${denied.ok ? '' : denied.message})`)
  assert(denied.ms < SUB_TIMEOUT / 2,                                   `answered at once, not after the ${SUB_TIMEOUT} ms timeout (${denied.ms} ms)`)

  const profile = tmpl(0, '{"name":"pumpkin"}')
  const t_hold = Date.now()
  const held = await attempt(profile)
  assert(!held.ok && held.refusal?.code === 'held' && Math.abs((held.refusal.unlock_at ?? 0) - (t_hold + DELAY_MS)) < 1500, 'first sighting of a delay-gated event: \'held\' with this node\'s unlock time')
  const locked = await attempt(profile)
  assert(!locked.ok && locked.refusal?.code === 'locked' && locked.refusal.unlock_at === held.refusal?.unlock_at && locked.message.includes('still locked until'), 'asked again too early: \'locked\', same unlock time, "still locked until …"')
  await sleep(Math.max(0, (held.refusal?.unlock_at ?? 0) - Date.now()) + 200)
  assert((await attempt(profile)).ok,                                   'after the unlock time it signs')

  for (let i = 0; i < 3; i++) await attempt(tmpl(1))
  const limited = await attempt(tmpl(1))
  assert(!limited.ok && limited.refusal?.code === 'rate_limited' && (limited.refusal.retry_at ?? 0) > Date.now(), '4th note in the hour: \'rate_limited\' with when to retry')

  const vetoed_tmpl = tmpl(0, '{"name":"vetoed"}')
  await attempt(vetoed_tmpl)
  const vid = policy.held().map(([ id ]) => id).pop()!
  policy.veto(vid, Date.now())
  const vetoed = await attempt(vetoed_tmpl)
  assert(!vetoed.ok && vetoed.refusal?.code === 'vetoed',               'vetoed event: \'vetoed\'')

  console.log('2) the share node lost its nonces; the requester still holds stale ones')
  policy = new Policy(cfg)                                              // fresh limits for the rest
  await close_node(cindy); cindy = mk_cindy(); await cindy.connect()
  await attempt(tmpl(1))                                                // settle nonces after the swap
  drop_cindy_nonces()
  assert(gw.pool.can_sign(cindy_idx),                                   'the requester thinks it can sign (stale nonces)')
  nonce_refusals = 0
  const resynced = await attempt(tmpl(1))
  assert(resynced.ok,                                                   `refused with 'nonce', resynced, retried once: signed (${resynced.ok ? 'ok' : resynced.message})`)
  assert(nonce_refusals === 1,                                          `exactly one nonce refusal on the way (${nonce_refusals})`)

  console.log('3) an unlocked held event survives the nonce loss')
  const later = tmpl(0, '{"name":"later"}')
  await attempt(later)
  await sleep(DELAY_MS + 300)
  drop_cindy_nonces()
  const before_entry = { ...policy.held().find(([ , e ]) => e.summary.includes('later'))![1] }
  const unlocked = await attempt(later)
  const after_entry = policy.held().find(([ , e ]) => e.summary.includes('later'))?.[1]
  assert(unlocked.ok,                                                   `unlocked held event signs despite the stale nonce (${unlocked.ok ? 'ok' : unlocked.message})`)
  assert(after_entry?.allowed_at !== undefined && after_entry.unlock === before_entry.unlock, 'and the node did not hold it a second time (same unlock, now allowed)')

  console.log('4) a restarted share node tells the requester to drop its nonces')
  attach_requester_resync(gw)
  policy = new Policy(cfg)                                              // fresh rate limit
  await close_node(cindy); cindy = mk_cindy(); await cindy.connect()
  await attempt(tmpl(1))
  assert(gw.pool.can_sign(cindy_idx),                                   'before the restart the requester holds nonces')
  await close_node(cindy); cindy = mk_cindy(); await cindy.connect()
  assert(await until(() => !gw.pool.can_sign(cindy_idx)),              'after the restart notice it dropped them')
  nonce_refusals = 0
  const after_restart = await attempt(tmpl(1))
  assert(after_restart.ok && nonce_refusals === 0,                      `first signature after the restart: signed without a nonce refusal (${after_restart.ok ? 'ok' : after_restart.message}; ${nonce_refusals})`)
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  await Promise.allSettled([ close_node(gw), close_node(cindy) ])
  await relay.close()
  process.exit()
}
