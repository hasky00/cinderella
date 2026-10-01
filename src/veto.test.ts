/**
 * Veto end to end: real bifrost nodes, two local relays, a test "phone"
 * (the veto key) and a test Gateway notice key.
 *
 *  1. a held profile change alerts the phone (full id, unlock time); the delay
 *     starts on delivery
 *  2. `veto <id>` from the phone: confirmed, the Gateway is told, and the event
 *     is refused even after its unlock
 *  3. a veto from another npub changes nothing (that event is signed later)
 *  4. vetoes for an unknown id and for an already-signed event are ignored
 *  5. a veto sent while the node is offline is applied after it restarts
 *  6. alerts that reach no relay: the delay never starts (fail-closed)
 *  7. veto key changed (phone lost): the new key gets every held event again
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { join }        from 'node:path'
import { BifrostNode, Lib } from '@frostr/bifrost'
import { SimplePool, generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import type { Event as NostrToolsEvent } from 'nostr-tools'
import { Policy }            from './policy.js'
import type { CinderellaConfig } from './policy.js'
import { create_share_node } from './share-node.js'
import { cinderella_sign }   from './request.js'
import { close_node, single_flight_pings } from './resync.js'
import { load_policy_state, save_policy_state } from './state.js'
import { load_or_create_alert_key } from './alerts.js'
import { VetoController, resolve_veto_config, unwrap_verified } from './veto.js'
import { TestRelay }         from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const sleep  = (ms : number) => new Promise(r => setTimeout(r, ms))
async function until (check : () => boolean, ms = 8000) : Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await sleep(100) }
  return check()
}

const r1 = new TestRelay(); await r1.start()
const r2 = new TestRelay(); await r2.start()
const relays = [ r1.url, r2.url ]

const { group, shares } = Lib.generate_dealer_package(2, 3)
const opts = { node_config: { msg_timeout: 2000, sub_timeout: 2000 } }
const DELAY_H = 0.001                                    // 3.6 s

const phone = generateSecretKey(), phone2 = generateSecretKey(), thief = generateSecretKey(), gw_notice = generateSecretKey()
const dir   = mkdtempSync(join(tmpdir(), 'cinderella-veto-'))
const state_path = join(dir, 'cinderella.state.json')
const key_path   = join(dir, 'cinderella.alert.key')

const cfg_for = (veto_pk : Uint8Array, alert_relays = relays) : CinderellaConfig => ({
  version: 1, default_tier: 'deny', require_content: true,
  tiers: { daily: { kinds: [ 1, 7 ] }, identity: { kinds: [ 0 ], delay_hours: DELAY_H } },
  veto: { pubkey: getPublicKey(veto_pk), alert_relays, gateway_pubkey: getPublicKey(gw_notice) }
})

// The node exactly as node.ts wires it.
async function start_node (veto_pk : Uint8Array, alert_relays = relays, path = state_path, kpath = key_path) {
  const cfg    = cfg_for(veto_pk, alert_relays)
  const veto   = new VetoController({ config: resolve_veto_config(cfg.veto!), key: load_or_create_alert_key(kpath), retry_ms: 1000 })
  const policy = new Policy(cfg, { state: load_policy_state(path), on_change: s => save_policy_state(path, s), ...veto.policy_options() })
  const node   = create_share_node(group, shares[1], relays, policy, () => {}, opts)
  await veto.start(policy)
  await node.connect()
  return { veto, policy, node }
}

// Inbox of a test key: every NIP-17 DM addressed to it, sender verified.
function inbox (sk : Uint8Array) {
  const pool = new SimplePool()
  const msgs : { sender : string, content : string }[] = []
  const seen = new Set<string>()
  pool.subscribeMany(relays, { kinds: [ 1059 ], '#p': [ getPublicKey(sk) ] }, {
    onevent: (ev : NostrToolsEvent) => {
      if (seen.has(ev.id)) return
      seen.add(ev.id)
      const m = unwrap_verified(ev, sk)
      if (m) msgs.push({ sender: m.sender, content: m.content })
    }
  })
  return { msgs, close: () => pool.close(relays) }
}

async function dm (from : Uint8Array, to : string, text : string) {
  const pool = new SimplePool()
  await Promise.allSettled(pool.publish(relays, nip17.wrapEvent(from, { publicKey: to }, text)))
  pool.close(relays)
}

const gateway = new BifrostNode(group, shares[0], relays, opts)
single_flight_pings(gateway)
const now_s = () => Math.floor(Date.now() / 1000)
const profile = (name : string) => ({ kind: 0, created_at: now_s(), tags: [], content: JSON.stringify({ name }) })
const signs = async (tmpl : ReturnType<typeof profile>) => { try { await cinderella_sign(gateway, tmpl); return true } catch { return false } }

const phone_inbox = inbox(phone)
const gw_inbox    = inbox(gw_notice)
let n = await start_node(phone)
await gateway.connect()
const alert_pk = n.veto.alert_pubkey

try {
  console.log('1) alert')
  const pumpkin = profile('pumpkin')
  assert(!(await signs(pumpkin)),                                     'profile change is held, not signed')
  const id1 = n.policy.held()[0]?.[0] ?? ''
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`veto ${id1}`))), 'phone got the alert with the full event id')
  const alert = phone_inbox.msgs.find(m => m.content.includes(`veto ${id1}`))!
  assert(alert.sender === alert_pk && alert.content.includes('name: pumpkin') && /Unlocks \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(alert.content),
                                                                       'alert: from the node, shows the name and the unlock time')
  assert(await until(() => n.policy.held().find(([ id ]) => id === id1)?.[1].unlock !== null), 'delivered, so the delay started')

  console.log('2) veto')
  await dm(phone, alert_pk, `veto ${id1}`)
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`vetoed ${id1}`))), 'phone got "vetoed" back')
  assert(await until(() => gw_inbox.msgs.some(m => m.content.includes('"cinderella-veto"') && m.content.includes(id1))), 'Gateway notice key was told')
  await sleep(DELAY_H * 3_600_000 + 500)
  assert(!(await signs(pumpkin)),                                     'vetoed event refused after its unlock')

  console.log('3) a veto from another npub')
  const second = profile('second')
  await signs(second)
  const id2 = n.policy.held().find(([ , e ]) => e.summary.includes('second'))?.[0] ?? ''
  await until(() => n.policy.held().find(([ id ]) => id === id2)?.[1].unlock !== null)
  await dm(thief, alert_pk, `veto ${id2}`)
  await sleep(1500)
  assert(n.policy.held().some(([ id ]) => id === id2),                'thief veto changed nothing (still held)')
  assert(!phone_inbox.msgs.some(m => m.content.includes(`vetoed ${id2}`)), 'and was not confirmed')
  await sleep(DELAY_H * 3_600_000 + 500)
  assert(await signs(second),                                         'not vetoed: signed after its unlock')

  console.log('4) ignored vetoes')
  await dm(phone, alert_pk, `veto ${'cd'.repeat(32)}`)
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`ignored ${'cd'.repeat(32)}: not held`))), 'unknown id: ignored, phone told')
  await dm(phone, alert_pk, `veto ${id2}`)
  assert(await until(() => phone_inbox.msgs.some(m => m.content.includes(`ignored ${id2}: already signed`))), 'already-signed id: ignored, phone told')

  console.log('5) veto while the node is offline')
  const third = profile('third')
  await signs(third)
  const id3 = n.policy.held().find(([ , e ]) => e.summary.includes('third'))?.[0] ?? ''
  await until(() => n.policy.held().find(([ id ]) => id === id3)?.[1].unlock !== null)
  n.veto.stop(); await close_node(n.node)
  await dm(phone, alert_pk, `veto ${id3}`)                             // node is down
  n = await start_node(phone)
  assert(await until(() => n.veto.ready),                             'restarted node caught up on the veto feed')
  assert(await until(() => !n.policy.held().some(([ id ]) => id === id3)), 'veto sent while offline was applied')
  await sleep(DELAY_H * 3_600_000 + 500)
  assert(!(await signs(third)),                                       'and the event is refused after its unlock')

  console.log('6) alerts reach no relay')
  const dead = await start_node(phone, [ 'ws://127.0.0.1:1', 'ws://127.0.0.1:2' ], join(dir, 'dead.state.json'), join(dir, 'dead.alert.key'))
  const blocked = profile('blocked')
  const ev0 = { ...blocked, pubkey: group.group_pk.slice(-64), id: 'x'.repeat(64) }
  dead.policy.evaluate(ev0)
  await sleep(2500)
  const entry = dead.policy.held()[0]?.[1]
  assert(entry?.unlock === null,                                      'no relay accepted the alert: delay not started')
  assert(!dead.policy.evaluate(ev0, Date.now() + 3_600_000).ok,       'and nothing is signed, even long after')
  dead.veto.stop(); await close_node(dead.node)

  console.log('7) veto key changed')
  const fourth = profile('fourth')
  await signs(fourth)
  const id4 = n.policy.held().find(([ , e ]) => e.summary.includes('fourth'))?.[0] ?? ''
  n.veto.stop(); await close_node(n.node)
  const phone2_inbox = inbox(phone2)
  n = await start_node(phone2)
  assert(await until(() => phone2_inbox.msgs.some(m => m.content.includes('now the veto key'))), 'new key told it is the veto key')
  assert(await until(() => phone2_inbox.msgs.some(m => m.content.includes(`veto ${id4}`))),     'new key got the alert for the held event')
  await dm(phone, alert_pk, `veto ${id4}`)
  await sleep(1500)
  assert(n.policy.held().some(([ id ]) => id === id4),                'old key can no longer veto')
  await dm(phone2, alert_pk, `veto ${id4}`)
  assert(await until(() => !n.policy.held().some(([ id ]) => id === id4)), 'new key can')
  phone2_inbox.close()
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  phone_inbox.close(); gw_inbox.close()
  n.veto.stop()
  await Promise.allSettled([ close_node(gateway), close_node(n.node) ])
  await r1.close(); await r2.close()
  process.exit()
}
