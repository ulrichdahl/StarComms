/**
 * `/star-comms watch-channel` — pick the join-to-create voice channel.
 *
 * Spec §3: Star Comms does not create a category or any voice channels
 * at set-up time. It only needs to know which existing voice channel
 * the operator wants to use as the "join to create your own vessel"
 * trigger. The invoker gets a ChannelSelectMenu limited to voice
 * channels; the chosen id is stored on
 * `guilds.join_to_create_channel_id`. Re-running replaces it.
 */

import {
  ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType, ComponentType,
  MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { FleetConfig } from '../lib/config.js';
import type { Strings } from '../lib/i18n.js';
import { ensureGuildRow, getJoinToCreateChannel, setJoinToCreateChannel } from '../session/guild-row.js';
import { SUBCOMMANDS } from './star-comms.js';

const CUSTOM_ID = 'star-comms:watch-channel:pick';
const TIMEOUT_MS = 60_000;

export function makeWatchChannelHandler(
  config: FleetConfig, db: DB, strings: (guildId: string) => Strings,
) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const guild = interaction.guild;
    if (guild === null) {
      await interaction.reply({ content: strings('').common.guildOnly, flags: MessageFlags.Ephemeral });
      return;
    }
    const s = strings(guild.id);

    // Admin-only. Top-level `/star-comms` is open to every member so
    // the registration subcommands work; this one is gated here.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: s.common.needManageServer(SUBCOMMANDS.watchChannel),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    ensureGuildRow(db, {
      id: guild.id, name: guild.name, ownerId: guild.ownerId ?? null,
    }, config.defaults, interaction.user.id);

    const currentId = getJoinToCreateChannel(db, guild.id);
    const currentNote = currentId === null ? s.watchChannel.noneYet : s.watchChannel.current(currentId);

    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(CUSTOM_ID)
      .setPlaceholder(s.watchChannel.placeholder)
      .addChannelTypes(ChannelType.GuildVoice)
      .setMinValues(1)
      .setMaxValues(1);
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu);

    const reply = await interaction.reply({
      content: s.watchChannel.intro(guild.name, currentNote),
      components: [row],
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });

    try {
      const selection = await reply.resource!.message!.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id && i.customId === CUSTOM_ID,
        componentType: ComponentType.ChannelSelect,
        time: TIMEOUT_MS,
      });
      const channelId = selection.values[0];
      if (channelId === undefined) {
        await selection.update({ content: s.watchChannel.cancelled, components: [] });
        return;
      }
      setJoinToCreateChannel(db, guild.id, channelId);
      await selection.update({ content: s.watchChannel.set(channelId), components: [] });
    } catch {
      // awaitMessageComponent rejects on timeout.
      await interaction.editReply({ content: s.watchChannel.timeout, components: [] }).catch(() => {});
    }
  };
}
