#!/bin/bash
#
# Voice cue generator — espeak-ng → 48 kHz stereo WAV, one directory per
# locale, file names matching config/fleet.example.yaml.
#
#   en/        ready attention busy established disconnected
#   da/        klar  giv_agt   optaget etableret afbrudt
#   en-pirate/ (same names as en)
#   da-pirate/ (same names as da)
#   ring.wav   locale-neutral two-tone chime
#
# Usage:  ./generate-cues.sh [cues-dir]        (default: ./cues)
#         LOCALES="en da" ./generate-cues.sh   (subset)
#         SKIP_EXISTING=1 ./generate-cues.sh   (only write files that are
#           missing — the container entrypoint uses this at boot, so
#           hand-made WAVs dropped into the directory are never touched)
#
# espeak-ng is robotic by design — it suits a ship's computer. Swap `say`
# for Piper (see generate.sh) if you want a warmer voice; keep the file
# names. Every cue gets ~200 ms of leading silence: a stream starting
# from cold drops its first packets on receiving clients.
set -euo pipefail

CUES_ROOT="${1:-$(pwd)/cues}"
LOCALES="${LOCALES:-en da en-pirate da-pirate}"
SKIP_EXISTING="${SKIP_EXISTING:-0}"
written=0; kept=0

# keep <out.wav> — true when the file exists and we are in skip mode.
keep() {
  [ "$SKIP_EXISTING" = "1" ] && [ -s "$1" ] && { kept=$((kept+1)); return 0; }
  return 1
}

for tool in espeak-ng ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found" >&2; exit 1; }
done

# say <text> <espeak voice> <out.wav>
say() {
  local text="$1" voice="$2" out="$3"
  keep "$out" && return 0
  written=$((written+1))
  espeak-ng -v "$voice" -s 150 --stdout "$text" \
    | ffmpeg -y -loglevel error -i pipe:0 -af "adelay=200|200" -ar 48000 -ac 2 "$out"
  echo "wrote $out"
}

gen_locale() {
  local locale="$1" dir="$CUES_ROOT/$1"
  mkdir -p "$dir"
  case "$locale" in
    en)
      say "Star Comm, connection established"      en+m3 "$dir/established.wav"
      say "Star Comm, disconnecting"               en+m3 "$dir/disconnected.wav"
      say "Initiating hail"                        en+f2 "$dir/ready.wav"
      say "Incoming hail"                          en+f2 "$dir/attention.wav"
      say "Sorry, that channel is busy"            en+f2 "$dir/busy.wav"
      ;;
    da)
      say "Star Comm, forbindelse etableret"       da+m3 "$dir/etableret.wav"
      say "Star Comm, afbryder"                    da+m3 "$dir/afbrudt.wav"
      say "Kalder op"                              da+f2 "$dir/klar.wav"
      say "Indgående kald"                         da+f2 "$dir/giv_agt.wav"
      say "Kanalen er optaget"                     da+f2 "$dir/optaget.wav"
      ;;
    en-pirate)
      say "Star Comm be connected, arr"            en+m3 "$dir/established.wav"
      say "Star Comm be castin' off, matey"        en+m3 "$dir/disconnected.wav"
      say "Hoist the signal, we be hailin'"        en+m3 "$dir/ready.wav"
      say "Ahoy! Incoming hail, ye scallywags"     en+m3 "$dir/attention.wav"
      say "Arr, that channel be busy"              en+m3 "$dir/busy.wav"
      ;;
    da-pirate)
      say "Star Comm er om bord, arr"              da+m3 "$dir/etableret.wav"
      say "Star Comm kaster los, makker"           da+m3 "$dir/afbrudt.wav"
      say "Hejs signalet, vi kalder op"            da+m3 "$dir/klar.wav"
      say "Ohøj! Indgående kald, I søulke"          da+m3 "$dir/giv_agt.wav"
      say "Arr, den kanal er optaget"              da+m3 "$dir/optaget.wav"
      ;;
    *) echo "unknown locale: $locale" >&2; exit 1 ;;
  esac
}

for l in $LOCALES; do gen_locale "$l"; done

# Ring — two-tone rising chime, locale-neutral. `end` is the same chime
# reversed so open and close are mirror images.
mkdir -p "$CUES_ROOT"
if ! keep "$CUES_ROOT/ring.wav"; then
  written=$((written+1))
  ffmpeg -y -loglevel error \
    -f lavfi -i "sine=frequency=784:duration=0.15" \
    -f lavfi -i "sine=frequency=1047:duration=0.20" \
    -filter_complex "[0][1]concat=n=2:v=0:a=1,volume=0.5,adelay=200|200" \
    -ar 48000 -ac 2 "$CUES_ROOT/ring.wav"
  echo "wrote $CUES_ROOT/ring.wav"
fi
if ! keep "$CUES_ROOT/end.wav"; then
  written=$((written+1))
  ffmpeg -y -loglevel error \
    -f lavfi -i "sine=frequency=1047:duration=0.20" \
    -f lavfi -i "sine=frequency=784:duration=0.15" \
    -filter_complex "[0][1]concat=n=2:v=0:a=1,volume=0.5,adelay=200|200" \
    -ar 48000 -ac 2 "$CUES_ROOT/end.wav"
  echo "wrote $CUES_ROOT/end.wav"
fi
echo "cues: $written written, $kept kept (existing) in $CUES_ROOT"
