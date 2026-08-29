/**
 * Re-render live control panels outside of a panel click.
 *
 * A panel is a persistent message whose button labels, enabled state
 * and status lines are baked in at post time. Two events change what
 * a panel should show without going through one of its own buttons:
 *
 *   - `/star-comms set-language` — every panel in the guild needs new
 *     labels (`refreshGuildPanels`).
 *   - `/star-comms register` / `unregister` — the owner's panels need
 *     **Allow hails** enabled/disabled and the callsign hint shown or
 *     hidden; unregister also drops the vessel from the hail directory
 *     (`refreshOwnerPanels`).
 *
 * The vessel row remembers `panel_message_id`; we fetch each message
 * through the controller and edit it in place with a fresh `buildPanel`.
 *
 * Best-effort per panel: a channel or message that has vanished is
 * skipped (reconciliation drops the row later), and one failure never
 * stops the others.
 */

import { ChannelType, type Client } from 'discord.js';
import type { DB } from '../lib/db.js';
import type { Strings } from '../lib/i18n.js';
import { buildPanel } from '../commands/panel.js';
import { getVesselState } from './vessel-state.js';

export interface PanelRefreshResult {
  updated: number;
  skipped: number;
}

interface PanelRow { channel_id: string; panel_message_id: string }

/** Every live panel in the guild. */
export async function refreshGuildPanels(
  db: DB, controller: Client, guildId: string, s: Strings,
): Promise<PanelRefreshResult> {
  const rows = db.prepare(`
    SELECT channel_id, panel_message_id
    FROM vessels
    WHERE guild_id = ? AND deleted_at IS NULL AND panel_message_id IS NOT NULL
  `).all(guildId) as PanelRow[];
  return refreshPanels(db, controller, s, rows);
}

/** Live panels of vessels owned by one member in the guild. */
export async function refreshOwnerPanels(
  db: DB, controller: Client, guildId: string, ownerUserId: string, s: Strings,
): Promise<PanelRefreshResult> {
  const rows = db.prepare(`
    SELECT channel_id, panel_message_id
    FROM vessels
    WHERE guild_id = ? AND owner_user_id = ? AND deleted_at IS NULL AND panel_message_id IS NOT NULL
  `).all(guildId, ownerUserId) as PanelRow[];
  return refreshPanels(db, controller, s, rows);
}

async function refreshPanels(
  db: DB, controller: Client, s: Strings, rows: PanelRow[],
): Promise<PanelRefreshResult> {
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const state = getVesselState(db, row.channel_id);
    if (state === null) { skipped++; continue; }
    const channel = await controller.channels.fetch(row.channel_id).catch(() => null);
    if (channel === null || channel.type !== ChannelType.GuildVoice) { skipped++; continue; }
    const message = await channel.messages.fetch(row.panel_message_id).catch(() => null);
    if (message === null) { skipped++; continue; }
    const rendered = buildPanel(state, s);
    const ok = await message.edit({ content: rendered.content, components: rendered.components })
      .then(() => true)
      .catch((err) => {
        console.warn(`panel-refresh: ${row.channel_id}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
    if (ok) updated++; else skipped++;
  }
  return { updated, skipped };
}
