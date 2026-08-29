# Star Comms

Click-driven Discord voice-channel bridge for cooperative gameplay. A
channel owner presses a button, the bot picks a target from a directory
of hailable channels, and audio flows both ways for as long as anyone
talks.

**The specification is `docs/spec.html`.** Read it before changing
behaviour — it is the contract, and the non-obvious constraints are
recorded there with their reasons.

## Fleet layout

v1 ships with **4 Discord applications**:

- **Controller** — registers `/star-comms`, creates + moves vessels via
  the join-to-create trigger, holds `MANAGE_CHANNELS`, `MANAGE_ROLES`,
  `MOVE_MEMBERS`. Never joins voice.
- **Relays** (alfa / bravo / charlie) — pool of voice bots allocated to
  channels as hails require. Each holds `CONNECT`, `SPEAK`,
  `PRIORITY_SPEAKER`. Join on hail open, leave on hail close.

The 4-app total supports up to 3 channels-in-hail concurrently in one
guild. If v2 needs 4, the controller becomes pool-eligible.

## Hard constraints — violating these breaks the product

Retained across the pivot from earlier iterations because they are
consequences of Discord's protocol and `@discordjs/voice`'s API, not of
the previous product's design.

- `@discordjs/voice` pinned `^0.19.2`. 0.19.0 and 0.19.1 cannot decrypt
  received audio under mandatory DAVE E2EE. Never relax this pin.
- **Debian base images, never Alpine.** `@snazzah/davey`,
  `@discordjs/opus` and `better-sqlite3` are native; musl breaks them.
- **Drop all audio from fleet user IDs before any downstream consumer**,
  unconditionally. Without it a played cue re-triggers `speaking.start`
  on the same connection and the fleet talks to itself. Highest-
  consequence bug available.
- **Never write audio to disk.** Audit records persist; audio does not.
- Cue assets `ready` and `attention` must be equal length D<sub>c</sub>
  and are validated at startup — they play concurrently across channels
  and must end together or the first word clips.
- **Never `selfMute`** on any voice connection — every relay bot must
  be able to play cues. Set `selfDeaf: false` too since v1 relays are
  bidirectional.
