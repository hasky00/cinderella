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

  get url () : string {
    const { port } = this.wss!.address() as AddressInfo
    return `ws://127.0.0.1:${port}`
  }

  async start () : Promise<void> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(r => this.wss!.once('listening', () => r()))
    this.wss.on('connection', ws => {
      this.subs.set(ws, new Map())
      ws.on('close', () => this.subs.delete(ws))
      ws.on('message', raw => this.handle(ws, raw.toString()))
    })
  }

  private handle (ws : WebSocket, raw : string) {
    let msg : any[]
    try { msg = JSON.parse(raw) } catch { return }
    const send = (m : unknown[]) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m))

    switch (msg[0]) {
      case 'EVENT': {
        const ev = msg[1] as Event
        // NIP-01: ephemeral kinds (20000-29999) are forwarded but never stored.
        // bifrost RPC uses kind 20000, so replaying them would be wrong.
        if (ev.kind < 20000 || ev.kind >= 30000) this.events.push(ev)
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
        this.subs.get(ws)?.set(sid, filters)
        for (const f of filters) {
          let hits = this.events.filter(ev => matches(ev, f))
          if (f.limit !== undefined) hits = hits.slice(-f.limit)
          hits.forEach(ev => send([ 'EVENT', sid, ev ]))
        }
        send([ 'EOSE', sid ])
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
