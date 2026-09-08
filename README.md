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
| Instant | **Delay gate** for identity/destructive kinds — queued, vetoable, then signed |
| Policy in one client's popup | Policy enforced **on every share node independently** |

## How it plugs in

bifrost exposes `middleware.sign(node, msg)`, called on each signer before it produces a partial
signature. Cinderella's middleware:

1. Refuses blind requests (`content === null`).
2. Parses `content` as a Nostr event, recomputes the NIP-01 id, and requires it to equal the requested sighash.
3. Looks up the tier for `event.kind`, applies rate limit + delay gate, allows or throws.

Requesters must send `content: JSON.stringify(event)` — see `sign_batch_request_api` options in bifrost.

## Run a share node

```bash
cp .env.example .env     # paste ONE bfshare + the bfgroup + relays
npm install
npm run dev
```

## Config

See `cinderella.config.json`. Unknown kinds hit `default_tier: "deny"`.

## Test

```bash
npm test
```

## Roadmap

- [ ] Gateway: NIP-46 signer (fork of igloo-server) that attaches event content to every request
- [ ] Veto listener: a kind 1 from a hot share clears the delay queue on all nodes
- [ ] Persist delay queue as a replaceable event on the coordination relay
- [ ] Duress share
- [ ] Automatic proactive resharing

MIT
