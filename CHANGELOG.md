# Changelog

All notable changes to Star Comms. Versions are semver `major.minor.patch`;
each entry mirrors the GitHub release description on the matching tag.

## 0.3.2 — 2026-08-29

Patch release: transfer notices name only the new owner.

### What's in this release

#### Ownership-transfer notice
- The channel notice posted after an ownership transfer (manual **Transfer** button or automatic hand-over when the owner leaves) names only the new owner. It no longer mentions the previous owner, in every locale.

### Upgrading from 0.3.1
- No schema or config changes. Redeploy.

## 0.3.1 — 2026-08-29

Patch release: panels update on deploy, and the running version is visible.

### What's in this release

#### Control panels re-render at boot
- Every live vessel control panel is re-rendered once at startup, right after the boot reconciliation. A deploy that changes the panel (0.3.0 added the **Transfer** button) now updates panels posted by the previous version immediately instead of on the next click. Log line: `panels[boot]: updated=N skipped=M`.

#### Version display
- `/star-comms status` opens with the running version (`… · v0.3.1`).
- `/healthz` gains a `version` field.
- The boot log's first line is `star-comms v<version>`.

### Upgrading from 0.3.0
Redeploy. No configuration or data changes. Existing panels gain the Transfer button on this boot.

## 0.3.0 — 2026-08-29

Ownership transfer from the control panel, rename-gated; rate-limited renames now fail fast.

### What's in this release

#### Transfer button
- New **Transfer** (👑) button on row 1 of the vessel control panel, owner-only. It opens a select of the humans currently in the voice channel (excluding the owner); picking one hands the vessel over: the channel is renamed `🔊 <new owner>`, the vessel leaves the hail directory (the callsign belonged to the old owner, so hails are off), the panel is re-rendered in place and a notice is posted in the channel.
- Refused while the vessel is in an active hail — a hail leg follows the owner's voice.
- Strings in all four locales.

#### Rename-gated transfer, shared by the manual and automatic paths
- The existing owner-left auto-transfer (30 s grace window) and the new button use one routine. It renames the channel **first** and does nothing else unless that succeeds; a rate-limited or failed rename leaves the database untouched.
- Manual: the owner is told the rename limit is reached and to try again in ~10 minutes.
- Automatic: retries every 60 s, up to 15 times, while the owner is still absent and the channel still populated. An owner rejoin or the channel emptying cancels the retries.

#### Fix: rate-limited renames now fail fast instead of hanging
- `@discordjs/rest` defaults to *queueing* 429s, so a rate-limited channel rename silently waited up to 10 minutes and none of the existing "rename limit reached — try again in ~10 minutes" replies could ever fire. The fleet's Clients now reject rate limits on `PATCH /channels/:id` only (`src/lib/rate-limit.ts`); every other route keeps the default. All rename paths detect the result with `isRateLimitError`.
- Recorded as a hard constraint in `CLAUDE.md` and in the spec (§3, §4; the §16 "ownership transfer" future-work row is marked shipped).

### Upgrading from 0.2.3
Redeploy. No configuration or data changes. Existing panels gain the Transfer button the next time they are re-rendered (any click, a language change, or a register/unregister).

## 0.2.3 — 2026-08-29

Patch release: control panels follow callsign changes immediately.

### What's in this release

#### Panels re-render on register / unregister
- `/star-comms register` now re-renders the invoker's vessel control panel in place: **Allow hails** becomes enabled and the "register a callsign" hint disappears, without waiting for a button click.
- `/star-comms unregister` does the same in reverse: the panel shows hails off with **Allow hails** (and **Hail**) disabled, matching the vessel's removal from the hail directory.
- Implementation: `panel-refresh.ts` gains `refreshOwnerPanels` alongside the guild-wide refresh used by `set-language`; the callsign handlers fire an `onChanged` hook wired to it. Best-effort — a failed re-render is logged, never shown to the member.

### Upgrading from 0.2.2
Redeploy. No configuration or data changes.

## 0.2.2 — 2026-08-29

Patch release: cue audio lives on a named volume, so a fresh deploy needs no host-side steps.

### What's in this release

#### Cues on a named volume
- `docker-compose.coolify.yml` mounts `starcomms-cues:/app/cues` (named volume) instead of a bind mount of a host directory. Docker copies the image's `node` ownership onto an empty named volume on first mount — the same mechanism that makes `/data` writable — so the boot-time cue generation introduced in 0.2.1 can write immediately. The manual `chown -R 1000:1000 …` step is gone.
- The entrypoint's not-writable hint now describes both remedies (named volume, or chown a bind directory).

#### Docs
- `docs/coolify.md` Cues section: a standard install has nothing to do; explains named volume vs bind mount; `docker cp` recipe for replacing voices with hand-made WAVs; migration note for ≤ 0.2.1 installs.

