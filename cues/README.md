# Cue audio

Six cues, per spec §5. Drop WAV files here and point `config/fleet.yaml` at them.

| Cue | Plays in | Trigger | Kind |
|---|---|---|---|
| `ready` | source net | net open, route resolved | voice, per-locale |
| `attention` | target net(s) | net open, verb = hail/command/broadcast | voice, per-locale |
| `horn` | target net(s) | net open, verb = alert | SFX, locale-neutral |
| `negative` | source net | callsign unmatched | voice, per-locale |
| `busy` | source net | target held by another session | voice, per-locale |
| `out` | both | net closed | tone, locale-neutral |

## Hard requirement

`ready`, `attention` and `horn` must all be **exactly `cue_duration_ms`** long
(default 1200 ms). They start on the same instant, so equal length is what makes
the caller's go-ahead end when the receivers' alert ends. Unequal assets clip the
first word of every transmission. Startup validates this and refuses to run.

Prepend ~200 ms of silence to every asset — a stream starting from cold drops
its first packets on receiving clients.

Format: 48 kHz, 16-bit, stereo WAV. Assets are pre-encoded to Opus frames and
cached in memory at startup, so playback costs nothing at runtime.

Audio files are gitignored. Ship your own, or generate defaults with Piper
(`da_DK-talesyntese-medium`, or any `en_*` voice).
