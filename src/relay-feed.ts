/**
 * A relay subscription that knows whether it is really live, per relay.
 *
 * nostr-tools' pool reports "EOSE" after a timeout even when no relay answered,
 * so it can't tell "caught up" from "nobody there". This keeps one plain
 * WebSocket per relay and tracks, for each relay, whether it is connected and
 * has sent a real EOSE for the current subscription since its last reconnect.
 *
 *  - all_caught_up: EVERY configured relay is connected and past its EOSE.
 *    The veto listener requires this before held events may unlock, so a
 *    veto that only one relay carries can't be missed.
 *  - Heartbeat: a tiny REQ every idle/3; no traffic at all for `idle_ms`
 *    means the connection is dead even if the socket looks open: it is
 *    closed, the relay counts as not caught up, and it reconnects.
 *  - Backoff: exponential for reconnects and for CLOSED resubscribes, reset
 *    only after a real EOSE (a relay that accepts and then drops or CLOSEDs
 *    straight away can't make it loop at the minimum). Timers are unref'd.
 *  - Each (re)subscribe asks for a fresh filter for that relay, so `since`
 *    follows what that relay was seen to deliver.
 */

export type FeedFilter = Record<string, unknown>

/** Node 22+ has a global WebSocket; older versions don't. */
export function assert_websocket () : void {
  if (typeof (globalThis as { WebSocket? : unknown }).WebSocket !== 'function') {
    throw new Error('cinderella: this Node.js has no global WebSocket. Node 22 or newer is required (see "engines" in package.json).')
  }
}

export interface RelayFeedOptions {
  /** Called on every (re)subscribe to `relay`, so `since` can follow that relay. */
  filter          : (relay : string) => FeedFilter
  onevent         : (event : unknown, relay : string) => void
  /** Called whenever all_caught_up changes. */
  onstate?        : (all_caught_up : boolean) => void
  /** Called each time a relay sends EOSE for our subscription. */
  oncaughtup?     : (relay : string) => void
  min_backoff_ms? : number
  max_backoff_ms? : number
  /** No traffic for this long = dead connection (default 60 s). */
  idle_ms?        : number
}

interface Conn {
  url        : string
  ws         : WebSocket | null
  open       : boolean
  eose       : boolean
  sub_id     : string
  hb_id      : string
  attempt    : number   // reconnects since the last real EOSE
  closed_n   : number   // CLOSED resubscribes since the last real EOSE
  last_rx    : number
  timer      : ReturnType<typeof setTimeout> | null
}

function unref (t : ReturnType<typeof setTimeout>) : void {
  if (typeof (t as { unref? : () => void }).unref === 'function') (t as { unref : () => void }).unref()
}

export class RelayFeed {
  private readonly conns : Conn[]
  private stopped = false
  private last    = false
  private hb      : ReturnType<typeof setInterval> | null = null

  constructor (relays : string[], private readonly opts : RelayFeedOptions) {
    assert_websocket()
    this.conns = relays.map(url => ({
      url, ws: null, open: false, eose: false, sub_id: '', hb_id: '', attempt: 0, closed_n: 0, last_rx: 0, timer: null
    }))
  }

  private get idle_ms () : number { return this.opts.idle_ms ?? 60_000 }

  /** Every configured relay connected and past a real EOSE since its last reconnect. */
  get all_caught_up () : boolean {
    return this.conns.length > 0 && this.conns.every(c => c.open && c.eose)
  }

  /** Relays currently connected and past their EOSE. */
  get caught_up_relays () : string[] {
    return this.conns.filter(c => c.open && c.eose).map(c => c.url)
  }

  start () : void {
    for (const c of this.conns) this.connect(c)
    this.hb = setInterval(() => this.heartbeat(), Math.max(200, Math.floor(this.idle_ms / 3)))
    unref(this.hb)
  }

  stop () : void {
    this.stopped = true
    if (this.hb) clearInterval(this.hb)
    for (const c of this.conns) {
      if (c.timer) clearTimeout(c.timer)
      try { c.ws?.close() } catch { /* closed */ }
      c.ws = null; c.open = false; c.eose = false
    }
    this.emit()
  }

