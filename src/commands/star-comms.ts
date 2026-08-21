/**
 * `/star-comms` command tree.
 *
 * Top-level command is NOT `default_member_permissions`-gated so
 * every member of the guild sees it — the registration flow needs
 * ordinary members to have access. Admin-gated subcommands enforce
 * `MANAGE_GUILD` in the handler.
 */

import {
  ApplicationCommandOptionType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { CALLSIGN_MAX, CALLSIGN_MIN } from '../session/callsigns.js';

export function starCommsCommand(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return {
    name: 'star-comms',
    description: 'Star Comms — cooperative-play voice bridge.',
    dm_permission: false,
    options: [
      {
        name: 'init',
        description: 'Admin: configure Star Comms for this guild — pick the join-to-create voice channel.',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'register',
        description: 'Register or replace your callsign in this guild.',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'callsign',
            description: `Your ship name (${CALLSIGN_MIN}–${CALLSIGN_MAX} characters).`,
            type: ApplicationCommandOptionType.String,
            required: true,
            min_length: CALLSIGN_MIN,
            max_length: CALLSIGN_MAX,
          },
        ],
      },
      {
        name: 'unregister',
        description: 'Remove your callsign. Drops your vessels from the hail directory too.',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'callsign',
        description: 'Report your current callsign.',
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
