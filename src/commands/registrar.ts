/**
 * Slash command registrar + dispatcher for the controller.
 *
 * Runs on the controller Client only. On ClientReady it registers
 * `/star-comms` in every guild the controller is in; on GuildCreate it
 * registers in the newly added guild. Guild-scoped commands take effect
 * immediately, whereas global commands can take up to an hour to
 * propagate — the difference matters when an operator is iterating.
 *
 * Commands are registered with descriptions in the guild's language
 * (`localeFor(guildId)`); `/star-comms set-language` calls
 * `reregister(guildId)` so the descriptions follow the change.
 *
 * Interactions are dispatched to handler callables keyed by subcommand
 * name.
 */

import {
  Events, MessageFlags, REST, Routes,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import type { ControllerConfig, Locale } from '../lib/config.js';
import { stringsFor } from '../lib/i18n.js';
import { starCommsCommand } from './star-comms.js';

export type SubcommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

export interface RegistrarConfig {
  controllerClient: Client;
  controllerAppId: string;
  controllerToken: string;
  handlers: Record<string, SubcommandHandler>;
  /** The guild's current language — drives command descriptions. */
  localeFor: (guildId: string) => Locale;
}

export class SlashRegistrar {
  private readonly rest: REST;

  constructor(private readonly cfg: RegistrarConfig) {
    this.rest = new REST({ version: '10' }).setToken(cfg.controllerToken);
  }

  /**
   * Register commands in every guild the controller is currently in, and
   * wire GuildCreate + InteractionCreate listeners so newly added guilds
   * and inbound interactions are handled without a restart.
   */
  async start(): Promise<void> {
    const { controllerClient } = this.cfg;

    controllerClient.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'star-comms') return;
      void this.dispatch(interaction);
    });

    controllerClient.on(Events.GuildCreate, (guild) => {
      void this.registerFor(guild.id).catch((err) => {
        console.error(`registrar: failed to register in ${guild.id}: ${err instanceof Error ? err.message : err}`);
      });
    });

    const guilds = [...controllerClient.guilds.cache.keys()];
    console.log(`registrar: registering /star-comms in ${guilds.length} guild(s)`);
    await Promise.all(guilds.map((id) => this.registerFor(id).catch((err) => {
      console.error(`registrar: failed to register in ${id}: ${err instanceof Error ? err.message : err}`);
    })));
  }

  /** Re-register in one guild — used after its language changes. */
  async reregister(guildId: string): Promise<void> {
    await this.registerFor(guildId);
  }

  private async registerFor(guildId: string): Promise<void> {
    const locale = this.cfg.localeFor(guildId);
    const body = [starCommsCommand(stringsFor(locale))];
    await this.rest.put(
      Routes.applicationGuildCommands(this.cfg.controllerAppId, guildId),
      { body },
    );
    console.log(`registrar: /star-comms available in guild ${guildId} (${locale})`);
  }

  private async dispatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand(false);
    if (sub === null) {
      await interaction.reply({ content: 'usage: /star-comms <subcommand>', flags: MessageFlags.Ephemeral });
      return;
    }
    const handler = this.cfg.handlers[sub];
    if (handler === undefined) {
      await interaction.reply({ content: `unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await handler(interaction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`registrar: handler ${sub} threw: ${msg}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: `error: ${msg}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: `error: ${msg}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
}

/** Convenience factory for the entrypoint. */
export function makeRegistrar(
  controller: ControllerConfig,
  controllerClient: Client,
  handlers: Record<string, SubcommandHandler>,
  localeFor: (guildId: string) => Locale,
): SlashRegistrar {
  return new SlashRegistrar({
    controllerClient,
    controllerAppId: controller.applicationId,
    controllerToken: controller.token,
    handlers,
    localeFor,
  });
}
