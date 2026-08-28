#!/bin/bash

# Voice models — download once.
#mkdir -p ~/piper-voices && cd ~/piper-voices
# Female "Amy" (US English) for computer voice:
#curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
#curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
# Male "Ryan" for the relay bot:
#curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx
#curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json

# Voice cues → 48 kHz stereo WAV (Discord format).
say() {
  local text="$1" voice="$2" out="$3"
  echo "$text" | piper -m ~/piper-voices/$voice.onnx --output_raw \
    | ffmpeg -y -f s16le -ar 22050 -ac 1 -i - -ar 48000 -ac 2 "$out"
}

cd cues/en
say "Star Comm, connection established"  en_US-ryan-medium  established.wav
say "Initiating hail"                    en_US-amy-medium   ready.wav
say "Opening hail"                       en_US-amy-medium   attention.wav
say "Closing hail"                       en_US-amy-medium   end.wav
say "Sorry, that channel is busy"        en_US-amy-medium   busy.wav

# Ring — TNG-style two-tone chime, no locale.
cd ..
#ffmpeg -y -f lavfi -i "sine=frequency=784:duration=0.15,adelay=0|0" \
#             -f lavfi -i "sine=frequency=1047:duration=0.20,adelay=200|200" \
#       -filter_complex "[0][1]amix=inputs=2:duration=longest:normalize=0,volume=0.6,apad=pad_dur=0.15" \
#       -ar 48000 -ac 2 -t 0.60 ring.wav

