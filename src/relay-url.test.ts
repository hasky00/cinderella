/**
 * Relay URLs written two ways: `wss://host` in veto.alert_relays and
 * `wss://host/` in the phone's kind 10050 (Amethyst adds the slash).
 *
 * nostr-tools' pool normalizes URLs and rejects the second spelling of a relay
 * as "duplicate url", so an alert accepted as `wss://host` never matched the
 * inbox entry `wss://host/`: never counted as delivered, re-sent every minute
 * with a new unlock time, its delay never started.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { join }        from 'node:path'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import type { Event as NostrToolsEvent } from 'nostr-tools'
import { load_or_create_alert_key } from './alerts.js'
import type { HeldEntry } from './policy.js'
import { VetoController, resolve_veto_config } from './veto.js'
import { TestRelay } from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }

const r1 = new TestRelay(); await r1.start()
const r2 = new TestRelay(); await r2.start()
const bare    = [ r1.url, r2.url ]                   // ws://127.0.0.1:port
const slashed = bare.map(u => u + '/')               // ws://127.0.0.1:port/

const dir = mkdtempSync(join(tmpdir(), 'cinderella-relay-url-'))

async function publish (relays : string[], ev : NostrToolsEvent) {
  const pool = new SimplePool()
  await Promise.allSettled(pool.publish(relays, ev))
  pool.close(relays)
}

/** A veto key whose kind 10050 lists `inbox`; one alert from a node with `alert_relays`. */
async function alert_with (name : string, alert_relays : string[], inbox : string[]) {
  const phone = generateSecretKey()
  await publish(bare, finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), tags: inbox.map(r => [ 'relay', r ]), content: '' }, phone))
  const logs : string[] = []
  const config = resolve_veto_config({ pubkey: getPublicKey(phone), alert_relays, node_count: 1 })
  const veto   = new VetoController({ config, key: load_or_create_alert_key(join(dir, `${name}.alert.key`)), log: (l, m) => logs.push(`${l}: ${m}`) })
  const entry  : HeldEntry = { held_at: Date.now(), unlock: null, kind: 0, delay_hours: 24, summary: 'test' }
  try {
    return { delivered: await veto.alert('ab'.repeat(32), entry), logs }
  } finally {
    veto.stop()
  }
}

try {
  console.log('1) inbox list with trailing slashes, alert relays without')
  {
    const { delivered, logs } = await alert_with('a', bare, slashed)
    assert(delivered,                                         'alert counts as delivered to the veto key\'s inbox')
    assert(!logs.some(l => l.includes('duplicate url')),      'no relay rejected as "duplicate url"')
  }

  console.log('2) alert relays with trailing slashes, inbox list without')
  {
    const { delivered, logs } = await alert_with('b', slashed, bare)
    assert(delivered,                                         'alert counts as delivered to the veto key\'s inbox')
    assert(!logs.some(l => l.includes('duplicate url')),      'no relay rejected as "duplicate url"')
  }

  console.log('3) one relay written two ways is one alert relay')
  {
    let threw = ''
    try { resolve_veto_config({ pubkey: getPublicKey(generateSecretKey()), alert_relays: [ 'wss://nos.lol', 'wss://nos.lol/' ], node_count: 1 }) } catch (e) { threw = String(e) }
    assert(threw.includes('at least 2 relays'),               'wss://nos.lol and wss://nos.lol/ do not count as 2 relays')
  }
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  try { await r1.close() } catch {}
  try { await r2.close() } catch {}
  process.exit()
}
