/**
 * Minimal in-memory Nostr relay for tests (NIP-01 EVENT / REQ / CLOSE).
 * No signature checks, no persistence — just enough for bifrost nodes
 * to talk to each other on localhost.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo }           from 'node:net'

type Event  = { id : string, pubkey : string, kind : number, created_at : number, tags : string[][] }
type Filter = { ids? : string[], authors? : string[], kinds? : number[], since? : number, until? : number, limit? : number, [k : string] : unknown }

function matches (ev : Event, f : Filter) : boolean {
  if (f.ids     && !f.ids.includes(ev.id))         return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f.kinds   && !f.kinds.includes(ev.kind))     return false
  if (f.since !== undefined && ev.created_at < f.since) return false
  if (f.until !== undefined && ev.created_at > f.until) return false
  for (const [ k, v ] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(v)) continue
    const tag = k.slice(1)
    if (!ev.tags.some(t => t[0] === tag && v.includes(t[1]))) return false
  }
  return true
}

export class TestRelay {
  private wss?   : WebSocketServer
  private events : Event[] = []
  private subs   = new Map<WebSocket, Map<string, Filter[]>>()

  // Test hooks for misbehaving relays.
  /** Keep connections open but never answer anything (a stalled relay). */
  frozen          = false
  /** Store and replay ephemeral kinds (20000-29999) too, like the dry-run relay does. */
  store_ephemeral = false
  /** Answer REQs for this id filter (the watchdog's heartbeat) this many ms late: a slow relay. */
  slow_heartbeat_ms = 0
  /** Answer every REQ with CLOSED. */
  close_every_req = false
  /** Hang up right after each connection opens. */
  drop_on_connect = false
  /** How many REQs (excluding heartbeat probes) and connections were seen. */
  req_count       = 0
  conn_count      = 0

  /** Send a raw frame to every open subscription, e.g. a malformed EVENT. */
  send_raw (payload : unknown) : void {
    for (const [ client, subs ] of this.subs) {
      for (const sid of subs.keys()) {
        if (client.readyState === client.OPEN) client.send(JSON.stringify([ 'EVENT', sid, payload ]))
      }
    }
  }

  private port = 0

  /** Stays the same while the relay is closed (for restarts on the same port). */
  get url () : string {
    return `ws://127.0.0.1:${this.port}`
  }

  /** `port`: reuse a port, e.g. to restart a relay that was closed (tests of reconnects). */
  async start (port = 0) : Promise<void> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port })
    await new Promise<void>(r => this.wss!.once('listening', () => r()))
    this.port = (this.wss.address() as AddressInfo).port
    this.wss.on('connection', ws => {
      this.conn_count += 1
      if (this.drop_on_connect) { ws.close(); return }
      this.subs.set(ws, new Map())
      ws.on('close', () => this.subs.delete(ws))
      ws.on('message', raw => this.handle(ws, raw.toString()))
    })
  }

  private handle (ws : WebSocket, raw : string) {
    if (this.frozen) return
    let msg : any[]
    try { msg = JSON.parse(raw) } catch { return }
    const send = (m : unknown[]) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m))

    switch (msg[0]) {
      case 'EVENT': {
        const ev = msg[1] as Event
        // NIP-01: ephemeral kinds (20000-29999) are forwarded but never stored.
        // bifrost RPC uses kind 20000, so replaying them would be wrong.
        if (this.store_ephemeral || ev.kind < 20000 || ev.kind >= 30000) this.events.push(ev)
        send([ 'OK', ev.id, true, '' ])
        for (const [ client, subs ] of this.subs) {
          for (const [ sid, filters ] of subs) {
            if (filters.some(f => matches(ev, f)) && client.readyState === client.OPEN) {
              client.send(JSON.stringify([ 'EVENT', sid, ev ]))
            }
          }
        }
        break
      }
      case 'REQ': {
        const [ , sid, ...filters ] = msg as [ string, string, ...Filter[] ]
        if (!String(sid).startsWith('hb-')) this.req_count += 1
        if (this.close_every_req) { send([ 'CLOSED', sid, 'error: closed for testing' ]); break }
        this.subs.get(ws)?.set(sid, filters)
        for (const f of filters) {
          let hits = this.events.filter(ev => matches(ev, f))
          if (f.limit !== undefined) hits = hits.slice(-f.limit)
          hits.forEach(ev => send([ 'EVENT', sid, ev ]))
        }
        const probe = filters.some(f => f.ids?.length === 1 && f.ids[0] === '0'.repeat(64))
        if (probe && this.slow_heartbeat_ms > 0) setTimeout(() => send([ 'EOSE', sid ]), this.slow_heartbeat_ms)
        else send([ 'EOSE', sid ])
        break
      }
      case 'CLOSE':
        this.subs.get(ws)?.delete(msg[1])
        break
    }
  }

  async close () : Promise<void> {
    this.wss?.clients.forEach(c => c.terminate())
    await new Promise<void>(r => this.wss ? this.wss.close(() => r()) : r())
  }
}
