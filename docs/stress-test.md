# Star Comms — hail stress-test agenda

Living checklist for exercising the hail service beyond the golden
path. Each item names an inputs/state combination, the expected outcome
today, and what a red result would tell us.

## Enforced in code (as of 2026-08-24)

Both were closed by adding the *in-hail block* — `busyChannels` in
`HailManager` reserves every channel a hail would touch (initiator +
targets) synchronously at the start of `open()`, before any `await`.

- **1. Owner in an active hail clicks Hail on their own panel.**
  → Ephemeral: *"Your channel is already in an active hail. End it
  before starting a new one."* No new relay is allocated.

- **2. A hails B and B hails A at the same moment.**
  → JS is single-threaded; whichever `open()` reserves the two
  channels first wins. The other returns *"already_hailing"* (own
  channel reserved) or *"target_busy"* (only the target was reserved).
  No double-relay, no cross-linked hails.

## Observational — walk through and confirm no code fix needed

Run each with a live fleet. Watch `hail-hb:` log lines + Discord for
the expected shape.

- **3. Fan-out to a locked ringing target and an unlocked
  auto-accept target.** Expect: locked target rings until Accept;
  unlocked target joins immediately; cues + End buttons appear on all
  three legs once the locked side accepts. Already worked in step 7.

- **4. Initiator leaves mid-hail (3+ legs).** Expect: whole hail
  closes via `handleOwnerLeft` → `_close('initiator_left')`. `end` cue
  plays on the remaining legs, bots disconnect, End buttons deleted.

- **5. One target leaves mid-hail; others stay.** Expect: same as
  #4 for now — the leg leaving triggers `_close` for the whole hail.
  Leg-drop-continue is out of scope for v1; if the log line reads
  clean, no fix is needed.

- **6. Rapid open/close spam (button-mash Hail then End).** Expect:
  every relay ends up back in `freeBotNatos`; `busyChannels` empties;
  `busyNatos` empties. Verify with `/star-comms status` between rounds
  — nothing should stay reserved.

- **7. `docker compose restart bot` during a live hail.** Expect:
  `SIGTERM` → `hails.drain()` sequentially closes each hail (`end`
  cue on every leg, bots disconnect, DB rows updated with
  `close_reason='drain'`). No orphaned bots left in voice.

- **8. All relays occupied, next Hail request.** Expect: ephemeral
  *"Not enough relay bots are free right now. Try again in a
  minute."* No DB row for the refused hail. Verify by consuming the
  pool with two 1-target hails, then attempting a third.

## Later — record here what surfaces during real use

Add new scenarios (and outcomes) as they come up. Anything that
required a code change moves up into the *Enforced in code* section
with a date.
