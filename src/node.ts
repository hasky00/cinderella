/**
 * Cinderella share node.
 *
 * Runs ONE share as a bifrost signer with the Cinderella policy attached.
 * This is the drop-in replacement for "Start signer" in Igloo.
 */

import { readFileSync }   from 'node:fs'
import { BifrostNode }    from '@frostr/bifrost'
import { decode_group_package, decode_share_package } from '@frostr/bifrost/encoder'
import { Policy }         from './policy.js'
import { cinderella_middleware } from './middleware.js'
import type { CinderellaConfig } from './policy.js'

const env = (k : string, d? : string) => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

const cfg : CinderellaConfig = JSON.parse(readFileSync(env('CINDERELLA_CONFIG', './cinderella.config.json'), 'utf8'))
const policy = new Policy(cfg)

const group  = decode_group_package(env('CINDERELLA_GROUP'))
const share  = decode_share_package(env('CINDERELLA_SHARE'))
const relays = env('CINDERELLA_RELAYS').split(',').map((s : string) => s.trim()).filter(Boolean)

const log = (lvl : string, m : string) => console.log(`[${new Date().toISOString()}] ${lvl.padEnd(5)} ${m}`)

const node = new BifrostNode(group, share, relays, {
  middleware : { sign : cinderella_middleware(policy, log) }
})

node.on('ready',              ()  => log('info', `cinderella share ${share.idx} online on ${relays.join(', ')}`))
node.on('/sign/handler/req',  ()  => log('info', 'sign request received'))
node.on('/sign/handler/rej',  (r : any) => log('deny', `rejected: ${String(r?.[0] ?? r)}`))

await node.connect()
