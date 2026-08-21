# Star Comms

Click-driven Discord voice-channel bridge for cooperative gameplay.

A channel owner presses a button, the bot picks a target from a directory
of hailable channels, and audio flows both ways for as long as anyone
talks. No speech recognition anywhere; every action is user-initiated
through slash commands or button clicks.

Full specification: **[`docs/spec.html`](docs/spec.html)**.

---

## Status

**Step 2 of 10** (spec §15) — vessels. `/star-comms init` picks the
guild's join-to-create voice channel; when a member joins it, the
controller creates a vessel channel named `🔊 <display name>`, moves
them in, records it in the DB, and posts a welcome message. Empty
vessels are auto-deleted after 30 seconds. Subsequent steps add the
callsign registry, control panel buttons, and hail flow.

The receive spike (`src/spike/receive.ts`) is retained as a DAVE
smoke test — run it after any `@discordjs/voice` or `@snazzah/davey`
version bump.

## Running the fleet

### 1. Register 4 applications (1 controller + 3 relays)

In the [developer portal](https://discord.com/developers/applications):

- For each app: **Bot → Privileged Gateway Intents:** enable
  **Server Members Intent**. **Bot → Token:** copy — shown once.
- **Controller** invite (needs `applications.commands` + admin
  permissions). Administrator during test is the easy path:
  ```
  https://discord.com/oauth2/authorize?client_id=<CONTROLLER_APP_ID>&scope=bot%20applications.commands&permissions=8
  ```
  For a narrower production set (View + Manage Channels + Manage Roles
  + Connect + Move Members + Send Messages + Embed Links + Read
  History + Add Reactions), use `permissions=301026640`.
- **Relay** invites (voice + priority speaker):
  ```
  https://discord.com/oauth2/authorize?client_id=<RELAY_APP_ID>&scope=bot&permissions=3147008
  ```

### 2. Configure

```bash
cp .env.example .env
$EDITOR .env                              # SB_TOKEN_CONTROLLER + SB_TOKEN_{ALFA,BRAVO,CHARLIE}
cp config/fleet.example.yaml config/fleet.yaml
$EDITOR config/fleet.yaml                 # application_ids for each app
```

`config/fleet.yaml` is gitignored — tokens live only in `.env`,
referenced from the yaml by `token_env:`.

### 3. Cue audio

```bash
scripts/gen-cues.sh
```

Generates the five placeholder cues (`ready`, `attention`, `busy`,
`ring`, `end`) as distinct sine tones at 1200 ms. Real assets drop in
later without code changes: same filenames, same equal duration.

### 4. Run

```bash
npm install
npm run dev                               # or: docker compose up --build
curl -s localhost:3000/healthz | jq
```

Expected: `verdict: "ok"`, four members with `loggedIn: true`,
`status: "Ready"`, one with `role: "controller"` and three relays.

In Discord, `/star-comms status` should return an ephemeral fleet
snapshot.

### 5. Init the guild + create your first vessel (step 2)

```
/star-comms init
```

Pick your guild's existing join-to-create voice channel from the
select menu (many game-community servers already have one — e.g.
`+ Create Channel`). Star Comms remembers that channel per guild.

Now join that channel from a regular user account. Expected:

- A new voice channel `🔊 <your display name>` appears under the
  same category as the trigger.
- You are automatically moved into it.
- A message appears in the vessel's built-in voice-text chat
  welcoming you.
- When everyone leaves, the channel auto-deletes after 30 s
  (immediate rejoin cancels the cleanup).

If you are the guild owner, Discord blocks the automatic move —
join the newly-created vessel manually. The welcome message tells
you as much.

## Running the receive spike

Kept as a regression test for DAVE receive. Run it against a live
guild after any `@discordjs/voice` or `@snazzah/davey` bump.

```bash
cp .env.example .env
$EDITOR .env        # SPIKE_TOKEN, SPIKE_GUILD_ID, SPIKE_CHANNEL_ID
npm install
npm run spike
```

### A note on the Opus codec

`@discordjs/opus` (native, fast) is an **optional** dependency. If its
build fails — no prebuild for your Node ABI or glibc, no toolchain —
npm continues and `prism-media` falls back to `opusscript`, a pure-JS
decoder. Slower but correct, fine for dev. The Docker image carries
`build-essential` and builds the native path.

### Spike verdicts

| Verdict | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | Decoded PCM above the noise floor. DAVE receive works. |
| `FAIL` | 1 | Speaking events fired, zero PCM decoded. Receive is broken. |
| `INCONCLUSIVE` | 2 | Nobody spoke, or levels below threshold. Not a failure; run it again and talk. |

A failed DAVE handshake yields *no packets*, not garbage, so sustained
non-zero RMS on a decoded stream is conclusive proof the AEAD open
succeeded. No audio is written to disk.

### In Docker

```bash
docker compose up --build          # dev target, src mounted
docker compose exec bot curl -s localhost:3000/healthz
```

`./data` must be writable by uid 1000 — the container runs as `node`:

```bash
sudo chown -R 1000:1000 data
```

## Layout

```
docs/spec.html            the specification — read this first
src/index.ts              entrypoint: config → db → sweep → cues → fleet → healthz
src/spike/receive.ts      DAVE receive smoke test
src/fleet/manager.ts      one process, N gateway-parked clients
src/fleet/boot-sweep.ts   crash recovery — runs before the fleet connects
src/fleet/status.ts       /healthz JSON: fleet verdict
src/commands/registrar.ts /star-comms slash-command dispatcher
src/commands/star-comms.ts    /star-comms command tree
src/session/relay.ts      audio-relay primitive (bidirectional in step 6)
src/lib/config.ts         fleet.yaml + token env resolution
src/lib/db.ts             SQLite, WAL, spec §10 schema
src/lib/cues.ts           cue loader, equal-duration validation
src/lib/audio.ts          PCM helpers + WAV wrapping
src/lib/env.ts            env loading (Node native, no dotenv)
config/                   fleet config; fleet.yaml is gitignored
cues/                     cue audio; see cues/README.md
data/                     SQLite, host-mounted
Dockerfile                multi-stage, Debian (never Alpine)
docker-compose.yml        + .override.yml (dev) + .prod.yml
scripts/gen-cues.sh       placeholder cue generator (sine waves via ffmpeg)
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Run the fleet from source, reload on edit |
| `npm run spike` | Run the receive spike |
| `npm run spike:watch` | Same, reloading on edit |
| `npm test` | Unit tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `docker compose up` | Dev container |

## Constraints worth knowing before you edit

Full list in [`CLAUDE.md`](CLAUDE.md); the reasoning is in the spec.

- `@discordjs/voice` stays pinned `^0.19.2`.
- Debian images only — native modules break on musl.
- Fleet audio is dropped before any downstream consumer, or the fleet talks to itself.
- Audio is never persisted.
- Never `client.destroy()` on transient disconnect — discord.js resumes automatically.
- Every `AudioPlayer` on a receive stream needs `maxMissedFrames: Infinity` and an `'error'` listener.

## Next

Step 3 — callsign registry. `/star-comms register <callsign>` stores
a per-member (guild-scoped) ship name; `unregister` / `callsign`
report and remove. The `[Allow hails]` control-panel button in step 5
looks up this table to decide whether a vessel can be added to the
hail directory.
