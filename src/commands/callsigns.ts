/**
 * Handlers for the three callsign subcommands. Any member of a guild
 * may register their own callsign, replace it, remove it, or query it.
 */

import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { DB } from '../lib/db.js';
import { CallsignError, getCallsign, registerCallsign, unregisterCallsign } from '../session/callsigns.js';

export function makeRegisterHandler(db: DB) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.guildId === null) {
      await interaction.reply({ content: 'This command must be used in a guild.', flags: MessageFlags.Ephemeral });
      return;
    }
    const raw = interaction.options.getString('callsign', true);
    try {
      const accepted = registerCallsign(db, interaction.guildId, interaction.user.id, raw);
      await interaction.reply({
        content: `Callsign registered: **${accepted}**. Enable it on a vessel with the **Allow hails** button (arriving in a later step).`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      if (err instanceof CallsignError) {
        await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
        return;
      }
      throw err;
    }
  };
}

export function makeUnregisterHandler(db: DB) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.guildId === null) {
      await interaction.reply({ content: 'This command must be used in a guild.', flags: MessageFlags.Ephemeral });
      return;
    }
    const previous = unregisterCallsign(db, interaction.guildId, interaction.user.id);
    if (previous === null) {
      await interaction.reply({
        content: 'You do not have a callsign registered in this guild.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Callsign **${previous}** removed. Any vessels you owned that were in the hail directory have been dropped from it.`,
      flags: MessageFlags.Ephemeral,
    });
  };
}

export function makeCallsignHandler(db: DB) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.guildId === null) {
      await interaction.reply({ content: 'This command must be used in a guild.', flags: MessageFlags.Ephemeral });
      return;
    }
    const row = getCallsign(db, interaction.guildId, interaction.user.id);
    if (row === null) {
      await interaction.reply({
        content: 'You have no callsign registered in this guild. Set one with `/star-comms register <callsign>`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Your callsign in this guild is **${row.callsign}**.`,
      flags: MessageFlags.Ephemeral,
    });
  };
}