- **Every `joinVoiceChannel` call must set `group` to a value unique
  per bot** (we use the joining client's `user.id`). `@discordjs/voice`
  keys connections by `(guildId, group)` with default `'default'`;
  without per-bot scoping a second bot's join rebinds the first bot's
  connection to the new channel and the second bot never actually
  joins.
- **`adapterCreator` must be built from the joining bot's own `Guild`
  object.** `guild.voiceAdapterCreator` binds to the WebSocket of
  whichever Client cached that Guild. Taking the guild from the
  interaction (controller's Client) and passing its adapter to a relay
  bot's join causes the relay's gateway `VOICE_STATE_UPDATE` to reach
  the relay's WebSocket with nothing listening — the connection times
  out with "The operation was aborted". Always resolve the joining
  bot's own guild view (`client.guilds.cache.get(guildId)`, fetch if
  empty) and use *that* adapter.
- **Any `AudioPlayer` fed from a `receiver.subscribe` stream must set
  `behaviors.maxMissedFrames: Infinity`.** The default is 5. During a
  natural inter-word pause the receive stream's `.read()` returns null
  for more than 5 consecutive 20 ms frames, and the player abandons the
  resource even though the stream is still alive. Cue-playback players
  keep the default 5 (finite resources should not be immortal).
- **Every `AudioPlayer` and receive `opusStream` in the receive path
  must have an `'error'` listener.** DAVE decryption occasionally fails
  at key-rotation boundaries
  (`DecryptionFailed(UnencryptedWhenPassthroughDisabled)`), and the
  error propagates from `AudioReceiveStream` → `AudioResource` →
  `AudioPlayer`. An unhandled `'error'` on any of those crashes the
  whole Node process. Swallow the DAVE-specific message and continue;
  log anything else.
- **`AudioReceiveStream` emits `'close'`, not `'end'`, on
  `EndBehaviorType.AfterSilence` cleanup.** Watch for both events when
  waiting for a receive stream to finish, or the max-hold timer wins
  the race even after the stream has closed.
- **Do not `.on('data', …)` on an `AudioReceiveStream` you are also
  feeding to `createAudioResource(inputType: StreamType.Opus)`.** The
  extra listener flips the Readable into flowing mode and `read()`
  returns null; the target player transmits nothing. Diagnose from
  `AudioPlayer` state transitions and `AudioResource.playbackDuration`
  instead.
- **Discord's guild owner cannot be moved by a bot**, regardless of
  the bot's permissions. `MOVE_MEMBERS` on the guild owner always
  fails. Detect the case up front and skip with a clear reply.
- **Channel rename PATCH is limited to ~2 per 10 min per channel.**
  User-driven renames are best-effort — surface Discord's 429 back to
  the operator ("try again in ~10 minutes") rather than queuing.
- **`@discordjs/rest` queues 429s by default** — a rate-limited rename
  silently *waits up to 10 minutes* instead of throwing, so no "abort
  on rate limit" logic can work under the default. The fleet's Clients
  set `rest.rejectOnRateLimit` to `rejectChannelPatchRateLimit`
  (`src/lib/rate-limit.ts`), which rejects `PATCH /channels/:id` only.
  Never remove it, and detect the result with `isRateLimitError`, not
  by message matching. Ownership transfer is gated on the rename
  succeeding for exactly this reason.
- **Language is per guild, never per user.** Discord renders a bot's
  buttons and channel posts identically for every member, so
  `guilds.locale` is the only unit of localisation. No user-facing
  string may be a literal in a handler — add it to every table in
  `src/lib/i18n.ts` (the `Strings` interface makes the compiler
  enforce completeness) and resolve via the guild's locale. Cue audio
  is per locale too; a missing locale falls back to the default
  locale's audio, never to silence or a crash.

## Git workflow — production is live

- **Never commit to `main` directly.** All work happens on `develop` or
  on a feature branch cut from `develop` and merged back into it.
- `main` is what Coolify deploys. It only moves by merging `develop`.
- **Release procedure:** when `develop` is deemed stable, make one final
  commit on `develop` with the version bump (`package.json`, semver
  `major.minor.patch`) and any release housekeeping (docs, changelog).
  Merge `develop` → `main`, then tag `main` `vX.Y.Z` and create a GitHub
  release on that tag whose description lists what went into it.
- Tagging and publishing a release is outward-facing — do it only when
  asked to ship.

## Build order

Spec §15. Step 1 is the current clean-up pass — legacy modules removed,
identifiers moved into the `star-comms` namespace, schema replaced.
The receive spike (`src/spike/receive.ts`) is retained as the DAVE
smoke test.

## Layout

    docs/spec.html         the specification
    src/spike/receive.ts   DAVE decrypt smoke test (`npm run spike`)
    src/index.ts           entrypoint (fleet + healthz + /star-comms status)
    src/fleet/             manager, boot sweep, healthz
    src/commands/          slash registrar + /star-comms tree
                           (watch-channel, set-language, callsigns, panel)
    src/lib/i18n.ts        per-locale string tables — every Discord-visible
                           string lives here; locale is per guild
    src/session/relay.ts   bidirectional audio-relay primitive
                           (extended into runHailLeg in step 6)
    src/lib/               config, db, cues, audio helpers, env, pkg
    config/                fleet config (fleet.yaml is gitignored)
    cues/                  cue audio (gitignored)
    data/                  SQLite, host-mounted

## Commands

    npm run spike        run the DAVE receive spike against .env
    npm run dev          run the fleet from source, reload on edit
    npm test             unit tests
    npm run typecheck    tsc --noEmit
    docker compose up    dev container (src mounted, dev target)
