/**
 * node.ts startup checks with veto on, run as the real entry point in a child
 * process (throwaway 2-of-3 group, no network needed for the refusals).
 *
 *  R1  this node's own alert key in peer_alert_pubkeys: refused
 *  R2  node_count above the group's share count: refused; below: logged, starts
 */

import { spawn }       from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { join }        from 'node:path'
import { Lib }         from '@frostr/bifrost'
import { encode_group_package, encode_share_package } from '@frostr/bifrost/encoder'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { load_or_create_alert_key } from './alerts.js'
import { check_node_setup, resolve_veto_config } from './veto.js'
import { TestRelay }   from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }

const dir      = mkdtempSync(join(tmpdir(), 'cinderella-startup-'))
const key_path = join(dir, 'cinderella.alert.key')
const own      = load_or_create_alert_key(key_path).pubkey
const other    = getPublicKey(generateSecretKey()), third = getPublicKey(generateSecretKey())
const phone    = getPublicKey(generateSecretKey())
const { group, shares } = Lib.generate_dealer_package(2, 3)
const alert_relays = [ 'ws://127.0.0.1:1', 'ws://127.0.0.1:2' ]

console.log('check_node_setup')
const setup = (node_count : number, peers : string[], size = 3) => {
  try { return { warn: check_node_setup(resolve_veto_config({ pubkey: phone, alert_relays, node_count, peer_alert_pubkeys: peers }), own, size), err: '' } }
  catch (e) { return { warn: [], err: String(e) } }
}
assert(setup(3, [ own, other ]).err.includes('own alert key'),        'R1: own alert key among the peers: refused')
assert(setup(3, [ other, third ]).err === '',                         'R1: only the other nodes: fine')
assert(setup(4, [ other, third, getPublicKey(generateSecretKey()) ]).err.includes('only 3 shares'), 'R2: node_count above the share count: refused')
assert(setup(3, [ other, third ]).warn.length === 0,                  'R2: node_count equal to the share count: no warning')
assert(setup(2, [ other ]).warn.some(w => w.includes('2 of 3')),      'R2: node_count below the share count: warned')

console.log('node.ts startup')
const relay = new TestRelay(); await relay.start()
/** Run node.ts; kill it after `timeout` ms if it hasn't exited by then. */
function run (name : string, veto : Record<string, unknown>, timeout = 8000) : Promise<{ status : number | null, signal : string | null, out : string }> {
  const config = join(dir, `${name}.config.json`)
  writeFileSync(config, JSON.stringify({
    version: 1, default_tier: 'deny', require_content: true,
    tiers: { identity: { kinds: [ 0 ], delay_hours: 24 } },
    veto: { pubkey: phone, alert_relays, ...veto }
  }))
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), [ 'src/node.ts' ], {
    env: {
      ...process.env,
      CINDERELLA_CONFIG    : config,
      CINDERELLA_STATE     : join(dir, `${name}.state.json`),
      CINDERELLA_ALERT_KEY : key_path,
      CINDERELLA_GROUP     : encode_group_package(group),
      CINDERELLA_SHARE     : encode_share_package(shares[0]!),
      CINDERELLA_RELAYS    : relay.url,
    }
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const kill = setTimeout(() => child.kill('SIGTERM'), timeout)
  return new Promise(resolve => child.on('exit', (status, signal) => { clearTimeout(kill); resolve({ status, signal, out }) }))
}
const r1 = await run('own', { node_count: 3, peer_alert_pubkeys: [ own, other ] })
assert(r1.status === 1 && r1.out.includes('not starting') && r1.out.includes('own alert key'), `R1: own alert key as a peer: exits with a clear error (exit ${r1.status})`)
const r2 = await run('big', { node_count: 4, peer_alert_pubkeys: [ other, third, getPublicKey(generateSecretKey()) ] })
assert(r2.status === 1 && r2.out.includes('not starting') && r2.out.includes('only 3 shares'), `R2: node_count 4 in a 3-share group: exits with a clear error (exit ${r2.status})`)
const r3 = await run('small', { node_count: 2, peer_alert_pubkeys: [ other ] }, 5000)
const killed = r3.signal === 'SIGTERM' || r3.status === 143             // tsx passes the kill on as exit 128 + 15
assert(r3.out.includes('2 of 3 shares') && r3.out.includes('online') && !r3.out.includes('not starting') && killed, 'R2: node_count 2 in a 3-share group: warned, and the node starts and keeps running')
await relay.close()
