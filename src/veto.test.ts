/**
 * Veto end to end: real bifrost nodes, local relays, a test "phone" (the veto
 * key) and a test Gateway notice key.
 *
 *   r0      bifrost signing
 *   r1, r2  alert relays (vetoes, alerts, the nodes' DM inbox)
 *   r3      the phone's own DM inbox, announced in its kind 10050 only
 *
 *  1. a held profile change alerts the phone ON ITS INBOX RELAY (full id, unlock
 *     time); the alert is a group DM with the veto key and the other node
 *  2. ONE veto reply in that group vetoes on both nodes; the Gateway is told;
 *     the event is refused after its unlock
 *  3. a veto from another npub, a forged seal: no effect, not recorded as seen
 *  4. unknown and already-signed ids are ignored (with a reply)
 *  5. catch-up counts only with a live relay that sent a real EOSE
 *  6. all relays drop: not caught up, unlocked held events refused, the
 *     catch-up point stays put; relays back: resubscribed, vetoes work again
 *  7. veto key changed: delays restart from the new key's alert
 *  8. veto enabled on a node that already holds events: alerted, delays restart
 *  9. alerts that reach no relay: the delay never starts (fail-closed)
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { join }        from 'node:path'
import { BifrostNode, Lib } from '@frostr/bifrost'
import { SimplePool, finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44 } from 'nostr-tools'
import type { Event as NostrToolsEvent } from 'nostr-tools'
import { Policy }            from './policy.js'
import type { CinderellaConfig } from './policy.js'
import { create_share_node } from './share-node.js'
import { cinderella_sign }   from './request.js'
import { close_node, single_flight_pings } from './resync.js'
import { load_policy_state, save_policy_state } from './state.js'
import { load_or_create_alert_key, wrap_group } from './alerts.js'
import { VetoController, resolve_veto_config, unwrap_verified } from './veto.js'
import { TestRelay }         from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const sleep  = (ms : number) => new Promise(r => setTimeout(r, ms))
async function until (check : () => boolean, ms = 8000) : Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await sleep(100) }
  return check()
}

const r0 = new TestRelay(); await r0.start()
const r1 = new TestRelay(); await r1.start()
const r2 = new TestRelay(); await r2.start()
const r3 = new TestRelay(); await r3.start()
const alert_relays = [ r1.url, r2.url ]
const port_of = (url : string) => Number(new URL(url).port)

const { group, shares } = Lib.generate_dealer_package(2, 3)
const opts    = { node_config: { msg_timeout: 2000, sub_timeout: 2000 } }
const DELAY_H = 0.001                                    // 3.6 s
const DELAY_MS = DELAY_H * 3_600_000

const phone = generateSecretKey(), phone2 = generateSecretKey(), thief = generateSecretKey(), gw_notice = generateSecretKey()
const dir = mkdtempSync(join(tmpdir(), 'cinderella-veto-'))
const paths = (name : string) => ({ state: join(dir, `${name}.state.json`), key: join(dir, `${name}.alert.key`) })
const A = paths('a'), B = paths('b')
const a_pk = load_or_create_alert_key(A.key).pubkey
const b_pk = load_or_create_alert_key(B.key).pubkey

const tiers = { daily: { kinds: [ 1, 7 ] }, identity: { kinds: [ 0 ], delay_hours: DELAY_H } }
const cfg_for = (veto_pk : Uint8Array, peers : string[], relays = alert_relays) : CinderellaConfig => ({
  version: 1, default_tier: 'deny', require_content: true, tiers,
  veto: { pubkey: getPublicKey(veto_pk), alert_relays: relays, gateway_pubkey: getPublicKey(gw_notice), peer_alert_pubkeys: peers }
})

// A share node exactly as node.ts wires it.
async function start_node (share : typeof shares[number], p : { state : string, key : string }, veto_pk : Uint8Array, peers : string[], relays = alert_relays) {
  const cfg    = cfg_for(veto_pk, peers, relays)
  const veto   = new VetoController({ config: resolve_veto_config(cfg.veto!), key: load_or_create_alert_key(p.key), retry_ms: 1000, backoff_ms: { min: 200, max: 1000 } })
  const policy = new Policy(cfg, { state: load_policy_state(p.state), on_change: s => save_policy_state(p.state, s), ...veto.policy_options() })
  const node   = create_share_node(group, share, [ r0.url ], policy, () => {}, opts)
  await veto.start(policy)
  await node.connect()
  return { veto, policy, node }
}
async function stop_node (n : Awaited<ReturnType<typeof start_node>>) { n.veto.stop(); await close_node(n.node) }

/** Open a wrap fully (for checks of the group's members). */
function rumor_of (wrap : NostrToolsEvent, sk : Uint8Array) : { pubkey : string, tags : string[][], content : string } {
  const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey)))
  return JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey)))
}

