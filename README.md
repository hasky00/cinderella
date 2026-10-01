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
| Instant | **Delay gate** for identity/destructive kinds — held, you're alerted on your phone and can **veto**, then signed |
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
nonce of every refused request spent. Requesters must call `single_flight_pings(node)` so two
pings to the same peer are never in flight at once (a second one would discard the fresh batch the
first just delivered). It only ever **discards** nonces — never persist and restore
pool state: restoring a stale snapshot can reuse a nonce, which leaks that share.

This reaches into bifrost internals, so `@frostr/bifrost` is pinned to exactly `2.0.2`.

## State across restarts

Each node saves its rate-limit counters and held (delay-gated) events to `CINDERELLA_STATE`
(default `./cinderella.state.json`, mode 600) after every decision that changes them, and loads
them at startup, so a restart doesn't reset "3 per day" or restart a 24h delay. A corrupt state
file stops the node rather than silently resetting; fix or remove it deliberately.

## Veto from your phone

When a node holds a delay-gated event (profile, deletion, media server list), it sends a private
Nostr DM (NIP-17) to your **veto key**: a separate npub that lives only on your phone, never a FROSTR
share. With several share nodes the alert is a **group DM** with the veto key and every node, so
**one reply in that group vetoes on every node**. Reply with the exact line from the alert:

```
Cinderella: held a profile change (kind 0): name: pumpkin
Unlocks 2026-10-02 18:12 UTC (24h), unless you veto it.
To cancel, reply exactly:
veto 4a0e9ec49ebe…(64 hex characters)
```

The node answers `vetoed …` and refuses that event for good, even after its unlock. If
`veto.gateway_pubkey` is set, it also tells the Gateway, which marks the held event `vetoed`.

### Setup

1. **Phone:** create a new npub (the veto key) in a Nostr app with NIP-17 DMs and notifications,
   and make sure the app **publishes its DM inbox relays** (kind 10050; most NIP-17 apps do this in
   their relay settings). Without that list no alert counts as delivered, so no delay ever starts.
2. **Node config** (`cinderella.config.json`; not the env file with the share):
   ```json
   "veto": {
     "pubkey": "npub1…your veto key…",
     "alert_relays": [ "wss://hasky.chat", "wss://nos.lol" ],
     "gateway_pubkey": "npub1…the Gateway's notice key (optional)…",
     "node_count": 2,
     "peer_alert_pubkeys": [ "npub1…the OTHER nodes' alert keys (node_count - 1 of them)…" ]
   }
   ```
   `node_count` is **required**: how many Cinderella share nodes you run (`1` for a single node).
   With more than 1, `peer_alert_pubkeys` must list exactly the other nodes' alert npubs, otherwise
   the node refuses to start (a veto reply would not reach every node).
   At least **2** alert relays, otherwise the node refuses to start: use your own relay plus a public
   one, so a single blocked or compromised relay can't hide an alert or a veto.
3. **Restart the node.** On first start it creates its **alert key** (`CINDERELLA_ALERT_KEY`,
   default `cinderella.alert.key` next to the state file, mode 600; not a share) and logs its npub.
   Add that npub as a contact on your phone. It also publishes its DM inbox list (kind 10050) so your
   replies reach the alert relays. With several nodes, put each node's alert npub in the others'
   `peer_alert_pubkeys`, then reply in the group the alerts arrive in.

Alerts go to the alert relays **and** to your veto key's own DM inbox relays (its kind 10050), so your
phone gets them where it listens.

### Rules

- Only DMs **signed by the veto key** count. The sender is verified through the NIP-59 seal (the seal
  signer must be the message author); nostr-tools' `unwrapEvent` alone does not check this.
- A veto must name the **exact 64-character id** of an event **this node is holding**. Vetoes for
  unknown or already-signed ids, or written **before** the event was held, are ignored (and you're
  told why), so old messages can't be replayed.
- **Fail-closed alerts:** the delay starts only once at least one of the **veto key's own inbox
  relays** (its kind 10050) accepted the alert: that is where your phone listens. A veto key without
  an inbox list, or inbox relays that all refuse, means not delivered: the event stays held, the log
  says why, and the alert is retried every minute (an empty inbox lookup is never cached, so
  publishing the list fixes it on the next retry).
- **Live veto feed, on EVERY alert relay:** the node counts as caught up only while **every** alert
  relay is connected and has sent a real end-of-stored-events (EOSE) since its last reconnect, so a
  veto that only one relay carries can't be missed. While any alert relay is down, after a restart,
  or not yet caught up, the node refuses unlocked held events and reconnects (exponential backoff up
  to 30 s, also when a relay keeps ending the subscription). A relay that sends nothing for 60 s,
  not even an answer to the node's heartbeat, counts as down. Each relay has its own catch-up point,
  which moves only while that relay is live; after a gap it re-reads from 2 days before that point
  (gift wraps carry randomized timestamps), and DMs wait on the relays meanwhile.
- **New veto key, veto turned on later, or turned off and on again (even with the same key):** every
  event the node is holding gets a new alert to the veto key, and its delay **restarts** from that
  alert's delivery.
- A malformed event from a relay is logged and dropped; an error while handling one is logged; the
  node never crashes on relay input. Needs **Node 22 or newer** (built-in WebSocket); older versions
  stop with a clear error.
- With several share nodes, give each one the same veto key and alert relays: every node enforces its
  own vetoes, and the group DM makes one reply reach all of them.

### Phone lost: rotate the veto key

1. Create a new npub on the new phone.
2. On the node's machine, put it in `veto.pubkey` in `cinderella.config.json`.
3. Restart the node (`launchctl kickstart -k gui/$(id -u)/<label>` for the launchd service).

The node then ignores the old npub, tells the new one "this npub is now the veto key", and alerts every
event it is still holding to the new key; their delays restart from those alerts, so the new key gets
the full delay to veto them. This can only be done
on the node's machine: neither a share nor the Gateway can change the veto key. Someone holding the
lost phone's key until then can only veto your own held events; they can't sign anything.

## Config

See `cinderella.config.json`. Unknown kinds hit `default_tier: "deny"`.

## Test

```bash
npm test            # unit + e2e
npm run test:e2e    # throwaway 2-of-3 group, real bifrost nodes, in-process relay
npm run test:restart  # nonce resync after requester / share node restarts, refusal nonce spend
npm run test:veto     # alerts and vetoes: local relays, a test phone, offline catch-up, key rotation
npm run test:feed     # veto feed: every relay caught up, idle timeout, backoff, crash guard
```

## Roadmap

- [ ] Gateway: NIP-46 signer (fork of igloo-server) that attaches event content to every request
- [ ] **High priority, next after the Gateway — ECDH policy (DM decryption gap).** Cinderella only
      guards `middleware.sign`. NIP-04/NIP-44 encrypt/decrypt use bifrost's ECDH, which has no policy,
      so a stolen hot share plus any one online Cinderella node can decrypt every DM. Add a
      `middleware.ecdh` policy (rate limits, and per-peer or per-requester rules) on every share node.
- [x] Veto listener: alerts to a phone-only veto key, `veto <id>` replies (see "Veto from your phone")
- [ ] Persist delay queue as a replaceable event on the coordination relay
- [ ] Duress share
- [ ] Automatic proactive resharing

MIT
