# Star Bridge

Speech-routed Discord voice relay for fleet operations.

A commander speaks a call-up — *"Command Charlie"* — on a command net. The bot
recognises the verb and NATO callsign, opens the addressed net, plays `Ready`
back to the commander and `Attention` into the target, then relays the message
audio live in the commander's own voice.

Full specification: **[`docs/spec.html`](docs/spec.html)**.

---

## Status

**Step 3 of 9** (spec §16): the blind relay. Steps 1 and 2 passed.

The step 3 build adds an unconditional audio bridge on top of the fleet:
bravo joins one voice channel and listens, charlie joins another and
transmits every non-fleet speaker's opus straight through. No STT, no cues,
no call-up protocol — the point of this step is to measure the additive
routing latency, confirm no join chime is emitted between transmissions
(the connection is held open, silence frames included), and verify §5 fleet
suppression drops the fleet's own audio *before* it enters the relay path.

The step 3 build does **not** implement callsigns, verbs, cues, session
state, mirror embeds, ducking, or the priority-speaker mute mode.

Earlier steps are retained: `src/spike/receive.ts` still runs via
`npm run spike` for DAVE-receive regression diagnosis. Step 2's fleet
manager is now the base that step 3 sits on.

## Running the fleet (step 2)

### 1. Register N applications

Build against N=3 (`alfa`, `bravo`, `charlie`) per spec §2 risk box.

