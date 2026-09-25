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

console.log('state across restarts')
{
  const { mkdtempSync, writeFileSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join }   = await import('node:path')
  const { load_policy_state, save_policy_state } = await import('./state.js')

  const tcfg = { version: 1, default_tier: 'deny', require_content: true, tiers: {
    social : { kinds: [3], rate_limit: { max_events: 3, per_minutes: 1440 } },
    held   : { kinds: [0], delay_hours: 24 }
  } }
  const dir  = mkdtempSync(join(tmpdir(), 'cinderella-state-'))
  const path = join(dir, 'cinderella.state.json')
  const t0   = Date.now()

  // First run: three follow-list changes and one held profile edit, saved on every change.
  const run1 = new Policy(tcfg, { on_change: s => save_policy_state(path, s) })
  for (let i = 0; i < 3; i++) run1.evaluate({ ...ev(3), id: 'f' + i }, t0 + i)
  run1.evaluate({ ...ev(0), id: 'profile' }, t0 + 10)

  // "Restart": a fresh Policy from the file.
  const run2 = new Policy(tcfg, { state: load_policy_state(path) })
  assert(!run2.evaluate({ ...ev(3), id: 'f3' }, t0 + 20).ok,                   '4th change after a restart is still denied')
  assert(run2.evaluate({ ...ev(0), id: 'profile' }, t0 + 25 * 3_600_000).ok,   'held event keeps its unlock time across a restart')
  assert(!run2.evaluate({ ...ev(0), id: 'other' }, t0 + 25 * 3_600_000).ok,    'a new held event still queues')

  assert((statSync(path).mode & 0o777) === 0o600,                             'state file is private (600)')
  assert(load_policy_state(join(dir, 'missing.json')) === undefined,          'missing state file = fresh start')
  writeFileSync(path, '{ not json')
  let threw = false
  try { load_policy_state(path) } catch { threw = true }
  assert(threw,                                                                'corrupt state file stops the node')

  // Export forgets what can no longer matter.
  const run3 = new Policy(tcfg)
  run3.evaluate({ ...ev(3), id: 'old' }, t0)
  const later = run3.export_state(t0 + 1441 * 60_000)
  assert(Object.keys(later.history).length === 0,                              'expired counters are not saved')
}
