#!/bin/bash
#
# Runtime entrypoint.
#
#   1. Fill in any missing cue audio under $CUES_DIR with espeak-ng
#      (SKIP_EXISTING — files already there, e.g. hand-made Piper voices,
#      are never overwritten). A first deploy therefore boots with a
#      complete cue set and no workstation round-trip.
#   2. exec node — `exec` so SIGTERM reaches the process and its drain
#      handler runs on `docker stop`.
#
# Generation is best-effort: a directory the `node` user cannot write to
# (Coolify creates bind directories as root) logs a hint and the fleet
# still boots — the cue loader then reports exactly what is missing.
#
#   CUES_DIR       default /app/cues
#   GENERATE_CUES  set to 0 to skip generation entirely
#   LOCALES        passed through to generate-cues.sh (default: all four)
set -euo pipefail

CUES_DIR="${CUES_DIR:-/app/cues}"

if [ "${GENERATE_CUES:-1}" = "1" ]; then
  if [ -d "$CUES_DIR" ] && [ -w "$CUES_DIR" ]; then
    SKIP_EXISTING=1 ./generate-cues.sh "$CUES_DIR" \
      || echo "cues: generation failed — continuing; run ./generate-cues.sh from the terminal to see why" >&2
  else
    echo "cues: $CUES_DIR is not writable by uid $(id -u) — skipping generation." >&2
    echo "cues: on the host: chown -R 1000:1000 <the directory mounted at $CUES_DIR>, then restart." >&2
  fi
fi

exec node dist/index.js
