/**
 * Is the share node's own relay connection still alive?
 *
 * Seen on the dry run (3 Oct): the Mac slept, the relay dropped the socket,
 * and @vbyte/nostr-sdk's node shut itself down for good (it clears its peers
 * and never reconnects). The process stayed "running" and signed nothing
 * until it was restarted by hand five hours later.
 *
 * The watchdog probes the node's OWN socket (a fresh connection could work
 * while the node's is dead): every `interval_ms` it sends a tiny REQ on it
 * and needs the relay's EOSE within `timeout_ms`. A closed or silent socket,
 * or a node that reports itself closed, counts as dead. A clock jump bigger
 * than two intervals (the machine slept) triggers a probe at once. On death
 * it calls `on_dead` once; node.ts then exits so the supervisor (launchd
 * KeepAlive, systemd, Docker) starts a fresh node, which announces a nonce
 * reset to its peers.
 *
 * Reaches into @vbyte/nostr-sdk 1.0.1 (via @frostr/bifrost 2.0.2, pinned).
 */

import type { BifrostNode } from '@frostr/bifrost'

export interface WatchdogOptions {
  interval_ms? : number
  timeout_ms?  : number
  on_dead      : (reason : string) => void
  log?         : (msg : string) => void
}

interface Socket {
  url      : string
  is_ready : boolean
  subscribe : (filters : unknown[]) => { activate : () => Promise<unknown>, cancel : () => void }
}

function sockets (node : BifrostNode) : Socket[] {
  const transport = (node.client as unknown as { client? : { sockets? : Socket[] } }).client
  if (!transport || !Array.isArray(transport.sockets)) {
    throw new Error('cinderella: bifrost client has no sockets list — the watchdog needs updating for this nostr-sdk version')
  }
  return transport.sockets
}

function within<T> (p : Promise<T>, ms : number, what : string) : Promise<T> {
  let t : ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms) }),
  ])
}

/** One probe of every socket of the node. Resolves with null if alive, else the reason. */
export async function probe_relay_link (node : BifrostNode, timeout_ms = 15_000) : Promise<string | null> {
  const ready = (node.client as unknown as { is_ready? : boolean }).is_ready
  if (ready === false) return 'the signing node reports itself closed'
  for (const s of sockets(node)) {
    if (!s.is_ready) return `socket to ${s.url} is closed`
    let sub : ReturnType<Socket['subscribe']> | undefined
    try {
      sub = s.subscribe([ { ids: [ '0'.repeat(64) ], limit: 1 } ])
      await within(sub.activate(), timeout_ms, `heartbeat on ${s.url}`)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      try { sub?.cancel() } catch { /* gone */ }
    }
  }
  return null
}

/** Start watching. Returns a stop function. */
export function watch_relay_link (node : BifrostNode, opts : WatchdogOptions) : () => void {
  const interval = opts.interval_ms ?? 30_000
  const timeout  = opts.timeout_ms  ?? 15_000
  let dead = false, probing = false, last = Date.now()

  const die = (reason : string) => {
    if (dead) return
    dead = true
    stop()
    opts.on_dead(reason)
  }
  const check = async () => {
    if (dead || probing) return
    probing = true
    try {
      const reason = await probe_relay_link(node, timeout)
      if (reason) die(reason)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    } finally {
      probing = false
    }
  }

  const on_closed = () => die('relay connection closed')
  const client = node.client as unknown as { on : (e : string, f : () => void) => void, off : (e : string, f : () => void) => void }
  client.on('closed', on_closed)

  const timer = setInterval(() => {
    const now = Date.now()
    if (now - last > interval * 2 + 5_000) opts.log?.(`watchdog: clock jumped ${Math.round((now - last) / 1000)} s (the machine slept?); checking the relay connection now`)
    last = now
    void check()
  }, interval)

  function stop () {
    clearInterval(timer)
    try { client.off('closed', on_closed) } catch { /* gone */ }
  }
  return stop
}
