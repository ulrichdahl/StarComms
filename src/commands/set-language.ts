/**
 * `/star-comms set-language` — choose the guild's language.
 *
 * Discord renders a bot's buttons and posts identically for every
 * member, so language is a guild-level setting, not a per-user one.
 * The invoker gets a StringSelectMenu of every supported locale
 * (labels written in the language itself); the choice is stored on
 * `guilds.locale`, the slash commands are re-registered so their
 * descriptions follow, and the confirmation is already in the new
 * language.
 *
 * Cue audio is per locale too. A locale whose WAVs are not installed
 * is still selectable — text switches immediately, and the reply
 * says which locale's cues will play meanwhile.
 */

import {
  ActionRowBuilder, ComponentType, MessageFlags, PermissionFlagsBits,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import { isLocale, LOCALES, type FleetConfig, type Locale } from '../lib/config.js';
import { LOCALE_META, stringsFor, type Strings } from '../lib/i18n.js';
import type { CueLibrary } from '../lib/cues.js';
import { ensureGuildRow, getGuildLocale, setGuildLocale } from '../session/guild-row.js';
import { SUBCOMMANDS } from './star-comms.js';

const CUSTOM_ID = 'star-comms:set-language:pick';
const TIMEOUT_MS = 60_000;

export interface SetLanguageDeps {
  config: FleetConfig;
  db: DB;
  strings: (guildId: string) => Strings;
  /** Null when cues failed to load at boot — every locale then reports "no cues". */
  cues: CueLibrary | null;
  /** Called after the locale is stored — re-registers slash commands. */
  onChanged: (guildId: string, locale: Locale) => Promise<void>;
}

export function makeSetLanguageHandler(deps: SetLanguageDeps) {
  const { config, db, strings } = deps;
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const guild = interaction.guild;
    if (guild === null) {
      await interaction.reply({ content: strings('').common.guildOnly, flags: MessageFlags.Ephemeral });
      return;
    }
    const s = strings(guild.id);

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: s.common.needManageServer(SUBCOMMANDS.setLanguage),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    ensureGuildRow(db, {
      id: guild.id, name: guild.name, ownerId: guild.ownerId ?? null,
    }, config.defaults, interaction.user.id);

    const current = getGuildLocale(db, guild.id, config.defaults.locale);
    const currentLabel = `${LOCALE_META[current].emoji} ${LOCALE_META[current].label}`;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(CUSTOM_ID)
      .setPlaceholder(s.setLanguage.placeholder)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(LOCALES.map((locale) => {
        const meta = LOCALE_META[locale];
        return new StringSelectMenuOptionBuilder()
          .setValue(locale)
          .setLabel(meta.label)
          .setDescription(meta.description)
          .setEmoji(meta.emoji)
          .setDefault(locale === current);
      }));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const reply = await interaction.reply({
      content: s.setLanguage.intro(guild.name, currentLabel),
      components: [row],
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });

    try {
      const selection = await reply.resource!.message!.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id && i.customId === CUSTOM_ID,
        componentType: ComponentType.StringSelect,
        time: TIMEOUT_MS,
      });
      const picked = selection.values[0];
      if (!isLocale(picked)) {
        await selection.update({ content: s.setLanguage.cancelled, components: [] });
        return;
      }
      setGuildLocale(db, guild.id, picked);

      // Confirm in the *new* language — the operator should see the
      // switch take effect in the very reply that reports it.
      const ns = stringsFor(picked);
      const meta = LOCALE_META[picked];
      let content = ns.setLanguage.set(`${meta.emoji} ${meta.label}`);
      if (deps.cues === null || !deps.cues.has(picked)) {
        const fallback = deps.cues?.defaultLocale ?? config.defaults.locale;
        content += ns.setLanguage.noCues(LOCALE_META[fallback].label);
      }
      await selection.update({ content, components: [] });

      await deps.onChanged(guild.id, picked).catch((err) => {
        console.error(`set-language: re-register in ${guild.id} failed: ${err instanceof Error ? err.message : err}`);
      });
    } catch {
      await interaction.editReply({ content: s.setLanguage.timeout, components: [] }).catch(() => {});
    }
  };
}
