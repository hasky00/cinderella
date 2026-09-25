/**
 * Cinderella share node.
 *
 * Runs ONE share as a bifrost signer with the Cinderella policy attached.
 * This is the drop-in replacement for "Start signer" in Igloo.
 */

import { readFileSync }   from 'node:fs'
import { decode_group_package, decode_share_package } from '@frostr/bifrost/encoder'
import { Policy }         from './policy.js'
import { create_share_node } from './share-node.js'
import { load_policy_state, save_policy_state } from './state.js'
import type { CinderellaConfig } from './policy.js'

const env = (k : string, d? : string) => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

const cfg : CinderellaConfig = JSON.parse(readFileSync(env('CINDERELLA_CONFIG', './cinderella.config.json'), 'utf8'))

// Counters and held events survive restarts (see state.ts).
const state_path = env('CINDERELLA_STATE', './cinderella.state.json')
const state      = load_policy_state(state_path)
const policy     = new Policy(cfg, { state, on_change: s => save_policy_state(state_path, s) })

const group  = decode_group_package(env('CINDERELLA_GROUP'))
const share  = decode_share_package(env('CINDERELLA_SHARE'))
const relays = env('CINDERELLA_RELAYS').split(',').map((s : string) => s.trim()).filter(Boolean)

const log = (lvl : string, m : string) => console.log(`[${new Date().toISOString()}] ${lvl.padEnd(5)} ${m}`)

const node = create_share_node(group, share, relays, policy, log)

log('info', state
  ? `policy state loaded from ${state_path}: ${Object.keys(state.pending).length} held event(s), counters for ${Object.keys(state.history).length} tier(s)`
  : `no policy state at ${state_path}; starting with empty counters`)

node.on('ready',              ()  => log('info', `cinderella share ${share.idx} online on ${relays.join(', ')}`))
node.on('/sign/handler/req',  ()  => log('info', 'sign request received'))
// bifrost spreads its [reason, msg] tuple into separate listener arguments.
node.on('/sign/handler/rej',  (reason : unknown) => log('deny', `rejected: ${String(reason)}`))

await node.connect()
