#!/usr/bin/env bash
#
# Placeholder cue generator — six 1200 ms WAVs, distinct sine frequencies
# per cue so they are trivially distinguishable by ear during step 4
# verification. Real cues (TTS or recorded) drop in later without code
# changes: same filenames, same equal duration, same 48 kHz stereo.
#
# Spec §5: ready, attention and horn must be *exactly* cue_duration_ms.
# We generate all six at exactly 1200 ms so the loader's equal-duration
# validation passes.
#
# Each cue is 200 ms of silence followed by 1000 ms of tone; the leading
# silence guards against cold-stream first-packet loss on receiving
# clients (see cues/README.md).
#
# Usage:  scripts/gen-cues.sh
# Writes: cues/en/{ready,attention,negative,busy}.wav
#         cues/{horn,out}.wav

set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install it, or run this script inside the container." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CUES="$ROOT/cues"

mkdir -p "$CUES/en"

declare -A LOCALIZED=(
  [en/ready]=880
  [en/attention]=440
  [en/negative]=220
  [en/busy]=660
)

declare -A SHARED=(
  [horn]=520
  [out]=196
)

gen() {
  local out="$1" freq="$2"
  # sine of duration 1.0 s, delayed by 200 ms on both channels, capped at
  # exactly 1.2 s of output. adelay pads the front with silence.
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "sine=frequency=${freq}:duration=1.0:sample_rate=48000" \
    -af "adelay=200|200" \
    -ac 2 -c:a pcm_s16le -t 1.2 "$out"
  local ms
  ms="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$out")"
  printf '%-40s %s Hz  %s s\n' "$out" "$freq" "$ms"
}

for key in "${!LOCALIZED[@]}"; do
  gen "$CUES/${key}.wav" "${LOCALIZED[$key]}"
done
for key in "${!SHARED[@]}"; do
  gen "$CUES/${key}.wav" "${SHARED[$key]}"
done

echo
echo "Placeholder cues generated in $CUES. Replace with real assets any time;"
echo "the loader only requires equal duration per spec §5."