For each application, in the [developer portal](https://discord.com/developers/applications):

- **Bot → Privileged Gateway Intents:** enable **Server Members Intent**.
  Miss this on any one member and its login fails with `DisallowedIntents`.
- **Bot → Token:** generate and copy — shown once.
- **Bot → Public Bot:** off is fine for testing.
- Invite each to the same guild with scope `bot` and the base permissions:

```
https://discord.com/oauth2/authorize?client_id=1540029211778220032&scope=bot&permissions=1049600
https://discord.com/oauth2/authorize?client_id=1540029657183682632&scope=bot&permissions=1049600
https://discord.com/oauth2/authorize?client_id=1540029933747830844&scope=bot&permissions=1049600
```

### 2. Configure

```bash
cp .env.example .env
$EDITOR .env                              # SB_TOKEN_ALFA, SB_TOKEN_BRAVO, SB_TOKEN_CHARLIE
cp config/fleet.example.yaml config/fleet.yaml
$EDITOR config/fleet.yaml                 # application_ids for each member
```

`config/fleet.yaml` is gitignored — tokens live only in `.env`, referenced
from the yaml by `token_env:`.

### 3. Run

```bash
npm install
npm run dev                               # or: docker compose up --build
curl -s localhost:3000/healthz | jq
```

Expected: `"verdict": "ok"`, three members with `loggedIn: true`, `status:
"Ready"`, one `controller: true` (alfa). To exercise resume, bounce a bot's
gateway. Inside the container's namespace works even when your host firewall
does not:

```bash
docker network disconnect starbridge_default starbridge-bot-1
sleep 20
docker network connect starbridge_default starbridge-bot-1
```

The log line to look for is `[<nato>] resumed session (no rejoin, no
chime)`. A fresh identify after an expired session is the acceptable
fallback path.

## Running the blind relay (step 3)

The relay activates when both channel IDs are set. Bravo joins the source and
listens; charlie joins the target and transmits.

### 1. Two voice channels

Create two voice channels in your Discord guild. Bravo needs `View Channel`
+ `Connect` on the source; charlie needs `View Channel` + `Connect` +
`Speak` on the target. Base invite permissions (1049600) cover Connect but
not Speak — grant Speak explicitly or use permission overwrites.

### 2. Add to `.env`

```bash
RELAY_SOURCE_CHANNEL_ID=...   # channel bravo joins
RELAY_TARGET_CHANNEL_ID=...   # channel charlie joins
```

### 3. Run and verify

```bash
docker compose up --build
```

Expected log lines:

```
relay: bravo -> charlie (<source> -> <target>)
relay: source ready — listening on <source name>
relay: target ready — transmitting on <target name>
relay: bridge open
```

Manual verification bar:

1. Bravo appears in the source channel, charlie in the target.
2. From a second Discord account, join the source and talk. Have a listener
   on the target confirm they hear you.
3. **No join chime between transmissions.** The connection is held open;
   the "user joined voice" chime should only fire when charlie itself first
   joined, and never again.
4. `docker compose exec bot curl -s localhost:3000/healthz | jq .relay`
   shows `transmissions > 0`, `lastLatencyMs` around 50–200 ms, and
   `fleetAudioDropped` remains 0 while only humans transmit. It should
   *increment* if you deliberately have alfa transmit into the source (via
   another means), proving §5 suppression is active.

### What can go wrong

| Symptom | Likely cause |
|---|---|
| `relay: failed to start — ... is not a guild voice channel` | Wrong channel ID, or the bot lacks View Channel there. |
| Bravo joins, no audio arrives | Source channel has permission overwrites hiding it from bravo. |
| Charlie joins but nobody hears audio | Charlie lacks Speak on the target — grant it. |
| Latency > 500 ms consistently | Opus decode path was substituted for the direct forward — check the code around `StreamType.Opus`. |

## Running the receive spike (step 1)

Kept for regression diagnosis of DAVE receive.

```bash
cp .env.example .env
$EDITOR .env        # SPIKE_TOKEN, SPIKE_GUILD_ID, SPIKE_CHANNEL_ID
npm install
npm run spike
```

### A note on the Opus codec

`@discordjs/opus` (native, fast) is an **optional** dependency. If its build
fails — no prebuild for your Node ABI or glibc, no toolchain — npm continues and
`prism-media` falls back to `opusscript`, a pure-JS decoder. That is slower but
correct, and fine for the spike and for development. The Docker image carries
`build-essential` and builds the native path.

`npm audit` reports findings against `tar` inside `@discordjs/node-pre-gyp`.
That chain exists only to download and unpack `@discordjs/opus` prebuilds at
install time; it is not on any runtime path in the app.

Then join the voice channel and talk. The spike joins `selfDeaf: false,
selfMute: true` — it listens and never transmits.

```
@discordjs/voice 0.19.2 (ok)
logged in as Star Bridge Alfa#1234
joining "Command Alfa" in "Fleet Ops"
voice connection ready — talk in the channel now
health: http://localhost:3000/healthz

  + speaking: ulrich#0001 [user]
[ready] speakers=1 reconnects=0
  user ulrich#0001            pkts=   187 pcm=   718KiB peak= -14.2dBFS  ############........
```

Ctrl-C for the verdict.

### Spike verdicts

| Verdict | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | Decoded PCM above the noise floor. DAVE receive works. Proceed to step 2. |
| `FAIL` | 1 | Speaking events fired, zero PCM decoded. Receive is broken — remediation is printed. |
| `INCONCLUSIVE` | 2 | Nobody spoke, or levels below threshold. Not a failure; run it again and talk. |

A failed DAVE handshake yields *no packets*, not garbage, so sustained non-zero
RMS on a decoded stream is conclusive proof the AEAD open succeeded. No audio is
written to disk — the level meter is the evidence.

### Spike, unattended

```bash
SPIKE_RUN_SECONDS=60 npm run spike; echo "verdict exit: $?"
```

### In Docker

```bash
docker compose up --build          # dev target, src mounted
curl -s localhost:3000/healthz     # from inside the container network
```

`./data` must be writable by uid 1000 — the container runs as `node`:

```bash
sudo chown -R 1000:1000 data
```

## Layout

```
docs/spec.html            the specification — read this first
src/index.ts              entrypoint: config → db → sweep → fleet → relay → status
src/spike/receive.ts      step 1: decrypted per-SSRC PCM under DAVE (kept)
src/fleet/manager.ts      one process, N gateway-parked clients
src/fleet/boot-sweep.ts   crash recovery — runs before the fleet connects
src/fleet/status.ts       /healthz JSON: per-member verdict
src/relay/blind.ts        step 3: hardcoded source→target audio bridge
src/relay/metrics.ts      relay stats + §5 fleet suppression check
src/lib/config.ts         fleet.yaml + token env resolution
src/lib/db.ts             SQLite, WAL, full §11 schema
src/lib/audio.ts          PCM level metering (spike)
src/lib/env.ts            env loading (Node native, no dotenv)
config/                   fleet config; fleet.yaml is gitignored
cues/                     cue audio; see cues/README.md
data/                     SQLite, host-mounted
Dockerfile                multi-stage, Debian (never Alpine)
docker-compose.yml        + .override.yml (dev) + .prod.yml
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Run the fleet from source, reload on edit |
| `npm run spike` | Run the receive spike (step 1) |
| `npm run spike:watch` | Same, reloading on edit |
| `npm test` | Unit tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `docker compose up` | Dev container |
| `docker compose --profile stt up` | Add the transcription service (step 5) |

## Constraints worth knowing before you edit

Full list in [`CLAUDE.md`](CLAUDE.md); the reasoning is in the spec.

- `@discordjs/voice` stays pinned `^0.19.2`.
- Debian images only — native modules (`better-sqlite3`, `@snazzah/davey`, `@discordjs/opus`) break on musl.
- Fleet audio is dropped before detection, or the fleet talks to itself.
- Audio is never persisted.
- Channels are never renamed (~2 PATCH per 10 min limit).
- Never `client.destroy()` on transient disconnect — discord.js resumes automatically; destroying forces a fresh join and emits the join chime.

## Next

Step 4: cue engine. Pre-encoded Opus assets, duration validation at startup,
simultaneous playback into source and target so the caller and the receiver
both hear `Ready` and `Attention` at exactly the same time. Testable with a
hard-coded call-up before the STT and grammar work of step 6.
