/**
 * Control-panel interaction handlers.
 *
 * Every handler:
 *   1. Looks up the vessel by `interaction.channelId` — the panel lives
 *      in the vessel's voice-text chat, so the click's channel IS the
 *      vessel channel.
 *   2. Confirms the interaction user is the vessel owner. Non-owners
 *      get an ephemeral refuse.
 *   3. Runs the action (DB write, channel PATCH, member disconnect).
 *   4. Rebuilds the panel and edits the source message so button
 *      labels reflect the new state.
 *
 * Discord's channel-name PATCH is rate-limited to ~2 per 10 min per
 * channel. We do not queue; on 429 we surface a "try again in ~10 min"
 * ephemeral to the operator.
 */

import {
  ActionRowBuilder, ChannelType, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder,
  type AnySelectMenuInteraction, type ButtonInteraction,
  type MessageComponentInteraction, type ModalSubmitInteraction,
  type StringSelectMenuInteraction, type UserSelectMenuInteraction,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import {
  getVesselState, registerVesselForHails, setVesselLocked, setVesselUserLimit,
  unregisterVesselFromHails, type VesselState,
} from '../session/vessel-state.js';
import { CALLSIGN_MAX, CALLSIGN_MIN, registerCallsign, validateCallsign, CallsignError }
  from '../session/callsigns.js';
import type { HailManager } from '../session/hail.js';
import type { Strings } from '../lib/i18n.js';
import { PANEL_IDS, buildPanel } from './panel.js';
import { renderCallsignError } from './callsigns.js';
import { isRateLimitError } from '../lib/rate-limit.js';
import { transferOwnership } from '../session/vessel.js';

export interface PanelDeps {
  db: DB;
  fleet: Fleet;
  hails: HailManager;
  /** String table for a guild's current language. */
  strings: (guildId: string) => Strings;
}

/** Strings for the guild the interaction came from. */
function str(deps: PanelDeps, interaction: { guildId: string | null }): Strings {
  return deps.strings(interaction.guildId ?? '');
}

type AnyPanelInteraction =
  | ButtonInteraction
  | ModalSubmitInteraction
  | AnySelectMenuInteraction;

const CHANNEL_NAME_MAX = 100;
const PREFIX_UNREGISTERED = '🔊';
const PREFIX_REGISTERED = '🛰️';

/** Route a component or modal interaction to its handler. */
export function makePanelDispatcher(deps: PanelDeps) {
  return async (interaction: AnyPanelInteraction): Promise<void> => {
    const id = interaction.customId;
    try {
      switch (id) {
        // `return await` is intentional — `try { return promise }` in an
        // async function does NOT catch the promise's later rejection.
        // Without the await, a Discord API error out of a handler flew
        // right past this try/catch and crashed the process.
        case PANEL_IDS.rename: return await handleRenameClick(deps, interaction as ButtonInteraction);
        case PANEL_IDS.renameSubmit: return await handleRenameSubmit(deps, interaction as ModalSubmitInteraction);
        case PANEL_IDS.lockToggle: return await handleLockToggle(deps, interaction as ButtonInteraction);
        case PANEL_IDS.limit: return await handleLimitClick(deps, interaction as ButtonInteraction);
        case PANEL_IDS.limitSubmit: return await handleLimitSubmit(deps, interaction as ModalSubmitInteraction);
        case PANEL_IDS.kick: return await handleKickClick(deps, interaction as ButtonInteraction);
        case PANEL_IDS.kickPick: return await handleKickPick(deps, interaction as UserSelectMenuInteraction);
        case PANEL_IDS.transfer: return await handleTransferClick(deps, interaction as ButtonInteraction);
        case PANEL_IDS.transferPick: return await handleTransferPick(deps, interaction as StringSelectMenuInteraction);
        case PANEL_IDS.hailsToggle: return await handleHailsToggle(deps, interaction as ButtonInteraction);
        case PANEL_IDS.hail: return await handleHailClick(deps, interaction as ButtonInteraction);
        case PANEL_IDS.hailPick: return await handleHailPick(deps, interaction as StringSelectMenuInteraction);
        default: return; // not our custom_id
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`panel: handler ${id} threw: ${msg}`);
      const body = { content: `error: ${msg}`, flags: MessageFlags.Ephemeral } as const;
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply(body).catch(() => {});
      }
    }
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function requireOwner(
  deps: PanelDeps,
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<VesselState | null> {
  const channelId = interaction.channelId;
  if (channelId === null) return null;
  const state = getVesselState(deps.db, channelId);
  const s = str(deps, interaction);
  if (state === null) {
    await interaction.reply({ content: s.panelHandlers.stale, flags: MessageFlags.Ephemeral }).catch(() => {});
    return null;
  }
  if (interaction.user.id !== state.ownerUserId) {
    await interaction.reply({ content: s.panelHandlers.notOwner, flags: MessageFlags.Ephemeral }).catch(() => {});
    return null;
  }
  return state;
}

function stripPrefix(name: string): { prefix: string; text: string } {
  const trimmed = name.trim();
  if (trimmed.startsWith(PREFIX_REGISTERED)) {
    return { prefix: PREFIX_REGISTERED, text: trimmed.slice(PREFIX_REGISTERED.length).trim() };
  }
  if (trimmed.startsWith(PREFIX_UNREGISTERED)) {
    return { prefix: PREFIX_UNREGISTERED, text: trimmed.slice(PREFIX_UNREGISTERED.length).trim() };
  }
  return { prefix: PREFIX_UNREGISTERED, text: trimmed };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dump what Discord thinks is set on a channel when we hit 50001.
 * Reads from the guild cache so it works even if the bot has lost
 * View on the channel itself — cache is populated from GUILD_CREATE
 * regardless of View.
 */
async function logChannelPermsDiagnostic(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  channelId: string,
): Promise<void> {
  try {
    const guild = interaction.guild;
    if (guild === null) return;
    const cached = guild.channels.cache.get(channelId);
    if (cached === undefined) {
      console.error(`panel-diag: ${channelId} not in guild.channels.cache`);
      return;
    }
    const parentId = 'parentId' in cached ? cached.parentId : null;
    console.error(`panel-diag: ${channelId} parent=${parentId ?? '(none)'}`);
    if ('permissionOverwrites' in cached) {
      for (const [id, ow] of cached.permissionOverwrites.cache) {
        console.error(
          `panel-diag:   overwrite id=${id} type=${ow.type} ` +
          `allow=[${ow.allow.toArray().join(',')}] deny=[${ow.deny.toArray().join(',')}]`,
        );
      }
    }
    const me = await guild.members.fetchMe().catch(() => null);
    if (me !== null && 'permissionsIn' in me) {
      console.error(
        `panel-diag: controller effective on ${channelId}: ` +
        me.permissionsIn(cached).toArray().join(','),
      );
    }

    // Also dump the PARENT category — a category-level @everyone deny
    // ViewChannel with no allow for the controller is the most common
    // reason Discord refuses .setName even when child overwrites say
    // it should be fine.
    if (parentId !== null) {
      const parent = guild.channels.cache.get(parentId);
      if (parent !== undefined && 'permissionOverwrites' in parent) {
        console.error(`panel-diag: parent category ${parentId} ("${parent.name}") overwrites:`);
        for (const [id, ow] of parent.permissionOverwrites.cache) {
          console.error(
            `panel-diag:   overwrite id=${id} type=${ow.type} ` +
            `allow=[${ow.allow.toArray().join(',')}] deny=[${ow.deny.toArray().join(',')}]`,
          );
        }
        if (me !== null) {
          console.error(
            `panel-diag: controller effective on parent: ` +
            me.permissionsIn(parent).toArray().join(','),
          );
        }
      }
    }
  } catch (err) {
    console.error(`panel-diag: dump failed: ${errMsg(err)}`);
  }
}

async function refreshPanel(
  deps: PanelDeps,
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  if (channelId === null) return;
  const state = getVesselState(deps.db, channelId);
  if (state === null) return;
  const rendered = buildPanel(state, deps.strings(state.guildId));
  const message = interaction.message;
  if (message !== null && message !== undefined) {
    await message.edit({ content: rendered.content, components: rendered.components }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

async function handleRenameClick(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const s = str(deps, interaction);
  const modal = new ModalBuilder()
    .setCustomId(PANEL_IDS.renameSubmit)
    .setTitle(s.panelHandlers.renameTitle)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel(s.panelHandlers.renameLabel(CALLSIGN_MIN, CALLSIGN_MAX))
          .setStyle(TextInputStyle.Short)
          .setMinLength(CALLSIGN_MIN)
          .setMaxLength(CALLSIGN_MAX)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

async function handleRenameSubmit(deps: PanelDeps, interaction: ModalSubmitInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);
  const raw = interaction.fields.getTextInputValue('name');

  let cleaned: string;
  try {
    cleaned = validateCallsign(raw);
  } catch (err) {
    await interaction.reply({
      content: err instanceof CallsignError ? renderCallsignError(s, err) : s.panelHandlers.invalidName,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // When hails are on, the vessel name IS the callsign — unique per guild.
  // Route through registerCallsign so the guild-wide uniqueness check
  // applies, and keep the hail_registry row in sync.
  if (state.hailsEnabled) {
    try {
      registerCallsign(deps.db, state.guildId, state.ownerUserId, cleaned);
    } catch (err) {
      await interaction.reply({
        content: err instanceof CallsignError ? renderCallsignError(s, err) : s.panelHandlers.callsignConflict,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    registerVesselForHails(deps.db, state.channelId, state.guildId, cleaned);
  }

  const channel = await interaction.guild!.channels.fetch(state.channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;
  const { prefix } = stripPrefix(channel.name);
  const newName = `${prefix} ${cleaned}`.slice(0, CHANNEL_NAME_MAX);

  try {
    await channel.setName(newName, 'Star Comms: rename via panel');
  } catch (err) {
    if (isRateLimitError(err)) {
      await interaction.reply({ content: s.panelHandlers.renameRateLimited, flags: MessageFlags.Ephemeral });
      return;
    }
    throw err;
  }

  await interaction.reply({ content: s.panelHandlers.renamed(newName), flags: MessageFlags.Ephemeral });
  await refreshPanel(deps, interaction);
}

// ---------------------------------------------------------------------------
// lock / unlock
// ---------------------------------------------------------------------------

async function handleLockToggle(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const channel = await interaction.guild!.channels.fetch(state.channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;

  const nextLocked = !state.locked;
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    { Connect: nextLocked ? false : null },
    { reason: `Star Comms: ${nextLocked ? 'lock' : 'unlock'} via panel` },
  );
  setVesselLocked(deps.db, state.channelId, nextLocked);

  // Atomically re-render the panel message the button lives on.
  // Using `interaction.update` here — a two-call `reply + edit`
  // pattern was leaving the panel stale when the follow-up edit
  // 403'd on channels with narrower controller perms.
  const rendered = buildPanel({ ...state, locked: nextLocked }, deps.strings(state.guildId));
  await interaction.update({ content: rendered.content, components: rendered.components });
}

// ---------------------------------------------------------------------------
// user limit
// ---------------------------------------------------------------------------

async function handleLimitClick(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);
  const modal = new ModalBuilder()
    .setCustomId(PANEL_IDS.limitSubmit)
    .setTitle(s.panelHandlers.limitTitle)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('limit')
          .setLabel(s.panelHandlers.limitLabel)
          .setStyle(TextInputStyle.Short)
          .setValue(String(state.userLimit))
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

async function handleLimitSubmit(deps: PanelDeps, interaction: ModalSubmitInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);
  const raw = interaction.fields.getTextInputValue('limit').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) {
    await interaction.reply({ content: s.panelHandlers.limitInvalid(raw), flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = await interaction.guild!.channels.fetch(state.channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;
  await channel.setUserLimit(parsed, 'Star Comms: limit via panel');
  setVesselUserLimit(deps.db, state.channelId, parsed);

  const rendered = buildPanel({ ...state, userLimit: parsed }, s);
  // Modal-submit only exposes .update when it was opened from a
  // message component (the Limit button here). Guard for the type
  // narrowing; the fallback edits the panel message directly.
  if (interaction.isFromMessage()) {
    await interaction.update({ content: rendered.content, components: rendered.components });
  } else {
    await refreshPanel(deps, interaction);
    await interaction.reply({
      content: parsed === 0 ? s.panelHandlers.limitRemoved : s.panelHandlers.limitSet(parsed),
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ---------------------------------------------------------------------------
// kick
// ---------------------------------------------------------------------------

async function handleKickClick(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);

  const menu = new UserSelectMenuBuilder()
    .setCustomId(PANEL_IDS.kickPick)
    .setPlaceholder(s.panelHandlers.kickPlaceholder)
    .setMinValues(1)
    .setMaxValues(1);
  const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu);

  await interaction.reply({
    content: s.panelHandlers.kickIntro,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleKickPick(deps: PanelDeps, interaction: UserSelectMenuInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);
  const targetId = interaction.values[0];
  if (targetId === undefined) return;

  if (targetId === state.ownerUserId) {
    await interaction.update({ content: s.panelHandlers.kickSelf, components: [] });
    return;
  }

  const guild = interaction.guild!;
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (target === null) {
    await interaction.update({ content: s.panelHandlers.kickNotMember, components: [] });
    return;
  }
  if (target.voice.channelId !== state.channelId) {
    await interaction.update({ content: s.panelHandlers.kickNotInChannel(targetId), components: [] });
    return;
  }

  try {
    await target.voice.disconnect('Star Comms: kick via panel');
  } catch (err) {
    if (err instanceof Error && /Missing Permissions/i.test(err.message)) {
      await interaction.update({ content: s.panelHandlers.kickNoPermission(targetId), components: [] });
      return;
    }
    throw err;
  }

  await interaction.update({ content: s.panelHandlers.kicked(targetId), components: [] });
}

// ---------------------------------------------------------------------------
// transfer ownership
// ---------------------------------------------------------------------------

/** Humans currently in the vessel other than the owner — the transfer candidates. */
async function transferCandidates(
  interaction: MessageComponentInteraction, state: VesselState,
) {
  const channel = await interaction.guild!.channels.fetch(state.channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return null;
  return {
    channel,
    members: channel.members.filter((m) => !m.user.bot && m.id !== state.ownerUserId),
  };
}

async function handleTransferClick(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);

  // A hail leg is bound to the owner's voice; hand-over mid-hail would
  // leave the relay following the wrong person. End it first.
  if (deps.hails.isChannelInHail(state.guildId, state.channelId)) {
    await interaction.reply({ content: s.panelHandlers.transferInHail, flags: MessageFlags.Ephemeral });
    return;
  }

  const found = await transferCandidates(interaction, state);
  if (found === null) return;
  if (found.members.size === 0) {
    await interaction.reply({ content: s.panelHandlers.transferNobody, flags: MessageFlags.Ephemeral });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(PANEL_IDS.transferPick)
    .setPlaceholder(s.panelHandlers.transferPlaceholder)
    .setMinValues(1)
    .setMaxValues(1);
  for (const m of found.members.first(25)) {
    menu.addOptions({
      label: m.displayName.slice(0, 100),
      value: m.id,
      description: m.user.username.slice(0, 100),
    });
  }
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  await interaction.reply({
    content: s.panelHandlers.transferIntro,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTransferPick(
  deps: PanelDeps, interaction: StringSelectMenuInteraction,
): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);
  const targetId = interaction.values[0];
  if (targetId === undefined) return;

  if (deps.hails.isChannelInHail(state.guildId, state.channelId)) {
    await interaction.update({ content: s.panelHandlers.transferInHail, components: [] });
    return;
  }

  const found = await transferCandidates(interaction, state);
  if (found === null) return;
  const target = found.members.get(targetId);
  if (target === undefined) {
    await interaction.update({ content: s.panelHandlers.transferTargetGone, components: [] });
    return;
  }

  // The rename PATCH is the gate and may take a moment; acknowledge
  // first so the 3 s interaction window cannot expire mid-transfer.
  await interaction.deferUpdate();
  const result = await transferOwnership(
    deps, found.channel, state.ownerUserId, target,
    s.vessel.handedOver(state.ownerUserId, target.toString()),
    'Star Comms: transfer via panel',
  );
  const content = result === 'ok'
    ? s.panelHandlers.transferDone(target.toString())
    : result === 'rate_limited'
      ? s.panelHandlers.transferRateLimited
      : s.panelHandlers.transferRenameFailed;
  await interaction.editReply({ content, components: [] });
}

// ---------------------------------------------------------------------------
// allow hails / disable hails
// ---------------------------------------------------------------------------

async function handleHailsToggle(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);

  if (state.hailsEnabled) {
    // Disable: drop the hail_registry row and rename the channel back
    // to `🔊 <display name>`, matching what vessel creation set. This
    // burns the second slot of Discord's ~2-per-10-min rename bucket,
    // so a subsequent Rename will 429 with a ~10 min wait — we surface
    // that as the operator's own next click, not now.
    unregisterVesselFromHails(deps.db, state.channelId);

    const channel = await interaction.guild!.channels.fetch(state.channelId).catch(() => null);
    if (channel !== null && channel.type === ChannelType.GuildVoice) {
      const owner = await interaction.guild!.members.fetch(state.ownerUserId).catch(() => null);
      const displayName = owner?.displayName ?? state.callsign ?? 'channel';
      const targetName = `${PREFIX_UNREGISTERED} ${displayName}`.slice(0, CHANNEL_NAME_MAX);
      await channel.setName(targetName, 'Star Comms: disable-hails').catch((err) => {
        console.error(`panel: disable-hails rename failed for ${state.channelId}: ${errMsg(err)}`);
        void logChannelPermsDiagnostic(interaction, state.channelId);
      });
    }
    // Panel update via interaction.update — atomically re-renders.
    const rendered = buildPanel({ ...state, hailsEnabled: false }, s);
    await interaction.update({ content: rendered.content, components: rendered.components });
    // Fire-and-forget `disconnected` announcement in the vessel.
    void deps.hails.playAnnouncement(state.guildId, state.channelId, 'disconnected')
      .catch((err) => console.error(`panel: disconnected announcement failed: ${errMsg(err)}`));
    return;
  }

  // Enable: register the vessel with the owner's callsign, PATCH the
  // channel name to 🛰️ <callsign>. Requires a registered callsign.
  if (state.callsign === null) {
    await interaction.reply({ content: s.panelHandlers.needCallsignFirst, flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = await interaction.guild!.channels.fetch(state.channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;

  // Register in the directory first — that is the source of truth.
  // The rename is a best-effort visual: on 429 (rate-limit exhausted) or
  // 50001 (missing access on this channel) we still leave the vessel
  // hail-enabled and update the panel; the operator gets a follow-up
  // with what happened.
  registerVesselForHails(deps.db, state.channelId, state.guildId, state.callsign);

  const targetName = `${PREFIX_REGISTERED} ${state.callsign}`.slice(0, CHANNEL_NAME_MAX);
  let renameOk = true;
  let renameErr: unknown = null;
  await channel.setName(targetName, 'Star Comms: allow-hails').catch((err) => {
    renameOk = false;
    renameErr = err;
    console.error(`panel: allow-hails rename failed for ${state.channelId}: ${errMsg(err)}`);
    void logChannelPermsDiagnostic(interaction, state.channelId);
  });

  // Re-render the panel atomically. `interaction.update` swaps the
  // button labels/styles even if the rename PATCH failed.
  const rendered = buildPanel({ ...state, hailsEnabled: true, callsign: state.callsign }, s);
  await interaction.update({ content: rendered.content, components: rendered.components });

  if (!renameOk) {
    const detail = isRateLimitError(renameErr)
      ? s.panelHandlers.renameLimitDetail
      : s.panelHandlers.renameManualDetail;
    await interaction.followUp({
      content: s.panelHandlers.hailsEnabledRenameFailed(detail),
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  // Fire-and-forget `established` announcement — a relay drops in,
  // says the line, leaves.
  void deps.hails.playAnnouncement(state.guildId, state.channelId, 'established')
    .catch((err) => console.error(`panel: established announcement failed: ${errMsg(err)}`));
}

// ---------------------------------------------------------------------------
// hail — target select + open (2-way per Spec §6)
// ---------------------------------------------------------------------------

interface DirectoryRow {
  channel_id: string;
  callsign: string;
}

async function handleHailClick(deps: PanelDeps, interaction: ButtonInteraction): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);

  if (!state.hailsEnabled) {
    await interaction.reply({ content: s.panelHandlers.enableHailsFirst, flags: MessageFlags.Ephemeral });
    return;
  }

  // Build the target directory from hail_registry, excluding self.
  const directory = deps.db.prepare(`
    SELECT channel_id, callsign
    FROM hail_registry
    WHERE guild_id = ? AND channel_id != ?
    ORDER BY callsign COLLATE NOCASE
    LIMIT 25
  `).all(state.guildId, state.channelId) as DirectoryRow[];

  if (directory.length === 0) {
    await interaction.reply({ content: s.panelHandlers.noOtherVessels, flags: MessageFlags.Ephemeral });
    return;
  }

  // Multi-select up to (available bots - 1) targets — the initiator's
  // own vessel also needs a relay, so we deduct one from what the
  // hail manager reports free right now. Fall back to 1 if the pool
  // is small; the manager will re-check at open time regardless.
  const freeBots = deps.hails.freeBotCount(state.guildId);
  const maxTargets = Math.max(1, freeBots - 1);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(PANEL_IDS.hailPick)
    .setPlaceholder(s.panelHandlers.hailPickPlaceholder(maxTargets))
    .setMinValues(1)
    .setMaxValues(Math.min(maxTargets, directory.length));
  for (const row of directory) {
    menu.addOptions({ label: row.callsign, value: row.channel_id });
  }
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

  await interaction.reply({
    content: s.panelHandlers.hailPickIntro,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleHailPick(
  deps: PanelDeps, interaction: StringSelectMenuInteraction,
): Promise<void> {
  const state = await requireOwner(deps, interaction);
  if (state === null) return;
  const s = deps.strings(state.guildId);

  if (interaction.values.length === 0) {
    await interaction.update({ content: s.panelHandlers.noTargets, components: [] });
    return;
  }

  // Resolve every target's current owner. hail_registry guarantees the
  // vessel is registered; we still need the owner id to subscribe to
  // that user's SSRC. Drop any target whose vessel disappeared.
  const targets: Array<{ channelId: string; ownerUserId: string }> = [];
  const dropped: string[] = [];
  for (const channelId of interaction.values) {
    const row = deps.db.prepare(
      `SELECT owner_user_id FROM vessels WHERE channel_id = ? AND deleted_at IS NULL`,
    ).get(channelId) as { owner_user_id: string } | undefined;
    if (row === undefined) { dropped.push(channelId); continue; }
    targets.push({ channelId, ownerUserId: row.owner_user_id });
  }
  if (targets.length === 0) {
    await interaction.update({ content: s.panelHandlers.noneAvailable, components: [] });
    return;
  }

  await interaction.update({ content: s.panelHandlers.opening(targets.length), components: [] });

  const result = await deps.hails.open({
    guildId: state.guildId,
    initiator: { channelId: state.channelId, ownerUserId: state.ownerUserId },
    targets,
  });

  const followUp = result.ok
    ? s.panelHandlers.hailOpen(Math.round(deps.hails.silenceCloseMs() / 1000))
    : s.panelHandlers.hailError(result.reason);

  await interaction.followUp({ content: followUp, flags: MessageFlags.Ephemeral })
    .catch(() => {});
}
