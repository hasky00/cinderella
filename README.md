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

A share that refuses answers at once with a reject message carrying the reason and a code
(`src/refusal.ts`): `locked` (with this node's unlock time), `held` (the delay hasn't started yet,
e.g. the veto alert isn't delivered), `catching_up`, `vetoed`, `rate_limited` (with when to retry),
`denied`, or `nonce`. `cinderella_sign` throws a `SignRefusedError` with those refusals, so the
Gateway can show "still locked until …" and retry at the right time instead of seeing "request
timed out". (bifrost itself sends no reject; a share running older code, or one that is offline,
still shows up as a timeout.)

## Run a share node

```bash
cp .env.example .env     # paste ONE bfshare + the bfgroup + relays
npm install
npm run dev
```

### Relay connection and supervision

A share node must run under a supervisor that restarts it (launchd `KeepAlive`, systemd
`Restart=always`, Docker `restart: unless-stopped`):

- **Startup:** if the signing relay can't be reached (e.g. right after the machine wakes, before
  the network is back), the node logs `signing relay unreachable …; retrying in N s` and retries with
  backoff (2 s up to 60 s) instead of crashing.
- **While running:** a watchdog sends a heartbeat on the node's own relay socket every 30 s
  (`CINDERELLA_WATCHDOG_MS`) and checks at once after a clock jump (the machine slept). A closed or
  silent connection never recovers by itself (bifrost's transport shuts down for good), so the node
  logs `signing relay connection is dead (…)` and exits with code 1; the supervisor starts a fresh
  one, which tells its peers to drop their stale nonces.

## Nonces and restarts

bifrost 2 keeps nonce pools in memory only and never reconciles them after a restart, so a
restarted requester could never sign again and a restarted share node cost one timeout per stale
nonce. `src/resync.ts` repairs both using the pool status that ping already carries, and marks the
nonce of every refused request spent. Requesters must call `single_flight_pings(node)` so two
pings to the same peer are never in flight at once (a second one would discard the fresh batch the
first just delivered). It only ever **discards** nonces — never persist and restore
pool state: restoring a stale snapshot can reuse a nonce, which leaks that share.

After a share node restarts, the requester still holds nonces that died with the node's memory.
Two things now keep that from failing a signature:

- On connect, the share node tells every peer to drop the nonces it holds from it (a bifrost
  event message, `cinderella/nonce-reset`); a requester that runs `attach_requester_resync(node)`
  does so, and its next signature pings for a fresh batch first.
- If a round still reaches the node with a nonce it doesn't know (the notice was missed), the node
  refuses with code `nonce` **before its policy runs**, so the round counts as nothing (an unlocked
  held event stays unlocked, no rate-limit slot is used). `cinderella_sign` then drops that peer's
  nonces, pings for fresh ones and runs the round once more.

- The relay replays bifrost's messages to a node that just connected. A node ignores every message
  sent before it started (5 s clock-skew allowance) or older than 30 s, so after a restart it no
  longer answers pings and sign requests nobody waits for (each stale ping used to hand out a nonce
  batch the requester never stored).
- The restart notice works both ways: when the Gateway restarts, a share node also drops the nonces
  it counted as given to it.

An event allowed after its delay stays allowed: if that signature fails (stale nonce, dropped reply)
and the requester asks again, it passes at once, with no new delay, alert or rate-limit slot.

This reaches into bifrost internals, so `@frostr/bifrost` is pinned to exactly `2.0.2`.

## Run as a macOS background service (launchd)

`deploy/launchd/cinderella-node.plist.example` starts the node at login, restarts it if it crashes
(at most every 10 s) and logs to a file. Replace `/Users/YOU`, the label and the paths, then:

```bash
git worktree add --detach ~/cinderella-node/app main   # pinned code, unaffected by branch switches
(cd ~/cinderella-node/app && npm ci)
chmod 600 ~/cinderella-node/node.env                    # CINDERELLA_SHARE/GROUP/RELAYS/CONFIG/STATE
cp deploy/launchd/cinderella-node.plist.example ~/Library/LaunchAgents/org.example.cinderella.node.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.example.cinderella.node.plist   # start (and at every login)
launchctl print gui/$(id -u)/org.example.cinderella.node | grep -E 'state|pid|runs'          # status
launchctl bootout gui/$(id -u)/org.example.cinderella.node                                    # stop (stays stopped)
launchctl kickstart -k gui/$(id -u)/org.example.cinderella.node                              # restart
tail -f ~/cinderella-node/node.log                                                              # log
```

To update the code, move the worktree to the new commit (`git -C ~/cinderella-node/app checkout --detach <commit>`,
then `npm ci`) and restart.

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
   With more than 1, `peer_alert_pubkeys` must list exactly the **other** nodes' alert npubs, so each
   node's list is different; don't copy one shared list to every node. The node refuses to start if
   the count doesn't match, if the list contains its own alert key, or if `node_count` is larger than
   the FROSTR group's share count (a veto reply would not reach every node). A `node_count` smaller
   than the share count is allowed (not every share has to run Cinderella) and logged at startup.
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
- **Limit: a relay that stops delivering but stays connected still counts as live.** "Live" means
  the relay answers at all (heartbeat replies count), not that it still delivers events on the veto
  subscription. A relay that keeps the socket open, answers heartbeats and quietly drops your veto
  can't be told apart from one that has nothing new. Requiring every alert relay to be caught up
  only covers this if your veto reaches **more than one** of them: give your veto key at least two
  DM inbox relays (kind 10050), ideally the same ones as the nodes' alert relays, and run the alert
  relays on different operators.
- A malformed event from a relay is logged and dropped, and an error while handling one is logged;
  relay input never stops the node. Any **other** unexpected failure (a promise rejection nothing
  handled, e.g. in bifrost or while saving state) is logged and **stops the node** (exit code 1)
  instead of letting it keep signing in a state nobody checked; run it under a supervisor that
  restarts it (launchd `KeepAlive`, systemd `Restart=on-failure`, Docker `restart: unless-stopped`).
  Needs **Node 22 or newer** (built-in WebSocket); older versions stop with a clear error.
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
npm run test:refusal  # refusal reasons reach the requester; lost nonces: resync + one retry; restart notice
npm run test:stale    # replayed messages after a restart are ignored; Gateway restart notice; allowed stays allowed
npm run test:watchdog # relay down at startup: retry; dead or silent connection: exit for the supervisor
npm run test:veto     # alerts and vetoes: local relays, a test phone, offline catch-up, key rotation
npm run test:feed     # veto feed: every relay caught up, idle timeout, backoff, rejection guard
npm run test:startup  # node.ts refuses bad veto setups (own key as peer, node_count vs group)
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
