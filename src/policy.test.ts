import { readFileSync } from 'node:fs'
import { Policy }       from './policy.js'
import { nostr_event_id, cinderella_middleware } from './middleware.js'
import { encode_event_content, decode_event_content } from './content.js'

const cfg = JSON.parse(readFileSync('./cinderella.config.json', 'utf8'))
const p   = new Policy(cfg)
const ev  = (kind : number) => ({ id: '', pubkey: 'ab'.repeat(32), created_at: 1, kind, tags: [], content: 'hi' })

const assert = (c : boolean, m : string) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) process.exitCode = 1 }

console.log('policy')
assert(p.evaluate(ev(1)).ok,               'kind 1 allowed (daily)')
assert(!p.evaluate(ev(1984)).ok,           'unknown kind denied (default deny)')
const d = p.evaluate({ ...ev(0), id: 'x' })
assert(!d.ok && d.reason.startsWith('queued'), 'kind 0 queued (delay gate)')
assert(p.evaluate({ ...ev(0), id: 'x' }, Date.now() + 25 * 3_600_000).ok, 'kind 0 allowed after 24h')

console.log('social tier (kind 3 / 10002)')
const sp = new Policy(cfg)
assert(sp.evaluate({ ...ev(3), id: 's1' }).ok,     'kind 3 signs at once (no delay gate)')
assert(sp.evaluate({ ...ev(10002), id: 's2' }).ok, 'kind 10002 signs at once')
assert(sp.evaluate({ ...ev(3), id: 's3' }).ok,     'third social change in a day allowed')
assert(!sp.evaluate({ ...ev(3), id: 's4' }).ok,    'fourth social change in a day denied (shared 3/day)')
assert(sp.evaluate({ ...ev(3), id: 's5' }, Date.now() + 1441 * 60_000).ok, 'allowed again after 24h')
const sq = sp.evaluate({ ...ev(0), id: 's6' })
assert(!sq.ok && sq.reason.startsWith('queued'), 'kind 0 still queued (delay gate kept)')
const sd = sp.evaluate({ ...ev(5), id: 's7' })
assert(!sd.ok && sd.reason.startsWith('queued'), 'kind 5 still queued (delay gate kept)')

console.log('rate limit')
const q = new Policy({ ...cfg, tiers: { t: { kinds: [1], rate_limit: { max_events: 2, per_minutes: 1 } } } })
q.evaluate(ev(1)); q.evaluate(ev(1))
assert(!q.evaluate(ev(1)).ok, 'third event in window denied')

console.log('middleware')
const mw   = cinderella_middleware(new Policy(cfg))
const e1   = ev(1)
const good = { data: { content: encode_event_content(e1), hashes: [[ nostr_event_id(e1) ]] } }
assert(mw(null, good) === good,                               'matching content passes')
let threw = false
try { mw(null, { data: { content: null, hashes: [['00']] } }) } catch { threw = true }
assert(threw,                                                  'blind hash refused')
threw = false
try { mw(null, { data: { content: encode_event_content(e1), hashes: [['ff'.repeat(32)]] } }) } catch { threw = true }
assert(threw,                                                  'mismatched hash refused')
threw = false
try { mw(null, { data: { content: JSON.stringify(e1), hashes: [[ nostr_event_id(e1) ]] } }) } catch { threw = true }
assert(threw,                                                  'raw (non-hex) JSON content refused')

console.log('content')
const e2 = { ...ev(1), content: 'emoji ✨ "quotes" \\ newline\n' }
assert(nostr_event_id(decode_event_content(encode_event_content(e2))) === nostr_event_id(e2), 'hex round-trip keeps the event id')
