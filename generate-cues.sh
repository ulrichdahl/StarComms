#!/bin/bash
set -euo pipefail

# Absolute paths — no cd-and-hope. Assumes you run this from the repo root
# OR pass an explicit target dir as $1.
CUES_ROOT="${1:-$(pwd)/cues}"
CUES_EN="$CUES_ROOT/en"
mkdir -p "$CUES_EN"

# espeak-ng voices:
#   en+f4 = higher female pitch (closer to computer-y)
#   en+m3 = deeper male
say() {
  local text="$1" voice="$2" out="$3"
  espeak-ng -v "$voice" -s 155 --stdout "$text" \
    | ffmpeg -y -loglevel error -i pipe:0 -ar 48000 -ac 2 "$out"
  echo "wrote $out"
}

say "Star Comm, connection established" en+m3 "$CUES_EN/established.wav"
say "Star Comm, disconnecting..." en+m3 "$CUES_EN/disconnected.wav"
say "Initiating hail"                   en+f2 "$CUES_EN/ready.wav"
say "Opening hail"                      en+f2 "$CUES_EN/attention.wav"
say "Closing hail"                      en+f2 "$CUES_EN/end.wav"
say "Sorry, that channel is busy"       en+f2 "$CUES_EN/busy.wav"

# TNG-ish two-tone rising chime (~0.4s total).
ffmpeg -y -loglevel error \
  -f lavfi -i "sine=frequency=784:duration=0.15" \
  -f lavfi -i "sine=frequency=1047:duration=0.20" \
  -filter_complex "[0][1]concat=n=2:v=0:a=1,volume=0.5" \
  -ar 48000 -ac 2 "$CUES_ROOT/ring.wav"
echo "wrote $CUES_ROOT/ring.wav"

