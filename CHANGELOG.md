# Changelog

All notable changes to Star Comms. Versions are semver `major.minor.patch`;
each entry mirrors the GitHub release description on the matching tag.

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