### Upgrading from 0.2.1
1. Redeploy. Coolify creates the `starcomms-cues` volume; the first boot logs `cues: 22 written, 0 kept`.
2. The old host directory `/data/coolify/applications/<APP_UUID>/cues` is no longer mounted. If it held hand-made voices, copy them in: `docker cp <dir>/. bot-<APP_UUID>:/app/cues/`, then restart. Otherwise delete it.

## 0.2.1 — 2026-08-29

Patch release: cue audio is generated automatically inside the deployed container.

### What's in this release

#### Cue audio generates itself on boot
- The runtime image now ships `generate-cues.sh` together with **espeak-ng** (alongside ffmpeg), and a new `docker-entrypoint.sh` runs it in skip-existing mode against `/app/cues` before starting the fleet. A first deploy boots with a complete cue set for all four locales (22 files); a file that already exists — e.g. a hand-made Piper voice — is never overwritten. Delete a file and restart to regenerate it.
- `generate-cues.sh` gained `SKIP_EXISTING=1` and prints a `N written, M kept` summary. It can also be run by hand from Coolify → Terminal (`LOCALES="da-pirate" SKIP_EXISTING=1 ./generate-cues.sh`).
- `GENERATE_CUES=0` in the environment disables the boot-time step.
- The entrypoint `exec`s node, so SIGTERM still reaches the drain handler on stop.

#### Coolify compose
- The `./cues:/app/cues` bind mount is no longer read-only, and `/app/cues` is created owned by `node` in the image.
- If the host directory is not writable by uid 1000 the boot log prints a `chown -R 1000:1000 …` hint and the fleet still starts (without cue audio) — no crash-loop from this step.

#### Docs
- `docs/coolify.md` "Cues" section rewritten: one-time `chown`, automatic generation, replacing voices, manual run, `GENERATE_CUES`.

### Upgrading from 0.2.0
1. Redeploy (image rebuild — espeak-ng is added).
2. Once, on the Coolify host: `chown -R 1000:1000 /data/coolify/applications/<APP_UUID>/cues`
3. Restart the app. The boot log shows `cues: N written, M kept`; your existing `en` files are kept, the missing locales are generated.

## 0.2.0 — 2026-08-29


### What's in this release

### Language is now a guild setting
- **`/star-comms set-language`** (Manage Server) — select menu with 🇬🇧 English, 🇩🇰 Dansk, 🏴‍☠️ English (Pirate), 🏴‍☠️ Dansk (Sørøver). Stored per guild in `guilds.locale`; the confirmation is already in the new language.
- Every Discord-visible string moved into `src/lib/i18n.ts` — one typed table per locale, so the compiler refuses a locale missing a key. Covers control-panel buttons and status lines, modals, hail Accept/Decline/End buttons, vessel notices, callsign errors and slash-command descriptions.
- Slash commands are registered per guild in its language and re-registered when it changes.
- **Every live control panel in the guild is re-rendered immediately** on a language change.
- Voice cues are per locale: a `CueLibrary` loads every locale block under `cue_sets` at boot. The default locale is mandatory; a locale without WAVs falls back to the default's audio with a warning, so a guild can switch language before its audio is installed.
- `generate-cues.sh` produces all four locale directories with espeak-ng (22 files, 48 kHz stereo).
- Language is per guild, never per user — Discord renders a bot's buttons and posts identically to everyone. Recorded as a hard constraint.

### Command rename
- `/star-comms init` → **`/star-comms watch-channel`**. Same behaviour: picks the join-to-create trigger channel.

### Deployment fixes (Coolify)
- `docker-compose.coolify.yml` declares `fleet.yaml` and `cues/` as relative bind mounts instead of named volumes. The Compose build pack only manages storage declared in the compose file; the empty named volume was shadowing the config file mount (`fleet.yaml` not found).
- Dockerfile ships `/data` owned by `node` so the SQLite named volume is writable on first mount (`SqliteError: unable to open database file`).
- `docs/coolify.md` rewritten around the declared mounts, with host paths and in-container mount inspection.

### Housekeeping
- `config/fleet.example.yaml` gains the `en-pirate`/`da-pirate` blocks and the previously missing `established`/`disconnected` cues.
- Git workflow documented in `CLAUDE.md`: work on `develop`, release by merging to `main`, tag `vX.Y.Z`, GitHub release with notes.

### Upgrading from 0.1.0
1. Add the new locale blocks from `config/fleet.example.yaml` to your `fleet.yaml` (optional — missing locales warn and fall back to the default).
2. Generate and install the cue audio: `./generate-cues.sh`, then copy `cues/` to the host directory Coolify mounts at `/app/cues`.
3. Existing guilds keep `locale = en`; nothing changes until an admin runs `/star-comms set-language`.
4. Anyone with `/star-comms init` in muscle memory: it is now `/star-comms watch-channel`.

## 0.1.0 — 2026-08-28

First tagged release: fleet of 1 controller + 3 relays, join-to-create
vessels with in-channel control panel, N-way hails with ring/accept,
locale-aware cues, reconciliation, Coolify deploy path, AGPL-3.0.
