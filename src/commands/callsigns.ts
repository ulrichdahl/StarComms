/**
 * Handlers for the three callsign subcommands. Any member of a guild
 * may register their own callsign, replace it, remove it, or query it.
 * Replies are in the guild's language.
 *
 * Register and unregister change what the member's vessel panels should
 * show (Allow hails enabled/disabled, callsign hint, hail-directory
 * state), so both call `onChanged(guildId, userId)` after the DB write;
 * the entrypoint wires that to `refreshOwnerPanels`.
 */

import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { DB } from '../lib/db.js';
import type { Strings } from '../lib/i18n.js';
import { CallsignError, getCallsign, registerCallsign, unregisterCallsign } from '../session/callsigns.js';
import { CALLSIGN_MAX, CALLSIGN_MIN } from '../session/callsigns.js';

type StringsFor = (guildId: string) => Strings;
/** Fired after a callsign is registered or removed. Best-effort; errors are logged. */
export type CallsignChanged = (guildId: string, userId: string) => Promise<void>;

async function notify(onChanged: CallsignChanged | undefined, guildId: string, userId: string): Promise<void> {
  if (onChanged === undefined) return;
  await onChanged(guildId, userId).catch((err) => {
    console.error(`callsigns: onChanged failed for ${userId} in ${guildId}: ${err instanceof Error ? err.message : err}`);
  });
}

/** Render a CallsignError in the guild's language. */
export function renderCallsignError(s: Strings, err: CallsignError): string {
  switch (err.code) {
    case 'too_short': return s.callsign.errTooShort(CALLSIGN_MIN);
    case 'too_long': return s.callsign.errTooLong(CALLSIGN_MAX);
    case 'pattern': return s.callsign.errPattern;
    case 'taken': return s.callsign.errTaken(err.callsign ?? '?');
  }
}

export function makeRegisterHandler(db: DB, strings: StringsFor, onChanged?: CallsignChanged) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.guildId === null) {
      await interaction.reply({ content: strings('').common.guildOnly, flags: MessageFlags.Ephemeral });
      return;
    }
    const s = strings(interaction.guildId);
    const raw = interaction.options.getString('callsign', true);
    try {
      const accepted = registerCallsign(db, interaction.guildId, interaction.user.id, raw);
      await interaction.reply({ content: s.callsign.registered(accepted), flags: MessageFlags.Ephemeral });
      await notify(onChanged, interaction.guildId, interaction.user.id);
    } catch (err) {
      if (err instanceof CallsignError) {
        await interaction.reply({ content: renderCallsignError(s, err), flags: MessageFlags.Ephemeral });
        return;
      }
      throw err;
    }
  };
}

export function makeUnregisterHandler(db: DB, strings: StringsFor, onChanged?: CallsignChanged) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.guildId === null) {
      await interaction.reply({ content: strings('').common.guildOnly, flags: MessageFlags.Ephemeral });
      return;
    }
    const s = strings(interaction.guildId);
    const previous = unregisterCallsign(db, interaction.guildId, interaction.user.id);
    if (previous === null) {
      await interaction.reply({ content: s.callsign.noneRegistered, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: s.callsign.removed(previous), flags: MessageFlags.Ephemeral });
    await notify(onChanged, interaction.guildId, interaction.user.id);
  };
}

export function makeCallsignHandler(db: DB, strings: StringsFor) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.guildId === null) {
      await interaction.reply({ content: strings('').common.guildOnly, flags: MessageFlags.Ephemeral });
      return;
    }
    const s = strings(interaction.guildId);
    const row = getCallsign(db, interaction.guildId, interaction.user.id);
    if (row === null) {
      await interaction.reply({ content: s.callsign.noneToReport, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: s.callsign.current(row.callsign), flags: MessageFlags.Ephemeral });
  };
}
