/**
 * `/star-bridge` command tree — spec §16.5.
 *
 *   init           — provision category + control channel (step 5a).
 *   open <mode> <squads>
 *                  — open a session, create per-session voice channels,
 *                    join bots, move owner into the primary net (step 5b).
 *   close          — close the guild's currently open session (step 5b).
 *   status         — snapshot the fleet (step 5a).
 *
 * Commands are guild-scoped. Global commands take up to an hour to
 * propagate to clients; guild-scoped is instant. Since we register per
 * guild anyway (on ClientReady and GuildCreate), guild scope is the right
 * choice for a controller that only serves guilds where it is installed.
 */

import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

/** JSON registered via the REST /applications/{app}/guilds/{guild}/commands endpoint. */
export function starBridgeCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return {
    name: 'star-bridge',
    description: 'Star Bridge controller operations.',
    // Whoever can Manage the guild can run any subcommand. Finer-grained
    // gating (e.g. only the session owner can close) is enforced at
    // handler time — Discord's default_member_permissions is only a
    // coarse gate for command visibility.
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    dm_permission: false,
    options: [
      {
        name: 'init',
        description: 'Provision the category and control channel for this guild. Idempotent.',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'open',
        description: 'Open a new session and create its voice channels.',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'mode',
            description: 'Session mode: command (1 command + N squads) or joint (N ops nets).',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
              { name: 'command', value: 'command' },
              { name: 'joint', value: 'joint' },
            ],
          },
          {
            name: 'squads',
            description: 'Number of squad/ops nets alongside the primary (1–3). Required, no default.',
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 1,
            max_value: 3,
          },
        ],
      },
      {
        name: 'close',
        description: 'Close the session currently open in this guild.',
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
