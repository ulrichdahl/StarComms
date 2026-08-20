# Star Bridge

Speech-routed Discord voice relay for fleet operations.

A commander speaks a call-up — *"Command Charlie"* — on a command net. The bot
recognises the verb and NATO callsign, opens the addressed net, plays `Ready`
back to the commander and `Attention` into the target, then relays the message
audio live in the commander's own voice.

Full specification: **[`docs/spec.html`](docs/spec.html)**.

---

## Status

**Step 5a of 9** (spec §16): init half of step 5. Steps 1–4 passed.

Adds a fourth "main" application (see CLAUDE.md "Divergence from spec"):
it runs `/star-bridge` slash commands AND will occupy the command net's
voice channel when a session opens. `/star-bridge init` provisions a
category (renamable by the guild) plus a single control text channel.
**Voice channels are created per session** (step 5b) and deleted at
teardown — the earlier "hidden pool of N voice channels" design in spec
§4 is superseded (see §17 #4).

The step 5a build does **not** yet include the session wizard, lead
selection, teardown timer, or AFK move — those land in step 5b. The blind
relay from step 3 still runs hardcoded bravo → charlie; step 6 replaces
the hardcoded pair with session-driven routing.

The step 4 build loads six cue assets (`ready`, `attention`, `horn`,
`negative`, `busy`, `out`) at startup, decodes them via ffmpeg, re-encodes
to Opus frames, and caches the packets in memory. Every asset in the
active set must match `cue_duration_ms` within a small tolerance — the
strict trio (ready/attention/horn) enforces ±40 ms because unequal lengths
clip the first word of every transmission (§5). Startup fails loud on a
mismatch.

Cue playback is exposed through `POST /trigger?verb=hail|command|broadcast`
on the status server. Bravo plays `Ready` into the source channel and
charlie plays `Attention` into the target simultaneously, with the delta
between the two AudioPlayers' Playing state transitions surfaced via
`/healthz .relay.cues.peakSyncErrorMs`.

The step 4 build does **not** implement STT, callsign detection, verb
grammar, session lifecycle, mirror embeds, ducking, or the
priority-speaker mute mode. `/trigger` is manual — voice-driven triggers
arrive with step 6.

Earlier steps are retained: `src/spike/receive.ts` still runs via
`npm run spike` for DAVE-receive regression diagnosis.

## Running the fleet (steps 2 + 5a)

### 1. Register 4 applications (1 controller + 3 squad)

The step-1 spike bot naturally becomes the controller. Squad build target
is N=3 (`alfa`, `bravo`, `charlie`) per spec §2 risk box.

For each application, in the [developer portal](https://discord.com/developers/applications):

- **Bot → Privileged Gateway Intents:** enable **Server Members Intent**.
  Miss this on any one bot and its login fails with `DisallowedIntents`.
- **Bot → Token:** generate and copy — shown once.
- **Bot → Public Bot:** off is fine for testing.
- Invite each to the same guild:
  - **Controller** (needs `applications.commands` for slash commands + admin permissions):
    ```
    https://discord.com/oauth2/authorize?client_id=<CONTROLLER_APP_ID>&scope=bot%20applications.commands&permissions=402926608
    ```
  - **Squad** (voice: View + Connect + Speak + Priority Speaker at the guild level, so pool channels inherit them without the controller having to grant them in overwrites):
    ```
    https://discord.com/oauth2/authorize?client_id=<SQUAD_APP_ID>&scope=bot&permissions=3146752
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

Expected: `"verdict": "ok"`, four members with `loggedIn: true`, `status:
"Ready"`, one with `role: "controller"` and three squad. To exercise resume, bounce a bot's
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

## Running /star-bridge init (step 5a)

Once the fleet is up, run `/star-bridge init` in any text channel of the
guild (a member with **Manage Guild** must issue it). Expected:

- A `Star Bridge` category appears (renamable by the guild).
- One text channel `#star-bridge-ops` under it, hidden from `@everyone` —
  the operations console where slash commands and mirror embeds land.
- The ephemeral reply lists the created/reused ids.

Voice channels are **not** created at init time. They are created per
session by `/star-bridge open` (step 5b) named for the mode
(`Command`/`Alpha`/`Bravo`/`Charlie` in command mode) and deleted at
teardown — see §17 #4 in the spec and the CLAUDE.md divergence note.

Re-running init is idempotent — the second run reports the category and
control channel as "reused". Delete either manually and re-run to see
init recreate it.

`/star-bridge status` reports the current fleet state.

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
| Bravo in target channel, charlie missing | `joinVoiceChannel` needs `group` per bot. Fixed since commit b00328d — regression guard is in `blind.ts`. |

## Running the cue engine (step 4)

Cues load at startup from `config/fleet.yaml` `cue_sets.<name>.<locale>`.
Bravo also needs `Speak` on the source channel to play `Ready` — grant it
alongside the target-side `Speak` for charlie.

### 1. Generate placeholder cues (or drop your own)

```bash
scripts/gen-cues.sh
```

Writes six 1200 ms sine-wave WAVs into `cues/en/` and `cues/`. Distinct
frequencies per cue, so you can tell them apart by ear during the test.
Real cues (TTS or recorded) drop in later without code changes: same
filenames, same equal duration, same 48 kHz stereo.

### 2. Verify at startup

```
cues: loaded 6 at ~1200 ms each
  ready       1200 ms  60 packets  cues/en/ready.wav
  attention   1200 ms  60 packets  cues/en/attention.wav
  ...
relay: bridge open — cues armed
health: http://localhost:3000/healthz    trigger: POST /trigger?verb=hail
```

### 3. Fire a call-up

```bash
docker compose exec bot curl -sS -X POST 'http://localhost:3000/trigger?verb=hail' | jq
```

Expected:
- A tone plays in **reception** (bravo, `Ready`) and simultaneously in
  **test 1** (charlie, `Attention`) — different frequencies, same length.
- The endpoint returns `202 { "fired": "ready+attention", "verb": "hail" }`.
- `docker compose exec bot curl -s http://localhost:3000/healthz | jq .relay.cues`:
  ```
  {
    "loaded": true,
    "count": 1,
    "lastSyncErrorMs": 8,
    "peakSyncErrorMs": 8,
    "lastPair": { "source": "ready", "target": "attention" },
    "lastPlayedAt": "2026-08-20T..."
  }
  ```
  `peakSyncErrorMs` under 50 ms is a pass. Anything > 100 ms indicates
  the two AudioPlayers are drifting on kickoff — investigate before step 5.

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
src/relay/blind.ts        step 3+4: audio bridge + cue playback
src/relay/metrics.ts      relay stats + §5 fleet suppression check
src/lib/cues.ts           step 4: cue loader, equal-duration validation
src/commands/registrar.ts step 5a: /star-bridge slash-command dispatcher
src/commands/star-bridge.ts   /star-bridge command tree
src/pool/provisioning.ts  step 5a: channel-pool creation + repair
scripts/gen-cues.sh       placeholder cue generator (sine waves via ffmpeg)
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

Step 5b: the session wizard. `/star-bridge open` modal, lead selection,
target callsigns, session row, teardown timer, MOVE_MEMBERS the lead into
the command net, AFK-move for stragglers at close. The blind relay's
hardcoded bravo→charlie routing will be replaced by session-driven wiring
in step 6.
