# Cue audio

Five cues per Spec 1.0 §7. Drop WAV files here and point `config/fleet.yaml` at them.

| Cue | Plays in | Trigger | Kind |
|---|---|---|---|
| `ready` | caller's channel | every target resolved, ≥1 accepted; hail opens | voice, per-locale |
| `attention` | each accepted target | same instant as `ready` | voice, per-locale |
| `ring` | locked target only | hail requested; repeats until Accept/Decline or 20 s timeout | SFX, locale-neutral |
| `busy` | caller's channel | every selected target refused, or allocator had no free bots | voice, per-locale |
| `end` | closing channel | per-channel End button, or hail-wide 10 s all-quiet | SFX, locale-neutral |

## Hard requirement

`ready` and `attention` must be **exactly `cue_duration_ms`** long (default 1200 ms).
They play concurrently across the caller and each accepted target — their common
end defines when the caller can start speaking. Unequal assets clip the first word.
Startup validates this and refuses to run.

`ring`, `busy` and `end` play alone and get a wider tolerance (±200 ms).

Prepend ~200 ms of silence to every asset — a stream starting from cold drops
its first packets on receiving clients.

Format: 48 kHz, 16-bit, stereo WAV. Assets are pre-encoded to Opus frames and
cached in memory at startup, so playback costs nothing at runtime.

## Locales

One directory per guild-selectable locale (`/star-comms set-language`),
paths declared under `cue_sets.<set>.<locale>` in `fleet.yaml`:

```
cues/
  ring.wav  end.wav                 shared, locale-neutral
  en/        ready attention busy established disconnected  .wav
  da/        klar  giv_agt   optaget etableret afbrudt      .wav
  en-pirate/ same names as en
  da-pirate/ same names as da
```

The default locale's set must load or the fleet refuses to boot. Any
other locale that is missing is skipped with a warning; guilds set to it
hear the default locale's cues until the files are installed.

Audio files are gitignored. `./generate-cues.sh` produces all four locales
with espeak-ng (`LOCALES="en-pirate" ./generate-cues.sh` for a subset) —
locally, or inside the deployed container, which ships the script and
espeak-ng (see `docs/coolify.md`);
`scripts/gen-cues.sh` makes sine-wave placeholders; `generate.sh` is the
Piper variant for a warmer voice.
