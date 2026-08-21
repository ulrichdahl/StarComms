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

Audio files are gitignored. Generate placeholders with `scripts/gen-cues.sh`
(sine waves), or ship your own — TTS via Piper (`da_DK-talesyntese-medium` or
any `en_*` voice) is the intended path.
