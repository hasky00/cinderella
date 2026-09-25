# Cinderella 🥿

**Policy-aware threshold signing for Nostr.** Built on [FROSTR](https://frostr.org) / `@frostr/bifrost`.

> The slipper only fits one foot. A signature only forms when the right shares match — and everything queued turns back at midnight.

FROSTR splits your nsec into k-of-n shares. Cinderella makes every share **opinionated**:
each node inspects the event before contributing its partial signature. A stolen device
can post a few notes at worst — it cannot rewrite your profile, relay list, or delete your history.

## What it adds on top of FROSTR

| FROSTR today | Cinderella |
|---|---|
| Any share signs any hash | Shares only sign events whose full JSON is attached and provably matches the sighash |
| One threshold for everything | **Tiers by kind**: daily notes vs identity (kind 0/3/10002) vs destructive (kind 5) |
| No limits | Per-tier **rate limits** (sliding window) |
| Instant | **Delay gate** for identity/destructive kinds — queued, then signed only when the same event is requested again after the delay |
| Policy in one client's popup | Policy enforced **on every share node independently** |

## How it plugs in

bifrost exposes `middleware.sign(node, msg)`, called on each signer before it produces a partial
signature. Cinderella's middleware:

1. Refuses blind requests (`content === null`).
2. Decodes `content` as a Nostr event, recomputes the NIP-01 id, and requires it to equal the requested sighash.
3. Looks up the tier for `event.kind`, applies rate limit + delay gate, allows or throws.

Requesters must attach the event as **hex-encoded JSON** — bifrost hashes `content` into the session
id with `Buff.bytes()`, which only accepts hex, so raw JSON throws before the request is sent.
Use the helper instead of `node.req.sign(id)` (which goes through the batcher and never sends content):

```ts
import { cinderella_sign } from './src/request.js'
const signed = await cinderella_sign(node, { kind: 1, created_at, tags: [], content: 'gm' })
```

A share that refuses stays silent (bifrost sends no reject message), so a denied request
shows up on the requester as a timeout (`sub_timeout`, 30s by default).

## Run a share node

```bash
cp .env.example .env     # paste ONE bfshare + the bfgroup + relays
npm install
npm run dev
```

## Nonces and restarts

bifrost 2 keeps nonce pools in memory only and never reconciles them after a restart, so a
restarted requester could never sign again and a restarted share node cost one timeout per stale
nonce. `src/resync.ts` repairs both using the pool status that ping already carries, and marks the
nonce of every refused request spent. It only ever **discards** nonces — never persist and restore
pool state: restoring a stale snapshot can reuse a nonce, which leaks that share.

This reaches into bifrost internals, so `@frostr/bifrost` is pinned to exactly `2.0.2`.

## Config

See `cinderella.config.json`. Unknown kinds hit `default_tier: "deny"`.

## Test

```bash
npm test            # unit + e2e
npm run test:e2e    # throwaway 2-of-3 group, real bifrost nodes, in-process relay
npm run test:restart  # nonce resync after requester / share node restarts, refusal nonce spend
```

## Roadmap

- [ ] Gateway: NIP-46 signer (fork of igloo-server) that attaches event content to every request
- [ ] **High priority, next after the Gateway — ECDH policy (DM decryption gap).** Cinderella only
      guards `middleware.sign`. NIP-04/NIP-44 encrypt/decrypt use bifrost's ECDH, which has no policy,
      so a stolen hot share plus any one online Cinderella node can decrypt every DM. Add a
      `middleware.ecdh` policy (rate limits, and per-peer or per-requester rules) on every share node.
- [ ] Veto listener: a kind 1 from a hot share clears the delay queue on all nodes
- [ ] Persist delay queue as a replaceable event on the coordination relay
- [ ] Duress share
- [ ] Automatic proactive resharing

MIT