// Inbox of a test key on given relays: verified sender, plus the group members.
function inbox (sk : Uint8Array, relays : string[]) {
  const pool = new SimplePool()
  const msgs : { sender : string, content : string, members : string[] }[] = []
  const seen = new Set<string>()
  pool.subscribeMany(relays, { kinds: [ 1059 ], '#p': [ getPublicKey(sk) ] }, {
    onevent: (ev : NostrToolsEvent) => {
      if (seen.has(ev.id)) return
      seen.add(ev.id)
      const m = unwrap_verified(ev, sk)
      if (m) msgs.push({ sender: m.sender, content: m.content, members: rumor_of(ev, sk).tags.filter(t => t[0] === 'p').map(t => t[1]!) })
    }
  })
  return { msgs, close: () => pool.close(relays) }
}

async function publish (relays : string[], ev : NostrToolsEvent) {
  const pool = new SimplePool()
  await Promise.allSettled(pool.publish(relays, ev))
  pool.close(relays)
}
/** A reply in the group with the nodes; returns the wraps (by recipient). */
async function reply (from : Uint8Array, to : string[], text : string) {
  const wraps = wrap_group(from, to, text)
  await Promise.all([ ...wraps.values() ].map(w => publish(alert_relays, w)))
  return wraps
}

// The phone announces its DM inbox: r3 only.
await publish(alert_relays, finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), tags: [[ 'relay', r3.url ]], content: '' }, phone))

const gateway = new BifrostNode(group, shares[0], [ r0.url ], opts)
single_flight_pings(gateway)
const now_s   = () => Math.floor(Date.now() / 1000)
const profile = (name : string) => ({ kind: 0, created_at: now_s(), tags: [], content: JSON.stringify({ name }) })
const event_of = (t : ReturnType<typeof profile>) => { const e = { ...t, pubkey: group.group_pk.slice(-64), id: '' }; e.id = getEventHash(e); return e }
const ask = async (t : ReturnType<typeof profile>, peer : string) => { try { await cinderella_sign(gateway, t, { peers: [ peer ] }); return true } catch { return false } }

const phone_inbox = inbox(phone, [ r3.url ])                 // the phone listens on its inbox relay only
const gw_inbox    = inbox(gw_notice, alert_relays)
let a = await start_node(shares[1], A, phone, [ b_pk ])
let b = await start_node(shares[2], B, phone, [ a_pk ])
await gateway.connect()

