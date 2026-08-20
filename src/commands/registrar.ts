/**
 * Slash command registrar + dispatcher for the controller.
 *
 * Runs on the controller Client only. On ClientReady it registers
 * `/star-bridge` in every guild the controller is in; on GuildCreate it
 * registers in the newly added guild. Guild-scoped commands take effect
 * immediately, whereas global commands can take up to an hour to
 * propagate — the difference matters when an operator is iterating.
 *
 * Interactions are dispatched to handler callables. Step 5a wires two:
 * `init` (pool provisioning) and `status` (a quick read-out). Later steps
 * will add wizard subcommands, the callsign alias UI, etc.
 */

import {
  Events, MessageFlags, REST, Routes,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import type { ControllerConfig } from '../lib/config.js';
import { starBridgeCommand } from './star-bridge.js';

export type SubcommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

export interface RegistrarConfig {
  controllerClient: Client;
  controllerAppId: string;
  controllerToken: string;
  handlers: Record<string, SubcommandHandler>;
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

    // Handle interactions.
    controllerClient.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'star-bridge') return;
      void this.dispatch(interaction);
    });

    // Register in guilds joined after boot.
    controllerClient.on(Events.GuildCreate, (guild) => {
      void this.registerFor(guild.id).catch((err) => {
        console.error(`registrar: failed to register in ${guild.id}: ${err instanceof Error ? err.message : err}`);
      });
    });

    // Register in every guild we already know about.
    const guilds = [...controllerClient.guilds.cache.keys()];
    console.log(`registrar: registering /star-bridge in ${guilds.length} guild(s)`);
    await Promise.all(guilds.map((id) => this.registerFor(id).catch((err) => {
      console.error(`registrar: failed to register in ${id}: ${err instanceof Error ? err.message : err}`);
    })));
  }

  private async registerFor(guildId: string): Promise<void> {
    const body = [starBridgeCommand()];
    await this.rest.put(
      Routes.applicationGuildCommands(this.cfg.controllerAppId, guildId),
      { body },
    );
    console.log(`registrar: /star-bridge available in guild ${guildId}`);
  }

  private async dispatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand(false);
    if (sub === null) {
      await interaction.reply({ content: 'usage: /star-bridge init | status', flags: MessageFlags.Ephemeral });
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
): SlashRegistrar {
  return new SlashRegistrar({
    controllerClient,
    controllerAppId: controller.applicationId,
    controllerToken: controller.token,
    handlers,
  });
}
