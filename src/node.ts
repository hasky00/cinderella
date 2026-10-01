/**
 * Cinderella share node.
 *
 * Runs ONE share as a bifrost signer with the Cinderella policy attached.
 * This is the drop-in replacement for "Start signer" in Igloo.
 */

import { readFileSync }   from 'node:fs'
import { dirname, join }  from 'node:path'
import { nip19 }          from 'nostr-tools'
import { decode_group_package, decode_share_package } from '@frostr/bifrost/encoder'
import { Policy }         from './policy.js'
import { create_share_node } from './share-node.js'
import { load_policy_state, save_policy_state } from './state.js'
import { load_or_create_alert_key } from './alerts.js'
import { VetoController, mark_veto_disabled, resolve_veto_config } from './veto.js'
import { install_rejection_guard } from './guards.js'
import { assert_websocket } from './relay-feed.js'
import type { CinderellaConfig } from './policy.js'

const env = (k : string, d? : string) => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

const cfg : CinderellaConfig = JSON.parse(readFileSync(env('CINDERELLA_CONFIG', './cinderella.config.json'), 'utf8'))

const log = (lvl : string, m : string) => console.log(`[${new Date().toISOString()}] ${lvl.padEnd(5)} ${m}`)

// One bad event or a missed rejection must never take the node down.
install_rejection_guard(log)
try {
  assert_websocket()
} catch (err) {
  log('deny', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// Counters, held events and vetoes survive restarts (see state.ts).
const state_path = env('CINDERELLA_STATE', './cinderella.state.json')
const state      = load_policy_state(state_path)

// Veto (see veto.ts): alerts to a phone-only veto key, vetoes back from it.
let veto : VetoController | null = null
if (cfg.veto) {
  const veto_cfg = resolve_veto_config(cfg.veto)          // throws: invalid npub, < 2 alert relays, …
  const key_path = env('CINDERELLA_ALERT_KEY', join(dirname(state_path), 'cinderella.alert.key'))
  const key      = load_or_create_alert_key(key_path)
  veto = new VetoController({ config: veto_cfg, key, log })
  log('info', `${key.created ? 'created' : 'loaded'} alert key ${key_path}; add this npub as a contact on your veto phone: ${nip19.npubEncode(key.pubkey)}`)
} else {
  log('info', 'no veto configured: held events are signed after their delay without an alert')
}

const policy = new Policy(cfg, {
  state,
  on_change : s => save_policy_state(state_path, s),
  ...(veto ? veto.policy_options() : {})
})
// Without veto: forget the veto key, so re-enabling it (even the same key) re-alerts held events.
if (!veto) mark_veto_disabled(policy)

const group  = decode_group_package(env('CINDERELLA_GROUP'))
const share  = decode_share_package(env('CINDERELLA_SHARE'))
const relays = env('CINDERELLA_RELAYS').split(',').map((s : string) => s.trim()).filter(Boolean)

const node = create_share_node(group, share, relays, policy, log)

log('info', state
  ? `policy state loaded from ${state_path}: ${Object.keys(state.pending).length} held event(s), counters for ${Object.keys(state.history).length} tier(s)`
  : `no policy state at ${state_path}; starting with empty counters`)

node.on('ready',              ()  => log('info', `cinderella share ${share.idx} online on ${relays.join(', ')}`))
node.on('/sign/handler/req',  ()  => log('info', 'sign request received'))
// bifrost spreads its [reason, msg] tuple into separate listener arguments.
node.on('/sign/handler/rej',  (reason : unknown) => log('deny', `rejected: ${String(reason)}`))

if (veto) await veto.start(policy)
await node.connect()