  private emit () : void {
    const now = this.all_caught_up
    if (now !== this.last) {
      this.last = now
      this.opts.onstate?.(now)
    }
  }

  private backoff (n : number) : number {
    const min = this.opts.min_backoff_ms ?? 1_000
    const max = this.opts.max_backoff_ms ?? 30_000
    return Math.min(max, min * 2 ** Math.min(n, 10))
  }

  private schedule (c : Conn, wait : number, fn : () => void) : void {
    if (c.timer) clearTimeout(c.timer)
    c.timer = setTimeout(() => { c.timer = null; fn() }, wait)
    unref(c.timer)
  }

  private connect (c : Conn) : void {
    if (this.stopped) return
    let ws : WebSocket
    try {
      ws = new WebSocket(c.url)
    } catch {
      this.retry(c)
      return
    }
    c.ws = ws
    ws.onopen = () => {
      if (c.ws !== ws) return
      c.open = true
      c.last_rx = Date.now()
      this.subscribe(c)
    }
    ws.onmessage = (msg : MessageEvent) => {
      if (c.ws !== ws) return
      c.last_rx = Date.now()
      let data : unknown[]
      try { data = JSON.parse(String(msg.data)) } catch { return }
      if (!Array.isArray(data)) return
      if (data[1] === c.hb_id) {
        if (data[0] === 'EOSE' || data[0] === 'CLOSED') {
          try { ws.send(JSON.stringify([ 'CLOSE', c.hb_id ])) } catch { /* closing anyway */ }
          c.hb_id = ''
        }
        return
      }
      if (data[1] !== c.sub_id) return
      if (data[0] === 'EVENT') {
        try { this.opts.onevent(data[2], c.url) } catch { /* the consumer guards itself */ }
      } else if (data[0] === 'EOSE') {
        c.eose = true
        c.attempt = 0
        c.closed_n = 0
        this.opts.oncaughtup?.(c.url)
        this.emit()
      } else if (data[0] === 'CLOSED') {
        // The relay ended our subscription: not caught up there; resubscribe with growing backoff.
        c.eose = false
        this.emit()
        const wait = this.backoff(c.closed_n)
        c.closed_n += 1
        this.schedule(c, wait, () => { if (c.open && c.ws === ws) this.subscribe(c) })
      }
    }
    const down = () => {
      if (c.ws !== ws) return
      c.ws = null; c.open = false; c.eose = false; c.hb_id = ''
      this.emit()
      this.retry(c)
    }
    ws.onclose = down
    ws.onerror = down
  }

  private subscribe (c : Conn) : void {
    c.eose   = false
    c.sub_id = 'veto-' + Math.random().toString(36).slice(2, 10)
    this.emit()
    try { c.ws?.send(JSON.stringify([ 'REQ', c.sub_id, this.opts.filter(c.url) ])) } catch { /* reconnect will follow */ }
  }

  private retry (c : Conn) : void {
    if (this.stopped) return
    const wait = this.backoff(c.attempt)
    c.attempt += 1
    this.schedule(c, wait, () => this.connect(c))
  }

  /** Probe every open connection; one silent for idle_ms is dead. */
  private heartbeat () : void {
    const now = Date.now()
    for (const c of this.conns) {
      if (!c.open || !c.ws) continue
      if (now - c.last_rx > this.idle_ms) {
        const ws = c.ws
        c.ws = null; c.open = false; c.eose = false; c.hb_id = ''
        try { ws.close() } catch { /* already gone */ }
        this.emit()
        this.retry(c)
        continue
      }
      if (!c.hb_id) {
        c.hb_id = 'hb-' + Math.random().toString(36).slice(2, 10)
        try { c.ws.send(JSON.stringify([ 'REQ', c.hb_id, { ids: [ '0'.repeat(64) ], limit: 1 } ])) } catch { /* next round decides */ }
      }
    }
  }
}
