/**
 * `/star-comms init` — pick the join-to-create voice channel.
 *
 * Spec §3: Star Comms does not create a category or any voice channels
 * at init time. It only needs to know which existing voice channel the
 * operator wants to use as the "join to create your own vessel" trigger.
 * The invoker gets a ChannelSelectMenu limited to voice channels; the
 * chosen id is stored on `guilds.join_to_create_channel_id`.
 */

import {
  ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType, ComponentType,
  MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { FleetConfig } from '../lib/config.js';
import { ensureGuildRow, getJoinToCreateChannel, setJoinToCreateChannel } from '../session/guild-row.js';

const CUSTOM_ID = 'star-comms:init:pick';
const TIMEOUT_MS = 60_000;

export function makeInitHandler(config: FleetConfig, db: DB) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const guild = interaction.guild;
    if (guild === null) {
      await interaction.reply({
        content: 'This command must be used in a guild.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Admin-only. Top-level `/star-comms` is open to every member so
    // the registration subcommands work; init is gated here in the
    // handler.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the **Manage Server** permission to run `/star-comms init`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    ensureGuildRow(db, {
      id: guild.id, name: guild.name, ownerId: guild.ownerId ?? null,
    }, config.defaults, interaction.user.id);

    const currentId = getJoinToCreateChannel(db, guild.id);
    const currentNote = currentId === null
      ? 'No trigger channel configured yet.'
      : `Currently: <#${currentId}>.`;

    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(CUSTOM_ID)
      .setPlaceholder('Pick the join-to-create voice channel')
      .addChannelTypes(ChannelType.GuildVoice)
      .setMinValues(1)
      .setMaxValues(1);
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu);

    const reply = await interaction.reply({
      content:
        `**Star Comms init for ${guild.name}**\n` +
        `${currentNote}\n\n` +
        `Which voice channel should Star Comms watch as the join-to-create trigger? ` +
        `When a member joins it, a new vessel channel is created and the member is moved into it.`,
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
        await selection.update({ content: 'Nothing selected — init cancelled.', components: [] });
        return;
      }
      setJoinToCreateChannel(db, guild.id, channelId);
      await selection.update({
        content:
          `Star Comms is now watching <#${channelId}> as the join-to-create trigger. ` +
          `When someone joins it, they will be moved into a fresh vessel channel of their own.`,
        components: [],
      });
    } catch {
      // awaitMessageComponent rejects on timeout.
      await interaction.editReply({
        content: 'Init cancelled — no channel selected within 60 seconds. Re-run `/star-comms init` when ready.',
        components: [],
      }).catch(() => {});
    }
  };
}
