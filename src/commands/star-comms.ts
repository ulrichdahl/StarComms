/**
 * `/star-comms` command tree.
 *
 * Step 1 ships this as a placeholder — just a `status` subcommand that
 * dumps fleet health. `init`, `register`, `unregister`, `callsign`,
 * `hail-registry`, `drain` land in the steps that need them (Spec 1.0
 * §15 build order).
 */

import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export function starCommsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return {
    name: 'star-comms',
    description: 'Star Comms controller operations.',
    // Default gate. Individual subcommands may relax this via per-handler
    // checks (e.g. any member can /star-comms register).
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    dm_permission: false,
    options: [
      {
        name: 'init',
        description: 'Configure Star Comms for this guild — pick the join-to-create voice channel.',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'status',
        description: 'Report the fleet state for this guild.',
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  };
}
