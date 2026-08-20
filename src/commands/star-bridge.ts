/**
 * `/star-bridge` command definitions — spec §16.5 step 5a.
 *
 * For step 5a we ship a single subcommand: `init`. It provisions the
 * per-guild channel pool (§4) and persists the guild's operating
 * parameters. The wizard, session lifecycle, admin, and alias management
 * arrive with step 5b and later.
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
    // Whoever can Manage the guild can run init. Later subcommands (wizard,
    // suspend/resume) will use finer-grained defaults; step 5a is admin-only.
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    // The bot itself never needs to be in a DM for these; disallow.
    dm_permission: false,
    options: [
      {
        name: 'init',
        description: 'Provision the channel pool for this guild. Idempotent.',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'status',
        description: 'Report the fleet and pool state for this guild.',
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  };
}
