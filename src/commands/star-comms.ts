/**
 * `/star-comms` command tree.
 *
 * Top-level command is NOT `default_member_permissions`-gated so
 * every member of the guild sees it — the registration flow needs
 * ordinary members to have access. Admin-gated subcommands enforce
 * `MANAGE_GUILD` in the handler.
 *
 * Subcommand *names* are stable identifiers (they key the handler
 * map and appear in docs); only *descriptions* are localised. The
 * registrar registers per guild, so each guild sees descriptions in
 * its own language and `set-language` re-registers on change.
 */

import {
  ApplicationCommandOptionType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { CALLSIGN_MAX, CALLSIGN_MIN } from '../session/callsigns.js';
import type { Strings } from '../lib/i18n.js';

export const SUBCOMMANDS = {
  watchChannel: 'watch-channel',
  setLanguage: 'set-language',
  register: 'register',
  unregister: 'unregister',
  callsign: 'callsign',
  status: 'status',
} as const;

export function starCommsCommand(s: Strings): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return {
    name: 'star-comms',
    description: s.cmd.root,
    dm_permission: false,
    options: [
      {
        name: SUBCOMMANDS.watchChannel,
        description: s.cmd.watchChannel,
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: SUBCOMMANDS.setLanguage,
        description: s.cmd.setLanguage,
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: SUBCOMMANDS.register,
        description: s.cmd.register,
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'callsign',
            description: s.cmd.registerCallsignOption(CALLSIGN_MIN, CALLSIGN_MAX),
            type: ApplicationCommandOptionType.String,
            required: true,
            min_length: CALLSIGN_MIN,
            max_length: CALLSIGN_MAX,
          },
        ],
      },
      {
        name: SUBCOMMANDS.unregister,
        description: s.cmd.unregister,
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: SUBCOMMANDS.callsign,
        description: s.cmd.callsign,
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: SUBCOMMANDS.status,
        description: s.cmd.status,
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  };
}
