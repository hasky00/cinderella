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

console.log('short delay gate (tests use seconds)')
{
  const fp = new Policy({ version: 1, default_tier: 'deny', require_content: true, tiers: { held: { kinds: [0], delay_hours: 0.001 } } })
  const t = Date.now()
  const q = fp.evaluate({ ...ev(0), id: 'h1' }, t)
  assert(!q.ok && q.reason.startsWith('queued'),     'fractional delay_hours queues (0.001h = 3.6s)')
  assert(!fp.evaluate({ ...ev(0), id: 'h1' }, t + 2_000).ok, 'still held after 2s')
  assert(fp.evaluate({ ...ev(0), id: 'h1' }, t + 4_000).ok,  'signed after 4s')
}

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

console.log('veto: policy')
{
  const vcfg = { version: 1, default_tier: 'deny', require_content: true, tiers: {
    held  : { kinds: [0], delay_hours: 1 },
    daily : { kinds: [1] }
  } }
  const t0 = Date.now()
  const alerts : string[] = []
  let ready = true
  const vp = new Policy(vcfg, { alerts_required: true, on_hold: id => alerts.push(id), ready: () => ready })
  const e = (id : string) => ({ ...ev(0), id })

  const first = vp.evaluate(e('p1'), t0)
  assert(!first.ok && first.reason.includes('starts when the veto alert is delivered'), 'held; delay waits for the alert')
  assert(alerts[0] === 'p1',                                         'on_hold fires once for the alert')
  assert(!vp.evaluate(e('p1'), t0 + 2 * 3_600_000).ok,               'alert never delivered: still refused after the delay (fail-closed)')
  assert(vp.alert_delivered('p1', t0 + 10),                          'alert delivered starts the delay')
  assert(!vp.evaluate(e('p1'), t0 + 30 * 60_000).ok,                 'still held 30 min after delivery')
  ready = false
  const notReady = vp.evaluate(e('p1'), t0 + 3_600_000 + 20)
  assert(!notReady.ok && notReady.reason.includes('catching up'),    'unlocked but veto feed not caught up: refused')
  ready = true
  assert(vp.evaluate(e('p1'), t0 + 3_600_000 + 20).ok,               'unlocked and caught up: signed')
  assert(vp.veto('p1', t0 + 3_600_000 + 30) === 'already_signed',    'veto for an already-signed event is ignored')

  vp.evaluate(e('p2'), t0)
  vp.alert_delivered('p2', t0)
  assert(vp.veto('nope', t0) === 'unknown',                          'veto for an unknown id is ignored')
  assert(vp.veto('p2', t0 - 5 * 60_000) === 'older_than_hold',       'veto written before the hold is ignored (no replay)')
  assert(vp.veto('p2', t0 + 1_000) === 'vetoed',                     'veto for the exact held id works')
  assert(vp.veto('p2', t0 + 2_000) === 'already_vetoed',             'second veto: already vetoed')
  const after = vp.evaluate(e('p2'), t0 + 2 * 3_600_000)
  assert(!after.ok && after.reason.startsWith('vetoed'),             'vetoed event refused even after its unlock')
  const again = vp.evaluate(e('p2'), t0 + 3 * 3_600_000)
  assert(!again.ok && again.reason.startsWith('vetoed'),             'and stays refused (not held again)')

  const saved = vp.export_state(t0 + 4_000)
  const vp2   = new Policy(vcfg, { state: saved, alerts_required: true })
  assert(!vp2.evaluate(e('p2'), t0 + 5 * 3_600_000).ok,              'veto survives a restart')
  assert(vp2.veto('p1', t0 + 6_000) === 'already_signed',            'signed list survives a restart')

  const v1 = new Policy(vcfg, { state: { version: 1, history: {}, pending: { old: t0 + 1000 } } as any })
  assert(v1.evaluate(e('old'), t0 + 2000).ok,                        'version 1 state still loads (held event unlocks as before)')
}

console.log('veto: commands, config, verified unwrap')
{
  const { parse_veto_command, resolve_veto_config, unwrap_verified } = await import('./veto.js')
  const { generateSecretKey, getPublicKey, nip17, nip19, nip44, finalizeEvent, getEventHash } = await import('nostr-tools')
  const id = 'ab'.repeat(32)
  assert(parse_veto_command(`veto ${id}`) === id,                     'veto <64 hex> parses')
  assert(parse_veto_command(`  VETO ${id.toUpperCase()} `) === id,     'case and spaces tolerated')
  assert(parse_veto_command(`veto ${id.slice(0, 8)}`) === null,        'a short prefix is refused (exact id only)')
  assert(parse_veto_command('veto all') === null,                     '"veto all" is refused')

  const phone = generateSecretKey(), node = generateSecretKey(), thief = generateSecretKey()
  const two = [ 'wss://hasky.chat', 'wss://nos.lol' ]
  let threw = ''
  try { resolve_veto_config({ pubkey: nip19.npubEncode(getPublicKey(phone)), alert_relays: [ 'wss://hasky.chat' ], node_count: 1 }) } catch (e) { threw = String(e) }
  assert(threw.includes('at least 2 relays'),                         'fewer than 2 alert relays: refused')
  threw = ''
  try { resolve_veto_config({ pubkey: 'npub1nope', alert_relays: two, node_count: 1 }) } catch (e) { threw = String(e) }
  assert(threw.includes('veto.pubkey'),                               'invalid veto npub: refused')
  assert(resolve_veto_config({ pubkey: nip19.npubEncode(getPublicKey(phone)), alert_relays: two, node_count: 1 }).veto_pubkey === getPublicKey(phone), 'npub accepted')

  const real = unwrap_verified(nip17.wrapEvent(phone, { publicKey: getPublicKey(node) }, `veto ${id}`), node)
  assert(real?.sender === getPublicKey(phone) && real.content === `veto ${id}`, 'genuine NIP-17 DM: sender verified')

  // Forgery: the thief seals with their own key but claims the phone as author.
  const rumor : any = { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [[ 'p', getPublicKey(node) ]], content: `veto ${id}`, pubkey: getPublicKey(phone) }
  rumor.id = getEventHash(rumor)
  const seal = finalizeEvent({ kind: 13, created_at: rumor.created_at, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(thief, getPublicKey(node))) }, thief)
  const throwaway = generateSecretKey()
  const wrap = finalizeEvent({ kind: 1059, created_at: rumor.created_at, tags: [[ 'p', getPublicKey(node) ]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(throwaway, getPublicKey(node))) }, throwaway)
  assert(unwrap_verified(wrap, node) === null,                        'forged seal (author != seal signer): rejected')
}
