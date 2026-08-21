# Star Bridge

Speech-routed Discord voice relay. A commander speaks a call-up on a command
net; a fleet of bots opens the addressed net, plays confirmation cues, and
relays the message audio live.

**The specification is `docs/spec.html`.** Read it before changing behaviour —
it is the contract, and most of the non-obvious constraints are recorded there
with their reasons.

## Divergence from spec — the 4-bot layout

The spec (§2) puts the controller role on member Alfa — same application both
registers slash commands AND holds a squad net. This project uses a **separate
controller application on double duty**: it runs slash commands + channel
management AND occupies the main command net's voice channel.

- **Main / controller**: registers `/star-bridge`, holds `MANAGE_CHANNELS`,
  `MANAGE_ROLES`, `MOVE_MEMBERS`, `MUTE_MEMBERS`. Joins voice on **the
  command net** (mode: `command`) or **head-ops net** (mode: `joint`)
  when a session opens.
- **Squad**: alfa, bravo, charlie. Each joins its assigned squad net for
  the duration of the session. None is a controller.

Total applications in v1: **4** (main + 3 squad). This matches the step 1
spike bot naturally becoming the main. Anywhere the spec's §2 text says
"member Alfa is controller", read "the main application is controller and
occupies the command net". `bots.is_controller = 1` for the main; squad
rows have `is_controller = 0`.

## Divergence from spec — per-session channel creation

Superseding §4 of the spec draft ("hidden pool of N voice channels revealed
by permission overwrites"): voice channels are **created per session** and
deleted at teardown. Only the category and a single control text channel
are created at `/star-bridge init` time. Rationale: the ~2 rename per 10 min
PATCH limit only bit the pool design when it also renamed; per-session
create/delete uses a different, looser bucket and gives a cleaner sidebar.
The `channel_pool` table in §11 stays in the schema but is not populated
in v1.

## Hard constraints — violating these breaks the product

- `@discordjs/voice` pinned `^0.19.2`. 0.19.0 and 0.19.1 cannot decrypt received
  audio under mandatory DAVE E2EE. Never relax this pin. (§15)
- **Debian base images, never Alpine.** `@snazzah/davey`, `@discordjs/opus` and
  `better-sqlite3` are native; musl breaks them. (§13)
- **Drop all audio from fleet user IDs before detection**, unconditionally, in
  both modes. Without it a relayed cue re-triggers routing and the fleet talks
  to itself. Highest-consequence bug available. (§5)
- **Never write audio to disk.** Transcripts persist; audio does not. (§1)
- **Never rename a channel.** Channel name/topic PATCH is limited to ~2 per
  10 minutes. Provisioning is permission overwrites on a pre-created pool. (§4)
- **Never leave a human muted.** Hard-mute state is written to `mute_state`
  before the first mute request so the boot sweep can restore it. (§6)
- Cue assets must be equal length and validated at startup. (§5)
- `selfDeaf` on send-only squad nets only. Never `selfMute` — every listening
  bot must be able to play cues. (§3, §6)
- **Every `joinVoiceChannel` call must set `group` to a value unique per bot**
  (we use the joining client's `user.id`). `@discordjs/voice` keys connections
  by `(guildId, group)` with default `'default'`; without per-bot scoping a
  second bot's join rebinds the first bot's connection to the new channel and
  the second bot never actually joins. This bit us in step 3 — bravo appeared
  in the target channel and charlie never connected, with both `entersState`
  calls resolving Ready against the same shared connection.
- **Any `AudioPlayer` fed from a `receiver.subscribe` stream must set
  `behaviors.maxMissedFrames: Infinity`.** The default is 5. During a
  natural inter-word pause the receive stream's `.read()` returns null for
  more than 5 consecutive 20 ms frames, and the player abandons the
  resource even though the stream is still alive — the caller then hears
  a couple of seconds of audio and permanent silence. Cue playback keeps
  the default 5 (finite resources should not be immortal). This bit us in
  step 6a's hail: 2080 ms of audio, then Idle, then max-hold timed out.
- **Every `AudioPlayer` and receive `opusStream` in the receive path must
  have an `'error'` listener.** DAVE decryption occasionally fails at
  key-rotation boundaries (`DecryptionFailed(UnencryptedWhenPassthroughDisabled)`,
  spec §15), and the error propagates from `AudioReceiveStream` →
  `AudioResource` → `AudioPlayer`. An unhandled `'error'` on any of those
  crashes the whole Node process with `Unhandled 'error' event`. Swallow
  the DAVE-specific message and continue — the next packet decrypts fine.
  Log anything else. This bit us in step 6a during a live hail after ~1.2 s
  of audio had already transmitted.
- **`adapterCreator` must be built from the joining bot's own `Guild` object.**
  `guild.voiceAdapterCreator` binds to the WebSocket of whichever Client cached
  that Guild. If we take the guild from the interaction (controller's Client)
  and pass its adapter to alfa's join, alfa's gateway `VOICE_STATE_UPDATE`
  reaches alfa's WebSocket but nothing is listening — the connection times out
  with "The operation was aborted". Always resolve the joining bot's own guild
  view (`client.guilds.cache.get(guildId)`, fetch if empty) and use *that*
  adapter. This bit us in step 5b for main + alfa — the two bots that were not
  already voice-connected from earlier steps.

## Build order

Spec §16. Currently at **step 1: the receive spike** (`src/spike/receive.ts`).
Nothing else is built until it prints PASS on a real guild.

## Layout

    docs/spec.html        the specification
    src/spike/receive.ts  step 1 — proves decrypted per-SSRC PCM under DAVE
    src/lib/              shared helpers
    config/               fleet config (fleet.yaml is gitignored)
    cues/                 cue audio (gitignored)
    data/                 SQLite, host-mounted

## Commands

    npm run spike        run the receive spike against .env
    npm test             unit tests
    npm run typecheck    tsc --noEmit
    docker compose up    dev container (spike, dev target, src mounted)
