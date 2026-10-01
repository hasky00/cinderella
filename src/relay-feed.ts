/**
 * A relay subscription that knows whether it is really live.
 *
 * nostr-tools' pool reports "EOSE" after a timeout even when no relay answered,
 * so it can't tell "caught up" from "nobody there". This keeps one plain
 * WebSocket per relay and counts as caught up only while at least one relay is
 * connected AND has sent a real EOSE for the current subscription. When a
 * connection drops it reconnects with backoff and resubscribes, asking for a
 * fresh filter (so `since` follows what was actually seen).
 */

export type FeedFilter = Record<string, unknown>

export interface RelayFeedOptions {
  /** Called on every (re)subscribe, so `since` can move with what was seen. */
  filter      : () => FeedFilter
  onevent     : (event : any) => void
  /** Called whenever caught_up changes. */
  onstate?    : (caught_up : boolean) => void
  min_backoff_ms? : number
  max_backoff_ms? : number
}

interface Conn {
  url     : string
  ws      : WebSocket | null
  open    : boolean
  eose    : boolean
  sub_id  : string
  attempt : number
  timer   : ReturnType<typeof setTimeout> | null
}

export class RelayFeed {
  private readonly conns : Conn[]
  private stopped = false
  private last    = false

  constructor (relays : string[], private readonly opts : RelayFeedOptions) {
    this.conns = relays.map(url => ({ url, ws: null, open: false, eose: false, sub_id: '', attempt: 0, timer: null }))
  }

  /** At least one relay connected and past its real EOSE. */
  get caught_up () : boolean {
    return this.conns.some(c => c.open && c.eose)
  }

  /** Relays currently connected. */
  get live () : string[] {
    return this.conns.filter(c => c.open).map(c => c.url)
  }

  start () : void {
    for (const c of this.conns) this.connect(c)
  }

  stop () : void {
    this.stopped = true
    for (const c of this.conns) {
      if (c.timer) clearTimeout(c.timer)
      try { c.ws?.close() } catch { /* closed */ }
      c.ws = null; c.open = false; c.eose = false
    }
    this.emit()
  }

  private emit () : void {
    const now = this.caught_up
    if (now !== this.last) {
      this.last = now
      this.opts.onstate?.(now)
    }
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
      c.open = true
      c.attempt = 0
      this.subscribe(c)
    }
    ws.onmessage = (msg : MessageEvent) => {
      let data : unknown[]
      try { data = JSON.parse(String(msg.data)) } catch { return }
      if (!Array.isArray(data) || data[1] !== c.sub_id) return
      if (data[0] === 'EVENT') {
        try { this.opts.onevent(data[2]) } catch { /* consumer errors are not ours */ }
      } else if (data[0] === 'EOSE') {
        c.eose = true
        this.emit()
      } else if (data[0] === 'CLOSED') {
        // The relay ended our subscription: not caught up there until resubscribed.
        c.eose = false
        this.emit()
        if (c.timer) clearTimeout(c.timer)
        c.timer = setTimeout(() => { if (c.open) this.subscribe(c) }, this.backoff(c))
      }
    }
    const down = () => {
      if (c.ws !== ws) return
      c.ws = null; c.open = false; c.eose = false
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
    try { c.ws?.send(JSON.stringify([ 'REQ', c.sub_id, this.opts.filter() ])) } catch { /* reconnect will follow */ }
  }

  private backoff (c : Conn) : number {
    const min = this.opts.min_backoff_ms ?? 1_000
    const max = this.opts.max_backoff_ms ?? 30_000
    return Math.min(max, min * 2 ** Math.min(c.attempt, 10))
  }

  private retry (c : Conn) : void {
    if (this.stopped) return
    if (c.timer) clearTimeout(c.timer)
    const wait = this.backoff(c)
    c.attempt += 1
    c.timer = setTimeout(() => { c.timer = null; this.connect(c) }, wait)
    if (typeof c.timer.unref === 'function') c.timer.unref()
  }
}
