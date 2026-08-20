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
controller application** on top of N squad bots:

- Controller: registers `/star-bridge`, holds `MANAGE_CHANNELS`, `MANAGE_ROLES`,
  `MOVE_MEMBERS`, `MUTE_MEMBERS`. Does not join voice.
- Squad: alfa, bravo, charlie, …. Each holds `CONNECT`, `SPEAK`,
  `PRIORITY_SPEAKER` on the voice channels it is provisioned into. None is a
  controller.

This is a cleaner separation of concerns and matches the user's Discord
application layout (the step 1 spike bot becomes the controller). Anywhere the
spec says "member Alfa is controller", read "the controller application is a
separate bot". `bots.is_controller` in the §11 schema still applies to the
controller row; alfa's row has `is_controller = 0`.

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
