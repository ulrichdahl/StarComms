# Star Comms branding

Sibling set to StarBuddy — same palette, same star vocabulary, same
deep-space plate. Two logos: one for the controller (the base
station), one for each relay satellite.

## Files

- `starcomms-controller-mark.svg` — controller mark, transparent
  background. Cyan guide star (the beacon) with three amber
  companions on a shared orbit — the fleet's three relays. Source
  for Discord avatars, web logos, favicons.
- `starcomms-controller-icon.svg` — the mark on the deep-space
  plate, square canvas. Source for app icons and the controller
  bot's Discord avatar:
  `rsvg-convert -w 1024 -h 1024 starcomms-controller-icon.svg -o starcomms-controller-icon-1024.png`.
- `starcomms-relay-mark.svg` — relay mark, transparent background.
  Amber satellite dominant, small cyan controller at the far end
  of the orbit; the arcs are dashed to read as an active
  transmission.
- `starcomms-relay-icon.svg` — the mark on the plate; the plate's
  ambient glow is amber-tinted rather than cyan so the relay's
  warmth reads even before the star silhouettes register. Source
  for the three relay bots' Discord avatars.

Palette (shared with StarBuddy so the family reads instantly):

- cyan `#5BC8DB` — controller identity, orbit arcs, plate glow on
  the controller
- amber `#E8B45A` / `#D99A3A` — relay identity, plate glow on the
  relays
- ground `#0C1117` / `#16222E → #0A0F15` — deep-space plate

## Semantic map

The composition itself carries the fleet's shape:

- Controller = **one** cyan star at the centre + **three** amber
  companions on the orbit → base station orchestrating three
  relays.
- Relay = the buddy promoted to lead. Amber dominant + small cyan
  companion + dashed arcs → a satellite currently transmitting back
  to base. Every relay bot uses the same icon; they are
  interchangeable in the fleet.

## Discord bot avatar upload

Discord takes a square PNG. Render at 1024 with `rsvg-convert` (see
above) and upload via the developer portal — one avatar per bot in
the fleet.
