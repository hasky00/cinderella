/**
 * The veto feed's relay connections (relay-feed.ts) and the node's crash guard.
 *
 *  N2  caught up only when EVERY relay is live and past its EOSE
 *  N3  a relay that goes silent (socket open, no answers) counts as dead
 *  N4  exponential backoff on CLOSED and on relays that drop at once; timers unref'd
 *  N5  a clear error without a global WebSocket; engines node >= 22
 *  N1  an unhandled rejection is logged, the process keeps running
 */

import { spawnSync }    from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir }       from 'node:os'
import { join }         from 'node:path'
import { RelayFeed }    from './relay-feed.js'
import { TestRelay }    from './test/relay.js'

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }
const sleep  = (ms : number) => new Promise(r => setTimeout(r, ms))
async function until (check : () => boolean, ms = 8000) : Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await sleep(50) }
  return check()
}
const feed = (relays : string[], extra : Partial<ConstructorParameters<typeof RelayFeed>[1]> = {}) =>
  new RelayFeed(relays, { filter: () => ({ kinds: [ 1059 ] }), onevent: () => {}, min_backoff_ms: 100, max_backoff_ms: 2000, ...extra })

const r1 = new TestRelay(); await r1.start()
const r2 = new TestRelay(); await r2.start()

try {
  console.log('N2) every relay must be caught up')
  const f = feed([ r1.url, r2.url ])
  f.start()
  assert(await until(() => f.all_caught_up),                          'both relays live and past EOSE: caught up')
  const p2 = Number(new URL(r2.url).port)
  await r2.close()
  assert(await until(() => !f.all_caught_up),                         'one relay down: not caught up')
  assert(f.caught_up_relays.length === 1 && f.caught_up_relays[0] === r1.url, 'the other relay still counts as caught up on its own')
  await r2.start(p2)
  assert(await until(() => f.all_caught_up),                          'relay back: caught up again')
  f.stop()

  console.log('N3) a silent relay is dead')
  const g = feed([ r1.url ], { idle_ms: 1500 })
  g.start()
  assert(await until(() => g.all_caught_up),                          'caught up')
  r1.frozen = true
  assert(await until(() => !g.all_caught_up, 5000),                   'no traffic for idle_ms: not caught up')
  await sleep(1000)
  assert(!g.all_caught_up,                                            'reconnected but still silent: still not caught up')
  r1.frozen = false
  assert(await until(() => g.all_caught_up, 8000),                    'relay answers again: caught up')
  g.stop()

  console.log('N4) backoff')
  const r3 = new TestRelay(); await r3.start()
  r3.close_every_req = true
  const h = feed([ r3.url ])
  h.start()
  await sleep(4000)
  h.stop()
  assert(r3.req_count <= 8,                                           `relay CLOSEs every REQ: ${r3.req_count} REQs in 4 s (exponential from 100 ms, not a loop)`)
  const r4 = new TestRelay(); await r4.start()
  r4.drop_on_connect = true
  const k = feed([ r4.url ])
  k.start()
  await sleep(4000)
  k.stop()
  assert(r4.conn_count <= 8,                                          `relay drops every connection: ${r4.conn_count} connects in 4 s (backoff not reset on open)`)
  await r3.close(); await r4.close()

  // A feed to an unreachable relay, never stopped: unref'd timers let the process exit.
  const dir = mkdtempSync(join(tmpdir(), 'cinderella-feed-'))
  const script = join(dir, 'leak.ts')
  writeFileSync(script, `import { RelayFeed } from ${JSON.stringify(join(process.cwd(), 'src/relay-feed.ts'))}
new RelayFeed([ 'ws://127.0.0.1:1' ], { filter: () => ({}), onevent: () => {} }).start()
setTimeout(() => console.log('still here'), 3000).unref()
`)
  const tsx = join(process.cwd(), 'node_modules/.bin/tsx')
  const run = spawnSync(tsx, [ script ], { timeout: 8000, encoding: 'utf8' })
  assert(run.status === 0 && run.signal === null,                     `a feed that is never stopped does not keep the process alive (exit ${run.status}, signal ${run.signal})`)

  console.log('N5) WebSocket and Node version')
  const saved = (globalThis as { WebSocket? : unknown }).WebSocket
  delete (globalThis as { WebSocket? : unknown }).WebSocket
  let msg = ''
  try { feed([ r1.url ]) } catch (e) { msg = String(e) }
  ;(globalThis as { WebSocket? : unknown }).WebSocket = saved
  assert(msg.includes('Node 22 or newer'),                            'no global WebSocket: clear error naming Node 22')
  const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
  assert(pkg.engines?.node === '>=22',                                'package.json engines: node >= 22')

  console.log('N1) a missed rejection does not crash the node')
  const guard = join(dir, 'guard.ts')
  writeFileSync(guard, `import { install_rejection_guard } from ${JSON.stringify(join(process.cwd(), 'src/guards.ts'))}
install_rejection_guard((l, m) => console.log(l, m.split('\\n')[0]))
void Promise.reject(new Error('boom'))
setTimeout(() => console.log('alive'), 300)
`)
  const g2 = spawnSync(tsx, [ guard ], { timeout: 8000, encoding: 'utf8' })
  assert(g2.status === 0 && g2.stdout.includes('alive'),              'process still alive after an unhandled rejection')
  assert(g2.stdout.includes('unhandled promise rejection') && g2.stdout.includes('boom'), 'and the rejection was logged')
} catch (err) {
  console.log('  FAIL', 'unexpected error:', err)
  process.exitCode = 1
} finally {
  try { await r1.close() } catch {}
  try { await r2.close() } catch {}
  process.exit()
}
