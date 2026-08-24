/**
 * Control panel — the buttons that live in a vessel's voice-text chat.
 *
 * Two rows, per Spec 1.0 §4:
 *
 *   [ Rename ] [ Lock/Unlock ] [ Limit ] [ Kick ]
 *   [ Allow hails / Disable hails ] [ Hail ]
 *
 * Toggle buttons swap label + colour based on the current vessel state.
 * The panel is a normal (non-ephemeral) message in the channel's
 * voice-text chat; owner-only enforcement lives in each button
 * handler. Non-owners see the buttons but any click gets an ephemeral
 * "only the owner can use these controls".
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type APIActionRowComponent, type APIComponentInMessageActionRow,
} from 'discord.js';
import type { VesselState } from '../session/vessel-state.js';

export const PANEL_IDS = {
  rename: 'sc:panel:rename',
  renameSubmit: 'sc:panel:rename:submit',
  lockToggle: 'sc:panel:lock',
  limit: 'sc:panel:limit',
  limitSubmit: 'sc:panel:limit:submit',
  kick: 'sc:panel:kick',
  kickPick: 'sc:panel:kick:pick',
  hailsToggle: 'sc:panel:hails',
  hail: 'sc:panel:hail',
  hailPick: 'sc:panel:hail:pick',
} as const;

export interface PanelRender {
  content: string;
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

export function buildPanel(state: VesselState): PanelRender {
  const owner = `<@${state.ownerUserId}>`;

  // Stacked status — one line per fact with a leading glyph. Easier
  // for dyslexic readers to scan than a dot-separated single line:
  // each row has a fixed vertical position and a distinct starting
  // shape.
  const lockLine = state.locked
    ? '🔒  Locked — only invited members can join'
    : '🔓  Open — anyone with view access can join';
  const limitLine = state.userLimit === 0
    ? '👥  No user limit'
    : `👥  Limit: ${state.userLimit}`;
  const hailsLine = state.hailsEnabled
    ? `📡  Hails on — 🛰️ **${state.callsign ?? '?'}**`
    : '📡  Hails off';
  const status = [lockLine, limitLine, hailsLine].join('\n');

  // ── row 1: vessel controls ────────────────────────────────────
  const rename = new ButtonBuilder()
    .setCustomId(PANEL_IDS.rename)
    .setEmoji('✏️')
    .setLabel('Rename')
    .setStyle(ButtonStyle.Secondary);
  const lockToggle = new ButtonBuilder()
    .setCustomId(PANEL_IDS.lockToggle)
    // Icon swaps with state so shape carries meaning even if the
    // "Lock" / "Unlock" text mis-reads.
    .setEmoji(state.locked ? '🔓' : '🔒')
    .setLabel(state.locked ? 'Unlock' : 'Lock')
    .setStyle(state.locked ? ButtonStyle.Success : ButtonStyle.Secondary);
  const limit = new ButtonBuilder()
    .setCustomId(PANEL_IDS.limit)
    .setEmoji('👥')
    .setLabel('Limit')
    .setStyle(ButtonStyle.Secondary);
  const kick = new ButtonBuilder()
    .setCustomId(PANEL_IDS.kick)
    // Boot — flesh/brown, reads on the red Danger background where
    // 🚫 (red-on-red) vanished. Semantic bonus: "boot from server"
    // is Discord-culture-native for kick.
    .setEmoji('🥾')
    .setLabel('Kick')
    .setStyle(ButtonStyle.Danger);

  // ── row 2: hail controls ──────────────────────────────────────
  const hailsToggle = new ButtonBuilder()
    .setCustomId(PANEL_IDS.hailsToggle)
    // 📡 satellite dish when enabling (signal-open), 🔕 muted-bell
    // when disabling — icons carry the state change even if the
    // "Allow hails" / "Disable hails" text mis-reads.
    .setEmoji(state.hailsEnabled ? '🔕' : '📡')
    .setLabel(state.hailsEnabled ? 'Disable hails' : 'Allow hails')
    .setStyle(state.hailsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
    // Callsign required to enable hails. If already enabled, the button
    // stays clickable (to disable).
    .setDisabled(!state.hailsEnabled && state.callsign === null);
  const hail = new ButtonBuilder()
    .setCustomId(PANEL_IDS.hail)
    // Studio mic — "speak into this now". Primary is deliberately
    // the only Primary in the panel: one loud button, one meaning.
    .setEmoji('🎙️')
    .setLabel('Hail')
    .setStyle(ButtonStyle.Primary)
    // Hail requires the caller's own vessel to be registered — otherwise
    // there is nothing to identify the caller with in the target's ring.
    .setDisabled(!state.hailsEnabled);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(rename, lockToggle, limit, kick);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(hailsToggle, hail);

  const callsignNote = state.callsign === null
    ? '\n_Register a callsign with `/star-comms register` to enable **Allow hails** and the hail directory._'
    : '';

  return {
    content:
      `🛰️ **Vessel controls** — ${owner}\n` +
      `${status}${callsignNote}`,
    components: [row1.toJSON(), row2.toJSON()],
  };
}
