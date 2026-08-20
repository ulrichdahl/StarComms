# Star Bridge

Speech-routed Discord voice relay for fleet operations.

A commander speaks a call-up — *"Command Charlie"* — on a command net. The bot
recognises the verb and NATO callsign, opens the addressed net, plays `Ready`
back to the commander and `Attention` into the target, then relays the message
audio live in the commander's own voice.

Full specification: **[`docs/spec.html`](docs/spec.html)**.

---

## Status

**Step 2 of 9** (spec §16): the fleet manager. Step 1 (receive spike) passed.

The step 2 build brings up N applications in one process, each parked on the
gateway with the privileged `GUILD_MEMBERS` intent, discord.js resume enabled
so a network flap does not trigger a rejoin chime. It stands up the full spec
§11 SQLite schema and runs the boot sweep before the fleet connects, so a
crash mid-relay in later steps has one place to be recovered from. `/healthz`
reports per-member state as JSON.

The step 2 build does **not** join any voice channels — that is step 3's job.
"Parked" here means the gateway is up and the client is holding a session, not
that the bot has moved into a voice channel.

The step 1 spike (`src/spike/receive.ts`) is kept and still runs via
`npm run spike` — useful when diagnosing a receive regression.

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
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1049600
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
gateway (`iptables -I OUTPUT -d discord.com -j DROP` for ~20s, then unblock);
the log line to look for is `[alfa] resumed session (no rejoin, no chime)`.

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
src/index.ts              step 2 entrypoint: config → db → sweep → fleet → status
src/spike/receive.ts      step 1: decrypted per-SSRC PCM under DAVE (kept)
src/fleet/manager.ts      one process, N gateway-parked clients
src/fleet/boot-sweep.ts   crash recovery — runs before the fleet connects
src/fleet/status.ts       /healthz JSON: per-member verdict
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

Step 3: blind relay. Hard-coded source/target, raw copy, stream held open with
silence frames. Measure latency; confirm no runtime chimes and no first-word
clipping.
