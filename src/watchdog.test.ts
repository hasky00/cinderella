/**
 * The share node's relay connection: startup without a reachable relay, and
 * a connection that dies while the node runs (as after the Mac slept).
 *
 *  1. probe: a live socket passes; a relay that stops answering (socket still
 *     open) fails the heartbeat; a slow answer within our timeout passes
 *     (the transport's own 5 s limit used to fail it: 7 restarts on 9 Oct);
 *     one missed heartbeat is rechecked, two in a row are death
 *  2. node.ts started while the relay is down: logs and retries, no crash;
 *     comes online once the relay is up
 *  3. node.ts running, relay drops the connection: exits with code 1 so the
 *     supervisor restarts it
 *  4. node.ts running, relay goes silent: the heartbeat catches it, exit 1
 */

import { spawn }       from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { join }        from 'node:path'
import { BifrostNode, Lib } from '@frostr/bifrost'
import { encode_group_package, encode_share_package } from '@frostr/bifrost/encoder'
import { probe_relay_link, watch_relay_link } from './watchdog.js'
import { close_node }  from './resync.js'
import { TestRelay }   from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const sleep  = (ms : number) => new Promise(r => setTimeout(r, ms))
async function until (check : () => boolean, ms = 10_000) : Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await sleep(100) }
  return check()
}

const { group, shares } = Lib.generate_dealer_package(2, 3)
const dir = mkdtempSync(join(tmpdir(), 'cinderella-watchdog-'))
const config = join(dir, 'config.json')
writeFileSync(config, JSON.stringify({ version: 1, default_tier: 'deny', require_content: true, tiers: { daily: { kinds: [ 1 ] } } }))

/** node.ts as a child process; resolves `exit` when it ends. */
function run_node (relay_url : string, name : string) {
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), [ 'src/node.ts' ], {
    env: {
      ...process.env,
      CINDERELLA_CONFIG      : config,
      CINDERELLA_STATE       : join(dir, `${name}.state.json`),
      CINDERELLA_GROUP       : encode_group_package(group),
      CINDERELLA_SHARE       : encode_share_package(shares[1]!),
      CINDERELLA_RELAYS      : relay_url,
      CINDERELLA_WATCHDOG_MS : '1000',
    }
  })
  const state = { out: '', code: null as number | null, done: false }
  child.stdout.on('data', d => { state.out += d })
  child.stderr.on('data', d => { state.out += d })
  child.on('exit', code => { state.code = code; state.done = true })
  return { state, kill: () => child.kill('SIGKILL') }
}

const relay = new TestRelay()
await relay.start()
const kids : { kill : () => void }[] = []

try {
  console.log('1) probe')
  const node = new BifrostNode(group, shares[0], [ relay.url ], { node_config: { msg_timeout: 2000, sub_timeout: 2000 } })
  await node.connect()
  assert(await probe_relay_link(node, 1500) === null,                  'live connection: heartbeat answered')
  relay.frozen = true
  const silent = await probe_relay_link(node, 1500)
  assert(typeof silent === 'string' && silent.includes('no answer'),   `relay stops answering: heartbeat fails (${silent})`)
  relay.frozen = false
  relay.slow_heartbeat_ms = 3000                                       // longer than the transport's own 2 s here
  const slow = await probe_relay_link(node, 6000)
  relay.slow_heartbeat_ms = 0
  assert(slow === null,                                                `a slow answer within our own timeout counts as alive (${slow})`)

  console.log('1b) one missed heartbeat is not death; two in a row are')
  const logs : string[] = []
  let died = ''
  const stop = watch_relay_link(node, { interval_ms: 1000, timeout_ms: 500, recheck_ms: 1000, log: m => logs.push(m), on_dead: r => { died = r } })
  relay.frozen = true
  assert(await until(() => logs.some(l => l.includes('heartbeat missed')), 5000), 'a missed heartbeat is logged and rechecked')
  relay.frozen = false
  await sleep(3000)
  assert(died === '',                                                  `answered again: the node lives (${died})`)
  relay.frozen = true
  assert(await until(() => died !== '', 8000) && died.includes('twice in a row'), `two misses in a row: dead (${died})`)
  relay.frozen = false
  stop()
  await close_node(node)

  // A socket that closed without the transport saying so: dead at once, not a "miss".
  const closed_node = {
    client : { is_ready: true, client: { sockets: [ { url: 'wss://gone.example', is_ready: false, subscribe: () => { throw new Error('closed') } } ] }, on: () => {}, off: () => {} },
  } as unknown as BifrostNode
  let closed_reason = ''
  const stop_closed = watch_relay_link(closed_node, { interval_ms: 200, timeout_ms: 500, recheck_ms: 5000, on_dead: r => { closed_reason = r } })
  assert(await until(() => closed_reason !== '', 2000) && !closed_reason.includes('twice'), `a closed socket is dead at the first heartbeat (${closed_reason})`)
  stop_closed()

  console.log('2) startup while the relay is down')
  const port = Number(new URL(relay.url).port)
  await relay.close()
  const a = run_node(relay.url, 'a'); kids.push(a)
  assert(await until(() => a.state.out.includes('signing relay unreachable')), 'logs that the relay is unreachable and retries')
  await sleep(2500)
  assert(!a.state.done && !a.state.out.includes('Error: connection failed'), 'and does not crash')
  await relay.start(port)
  assert(await until(() => a.state.out.includes('online'), 20_000),   'comes online once the relay is up')

  console.log('3) the relay drops the connection')
  await relay.close()
  assert(await until(() => a.state.done, 10_000) && a.state.code === 1, `exits with code 1 for the supervisor to restart (exit ${a.state.code})`)
  assert(a.state.out.includes('signing relay connection is dead'),     'and says why')

  console.log('4) the relay goes silent, socket still open')
  await relay.start(port)
  const b = run_node(relay.url, 'b'); kids.push(b)
  assert(await until(() => b.state.out.includes('online'), 15_000),   'online')
  relay.frozen = true
  assert(await until(() => b.state.done, 10_000) && b.state.code === 1, `heartbeat unanswered: exits with code 1 (exit ${b.state.code})`)
  assert(b.state.out.includes('heartbeat'),                            'and says the heartbeat went unanswered')
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  for (const k of kids) k.kill()
  try { await relay.close() } catch { /* closed */ }
  process.exit()
}