try {
  console.log('1) alert: group DM, on the phone\'s inbox relay')
  const pumpkin = profile('pumpkin'), id1 = event_of(pumpkin).id
  await ask(pumpkin, a.node.pubkey); await ask(pumpkin, b.node.pubkey)
  assert(a.policy.held().some(([ id ]) => id === id1) && b.policy.held().some(([ id ]) => id === id1), 'held on both nodes')
  assert(await until(() => phone_inbox.msgs.some(m => m.sender === a_pk && m.content.includes(`veto ${id1}`))), 'phone got node A\'s alert on r3 (its kind 10050 inbox)')
  const alert = phone_inbox.msgs.find(m => m.sender === a_pk && m.content.includes(`veto ${id1}`))!
  assert(alert.content.includes('name: pumpkin') && /Unlocks \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(alert.content), 'alert shows the name and the unlock time')
  assert(alert.members.includes(getPublicKey(phone)) && alert.members.includes(b_pk), 'alert is a group DM: veto key and the other node')
  assert(await until(() => [ a, b ].every(n => n.policy.held().find(([ id ]) => id === id1)?.[1].unlock !== null)), 'delivered: delay started on both nodes')

  console.log('2) one veto reply vetoes everywhere')
  await reply(phone, [ a_pk, b_pk ], `veto ${id1}`)
  assert(await until(() => [ a, b ].every(n => !n.policy.held().some(([ id ]) => id === id1))), 'ONE reply vetoed it on node A and node B')
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`vetoed ${id1}`))), 'phone got "vetoed" back')
  assert(await until(() => gw_inbox.msgs.some(m => m.content.includes('"cinderella-veto"') && m.content.includes(id1))), 'Gateway notice key was told')
  await sleep(DELAY_MS + 500)
  assert(!(await ask(pumpkin, a.node.pubkey)) && !(await ask(pumpkin, b.node.pubkey)), 'refused by both nodes after the unlock')

  console.log('3) other senders: no effect, not recorded')
  const second = profile('second'), id2 = event_of(second).id
  await ask(second, a.node.pubkey)
  await until(() => a.policy.held().find(([ id ]) => id === id2)?.[1].unlock !== null)
  const thief_wraps = await reply(thief, [ a_pk ], `veto ${id2}`)
  const rumor : any = { kind: 14, created_at: now_s(), tags: [[ 'p', a_pk ]], content: `veto ${id2}`, pubkey: getPublicKey(phone) }
  rumor.id = getEventHash(rumor)
  const seal = finalizeEvent({ kind: 13, created_at: rumor.created_at, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(thief, a_pk)) }, thief)
  const tk = generateSecretKey()
  const forged = finalizeEvent({ kind: 1059, created_at: rumor.created_at, tags: [[ 'p', a_pk ]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(tk, a_pk)) }, tk)
  await publish(alert_relays, forged)
  await sleep(1500)
  assert(a.policy.held().some(([ id ]) => id === id2),               'thief and forged vetoes changed nothing')
  const seen = a.policy.get_meta<Record<string, number>>('veto_seen_wraps') ?? {}
  assert(!seen[thief_wraps.get(a_pk)!.id] && !seen[forged.id],        'neither was recorded as seen')
  const genuine = await reply(phone, [ a_pk, b_pk ], `veto ${'cd'.repeat(32)}`)
  assert(await until(() => !!(a.policy.get_meta<Record<string, number>>('veto_seen_wraps') ?? {})[genuine.get(a_pk)!.id]), 'a verified message from the veto key is recorded')

  console.log('4) ignored vetoes')
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`ignored ${'cd'.repeat(32)}: not held`))), 'unknown id: ignored, phone told')
  await sleep(DELAY_MS + 500)
  assert(await ask(second, a.node.pubkey),                            'not vetoed: signed after its unlock')
  await reply(phone, [ a_pk, b_pk ], `veto ${id2}`)
  assert(await until(() => phone_inbox.msgs.some(m => m.sender === a_pk && m.content.includes(`ignored ${id2}: already signed`))), 'already-signed id: ignored, phone told')

  console.log('5) catch-up needs a live relay with a real EOSE')
  const dead = await start_node(shares[1], paths('dead'), phone, [], [ 'ws://127.0.0.1:1', 'ws://127.0.0.1:2' ])
  await sleep(12_000)                                                  // longer than nostr-tools' 10 s fake-EOSE timeout
  assert(!dead.veto.ready,                                            'no relay reachable: never counts as caught up')
  const blocked = event_of(profile('blocked'))
  dead.policy.evaluate(blocked)
  assert(dead.policy.held()[0]?.[1].unlock === null,                  'alert reached no relay: delay not started (fail-closed)')
  assert(!dead.policy.evaluate(blocked, Date.now() + 3_600_000).ok,   'nothing signed, even long after')
  await stop_node(dead)

  console.log('6) all relays drop, then come back')
  const third = event_of(profile('third'))
  a.policy.evaluate(third)
  await until(() => a.policy.held().find(([ id ]) => id === third.id)?.[1].unlock !== null)
  await sleep(DELAY_MS + 200)
  assert(a.veto.ready,                                                'caught up before the drop')
  await r1.close(); await r2.close()
  assert(await until(() => !a.veto.ready),                            'all relays gone: not caught up')
  const seen_until_at_drop = a.policy.get_meta<number>('veto_seen_until')!
  const during = a.policy.evaluate(third)
  assert(!during.ok && during.reason.includes('catching up'),         'unlocked held event refused while there is no live feed')
  await sleep(2500)
  assert(a.policy.get_meta<number>('veto_seen_until') === seen_until_at_drop, 'catch-up point not advanced without a live subscription')
  await r1.start(port_of(alert_relays[0]!)); await r2.start(port_of(alert_relays[1]!))
  assert(await until(() => a.veto.ready, 15_000),                     'relays back: resubscribed and caught up again')
  await reply(phone, [ a_pk, b_pk ], `veto ${third.id}`)
  assert(await until(() => !a.policy.held().some(([ id ]) => id === third.id)), 'and a veto sent after reconnecting works')

  console.log('7) veto key changed: delays restart')
  const fourth = event_of(profile('fourth'))
  a.policy.evaluate(fourth)
  await until(() => a.policy.held().find(([ id ]) => id === fourth.id)?.[1].unlock !== null)
  const old_unlock = a.policy.held().find(([ id ]) => id === fourth.id)![1].unlock!
  await stop_node(a)
  const phone2_inbox = inbox(phone2, alert_relays)
  const t_rotate = Date.now()
  a = await start_node(shares[1], A, phone2, [ b_pk ])
  assert(await until(() => phone2_inbox.msgs.some(m => m.content.includes(`veto ${fourth.id}`))), 'new key got the alert for the held event')
  assert(await until(() => (a.policy.held().find(([ id ]) => id === fourth.id)?.[1].unlock ?? 0) >= t_rotate + DELAY_MS), 'its delay restarted from the new alert')
  assert(a.policy.held().find(([ id ]) => id === fourth.id)![1].unlock! > old_unlock, 'later than the old unlock')
  phone2_inbox.close()

  console.log('8) veto enabled on a node that already holds events')
  const C = paths('c')
  const plain = new Policy({ version: 1, default_tier: 'deny', require_content: true, tiers }, { on_change: s => save_policy_state(C.state, s) })
  const fifth = event_of(profile('fifth'))
  plain.evaluate(fifth)                                                // held without veto: unlock set at once
  await sleep(DELAY_MS + 200)
  const t_enable = Date.now()
  const c = await start_node(shares[1], C, phone, [])
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`veto ${fifth.id}`))), 'the already-held event was alerted')
  assert(await until(() => (c.policy.held().find(([ id ]) => id === fifth.id)?.[1].unlock ?? 0) >= t_enable + DELAY_MS), 'and its delay restarted from that alert')
  assert(!c.policy.evaluate(fifth).ok,                                'so it is not signed although its old delay had passed')
  await stop_node(c)
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  phone_inbox.close(); gw_inbox.close()
  await Promise.allSettled([ stop_node(a), stop_node(b), close_node(gateway) ])
  for (const r of [ r0, r1, r2, r3 ]) { try { await r.close() } catch { /* closed */ } }
  process.exit()
}
