# Star Bridge

Speech-routed Discord voice relay for fleet operations.

A commander speaks a call-up — *"Command Charlie"* — on a command net. The bot
recognises the verb and NATO callsign, opens the addressed net, plays `Ready`
back to the commander and `Attention` into the target, then relays the message
audio live in the commander's own voice.

Full specification: **[`docs/spec.html`](docs/spec.html)**.

---

## Status

**Step 1 of 9** (spec §16): the receive spike. Nothing else is built yet.

The spike exists to answer one question before any effort goes into the rest:
can this bot get decrypted, per-speaker PCM out of a real guild under Discord's
mandatory DAVE end-to-end encryption? Since 2 March 2026 there is no
unencrypted fallback, and `@discordjs/voice` 0.19.0–0.19.1 could transmit but
never decrypt inbound audio. Everything in this project is downstream of that
working.

## Running the spike

### 1. One Discord application

Create it in the [developer portal](https://discord.com/developers/applications):

- **Bot → Privileged Gateway Intents:** enable **Server Members Intent**.
- **Bot → Token:** generate and copy it. It is shown once.
- Invite it with scope `bot` and permissions **View Channel** + **Connect**:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1049600
```

### 2. Configure

```bash
cp .env.example .env
$EDITOR .env        # SPIKE_TOKEN, SPIKE_GUILD_ID, SPIKE_CHANNEL_ID
```

Channel and guild IDs: enable Developer Mode in Discord, right-click → Copy ID.

### 3. Run

```bash
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

### Verdicts

| Verdict | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | Decoded PCM above the noise floor. DAVE receive works. Proceed to step 2. |
| `FAIL` | 1 | Speaking events fired, zero PCM decoded. Receive is broken — remediation is printed. |
| `INCONCLUSIVE` | 2 | Nobody spoke, or levels below threshold. Not a failure; run it again and talk. |

A failed DAVE handshake yields *no packets*, not garbage, so sustained non-zero
RMS on a decoded stream is conclusive proof the AEAD open succeeded. No audio is
written to disk — the level meter is the evidence.

### Unattended

```bash
SPIKE_RUN_SECONDS=60 npm run spike; echo "verdict exit: $?"
```

### In Docker

```bash
docker compose up --build          # dev target, src mounted, spike running
curl -s localhost:3000/healthz     # from inside the container network
```

`./data` must be writable by uid 1000 — the container runs as `node`:

```bash
sudo chown -R 1000:1000 data
```

## Layout

```
docs/spec.html          the specification — read this first
src/spike/receive.ts    step 1: decrypted per-SSRC PCM under DAVE
src/lib/audio.ts        PCM level metering
src/lib/env.ts          env loading (Node native, no dotenv)
config/                 fleet config; fleet.yaml is gitignored
cues/                   cue audio; see cues/README.md
data/                   SQLite, host-mounted
Dockerfile              multi-stage, Debian (never Alpine)
docker-compose.yml      + .override.yml (dev) + .prod.yml
```

## Commands

| Command | Does |
|---|---|
| `npm run spike` | Run the receive spike |
| `npm run spike:watch` | Same, reloading on edit |
| `npm test` | Unit tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `docker compose up` | Dev container |
| `docker compose --profile stt up` | Add the transcription service (step 5) |

## Constraints worth knowing before you edit

Full list in [`CLAUDE.md`](CLAUDE.md); the reasoning is in the spec.

- `@discordjs/voice` stays pinned `^0.19.2`.
- Debian images only — native modules break on musl.
- Fleet audio is dropped before detection, or the fleet talks to itself.
- Audio is never persisted.
- Channels are never renamed (~2 PATCH per 10 min limit).

## Next

Step 2, once the spike passes: fleet manager — N tokens parked, resume-preferring
reconnect, `fleet status`, SQLite and the boot sweep.
