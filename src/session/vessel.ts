/**
 * Vessel service — Spec 1.0 §3.
 *
 * Attaches a voiceStateUpdate listener to the controller. When a member
 * joins the guild's configured join-to-create channel, Star Comms
 * creates a fresh voice channel named `🔊 <display name>` under the
 * trigger's parent category, moves the member in, records the vessel
 * in the DB, and posts a welcome message in the new channel's
 * voice-text chat.
 *
 * When a vessel is emptied (no non-bot members remaining), Star Comms
 * schedules a 30-second cleanup: if still empty at the deadline, the
 * channel is deleted and the vessel row is marked `deleted_at`. A
 * rejoin before the deadline cancels the pending cleanup — the grace
 * period covers brief disconnects and post-init "let me actually go in
 * manually" moments for the guild owner.
 *
 * Owner-leaves drop the `hail_registry` row (if any) so the vessel
 * stops being hailable the instant its owner is out. The rename back
 * from `🛰️ <callsign>` → `🔊 …` waits on the callsign registry
 * landing in a later step.
 */

import {
  ChannelType, Events, OverwriteType, PermissionFlagsBits, PermissionsBitField,
  type Client, type DMChannel, type Guild, type GuildBasedChannel, type GuildMember,
  type OverwriteResolvable, type VoiceBasedChannel, type VoiceState,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import { getJoinToCreateChannel } from './guild-row.js';
import { buildPanel } from '../commands/panel.js';
import { getVesselState } from './vessel-state.js';
import type { HailManager } from './hail.js';
import type { Strings } from '../lib/i18n.js';

const CLEANUP_DELAY_MS = 30_000;

interface VesselServiceConfig {
  fleet: Fleet;
  db: DB;
  /** Present when cues loaded and the hail service is armed. */
  hails: HailManager | null;
  /** String table for a guild's current language. */
  strings: (guildId: string) => Strings;
}

interface VesselRow {
  id: number;
  guild_id: string;
  channel_id: string;
  owner_user_id: string;
}

export interface VesselService {
  stop(): void;
}

export function startVesselService(cfg: VesselServiceConfig): VesselService {
  const controller = cfg.fleet.controllerClient();
  // 30 s pending actions per channel. `Cleanups` = empty channel → delete.
  // `Transfers` = owner absent + others remain → transfer ownership. Only
  // one applies to any channel at a time; the leave handler cancels either
  // and schedules whichever now matches the current channel state.
  const pendingCleanups = new Map<string, NodeJS.Timeout>();
  const pendingTransfers = new Map<string, NodeJS.Timeout>();

  const cancelAll = (channelId: string): void => {
    const c = pendingCleanups.get(channelId);
    if (c !== undefined) { clearTimeout(c); pendingCleanups.delete(channelId); }
    const t = pendingTransfers.get(channelId);
    if (t !== undefined) { clearTimeout(t); pendingTransfers.delete(channelId); }
  };

  const onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): void => {
    // We only care when the channel actually changed. A mute/deafen flip is
    // reported through voiceStateUpdate too, and we do not want to churn on it.
    if (oldState.channelId === newState.channelId) return;

    if (oldState.channelId !== null) {
      void onChannelLeave(cfg, oldState, pendingCleanups, pendingTransfers).catch((err) => {
        console.error(`vessel: onLeave failed: ${errMsg(err)}`);
      });
    }
    if (newState.channelId !== null) {
      void onChannelJoin(cfg, newState, pendingCleanups, pendingTransfers).catch((err) => {
        console.error(`vessel: onJoin failed: ${errMsg(err)}`);
      });
    }
  };

  const onChannelDelete = (channel: DMChannel | GuildBasedChannel): void => {
    if (channel.type !== ChannelType.GuildVoice) return;
    // Idempotent: the row may already be marked deleted by our own delete path.
    reconcileChannelGone(cfg.db, channel.id);
    cancelAll(channel.id);
  };

  controller.on(Events.VoiceStateUpdate, onVoiceStateUpdate);
  controller.on(Events.ChannelDelete, onChannelDelete);
  console.log('vessel: service armed on controller');

  return {
    stop(): void {
      controller.off(Events.VoiceStateUpdate, onVoiceStateUpdate);
      controller.off(Events.ChannelDelete, onChannelDelete);
      for (const timer of pendingCleanups.values()) clearTimeout(timer);
      for (const timer of pendingTransfers.values()) clearTimeout(timer);
      pendingCleanups.clear();
      pendingTransfers.clear();
    },
  };
}

/**
 * Drop hail_registry + mark vessels.deleted_at for a channel that no
 * longer exists on Discord. Called both from the ChannelDelete listener
 * and from the post-login reconciliation pass.
 */
export function reconcileChannelGone(db: DB, channelId: string): void {
  db.prepare(`DELETE FROM hail_registry WHERE channel_id = ?`).run(channelId);
  db.prepare(
    `UPDATE vessels SET deleted_at = ? WHERE channel_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), channelId);
}

async function onChannelJoin(
  cfg: VesselServiceConfig,
  state: VoiceState,
  pendingCleanups: Map<string, NodeJS.Timeout>,
  pendingTransfers: Map<string, NodeJS.Timeout>,
): Promise<void> {
  const guild = state.guild;
  const channelId = state.channelId;
  if (channelId === null) return;

  // Any rejoin (owner or otherwise) cancels the empty-cleanup timer for
  // this channel — the room is inhabited again. An owner-rejoin also
  // cancels the pending ownership-transfer.
  const cleanup = pendingCleanups.get(channelId);
  if (cleanup !== undefined) {
    clearTimeout(cleanup);
    pendingCleanups.delete(channelId);
  }
  const vessel = cfg.db.prepare(`
    SELECT owner_user_id FROM vessels WHERE channel_id = ? AND deleted_at IS NULL
  `).get(channelId) as { owner_user_id: string } | undefined;
  if (vessel !== undefined && vessel.owner_user_id === state.id) {
    const transfer = pendingTransfers.get(channelId);
    if (transfer !== undefined) {
      clearTimeout(transfer);
      pendingTransfers.delete(channelId);
      console.log(`vessel: owner ${state.id} returned to ${channelId} within grace window — transfer cancelled`);
    }
  }

  const joinToCreate = getJoinToCreateChannel(cfg.db, guild.id);
  if (joinToCreate === null) return;
  if (channelId !== joinToCreate) return;

  const member = state.member;
  if (member === null) return;

  await createVesselFor(cfg, guild, member);
}

async function createVesselFor(
  cfg: VesselServiceConfig,
  guild: Guild,
  member: GuildMember,
): Promise<void> {
  const joinToCreateId = getJoinToCreateChannel(cfg.db, guild.id);
  if (joinToCreateId === null) return;
  const trigger = await guild.channels.fetch(joinToCreateId).catch(() => null);
  const parent = trigger?.parentId ?? null;

  const name = `🔊 ${member.displayName}`;

  // Explicit per-channel overwrites. Whatever the parent category has
  // configured, these grants guarantee the controller can post the
  // welcome + control panel messages, and the owner can see + connect
  // to their own vessel. The bot can only grant permissions it holds
  // itself — the controller's invite must include these guild-wide or
  // the create call will 403.
  const controllerUserId = cfg.fleet.controllerClient().user?.id;
  const overwrites: OverwriteResolvable[] = [];
  if (controllerUserId !== undefined) {
    // Keep the create-time overwrite minimal: just ViewChannel +
    // ManageChannels + the message perms. Connect is added
    // post-create so a failed grant doesn't abort the vessel.
    // ManageRoles is skipped here — the controller uses its
    // guild-level ManageRoles to edit overwrites; a channel-level
    // grant added at create-time appears to trigger 50013 in some
    // category configurations even when the controller effectively
    // has ManageRoles on the parent.
    overwrites.push({
      id: controllerUserId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  // Relays are handled post-create (see below): setting a member
  // overwrite for a foreign bot in the create body can 50013 if
  // Discord's server rejects any single item; splitting the relay
  // grants into individual `permissionOverwrites.create` calls after
  // create lets the create itself succeed even if a later overwrite
  // errors, and each per-relay error is diagnosable in isolation.
  overwrites.push({
    id: member.id,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
    ],
  });

  // Pre-check the perms we need before attempting the create — if the
  // OAuth invite did not update the existing role, this is where the
  // failure comes from and Discord's "Missing Permissions" carries no
  // detail. Report which perms the controller is missing so the operator
  // knows what to fix.
  const me = await guild.members.fetchMe().catch(() => null);
  const required = [
    { name: 'ManageChannels', bit: PermissionFlagsBits.ManageChannels },
    { name: 'ManageRoles', bit: PermissionFlagsBits.ManageRoles },
    { name: 'MoveMembers', bit: PermissionFlagsBits.MoveMembers },
    { name: 'ViewChannel', bit: PermissionFlagsBits.ViewChannel },
    { name: 'Connect', bit: PermissionFlagsBits.Connect },
    { name: 'SendMessages', bit: PermissionFlagsBits.SendMessages },
  ] as const;
  const missing = me === null
    ? required.map((r) => r.name)
    : required.filter((r) => !me.permissions.has(r.bit)).map((r) => r.name);
  if (missing.length > 0) {
    console.error(
      `vessel: controller is missing guild perms in ${guild.id}: ${missing.join(', ')}. ` +
      'Kick the controller from this guild and re-invite it; Discord does not refresh ' +
      'an existing bot role on re-invite.',
    );
    return;
  }

  let channel: VoiceBasedChannel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parent ?? undefined,
      reason: `Star Comms: vessel for ${member.user.tag}`,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    const code = (err as { code?: unknown; rawError?: { message?: string } }).code;
    const rawMessage = (err as { rawError?: { message?: string } }).rawError?.message;
    console.error(
      `vessel: create failed for ${member.user.tag} in ${guild.id}: ` +
      `code=${String(code)} raw="${rawMessage ?? ''}" ${errMsg(err)}`,
    );
    // On a 50013 with a parent set, dump the controller's effective perms
    // ON that category so the operator can see which ALLOWs it lacks
    // there — that is by far the most common cause of this error.
    if (code === 50013 && parent !== null && me !== null) {
      const parentChannel = await guild.channels.fetch(parent).catch(() => null);
      if (parentChannel !== null) {
        const effective = me.permissionsIn(parentChannel);
        const missingHere = required.filter((r) => !effective.has(r.bit)).map((r) => r.name);
        console.error(
          `vessel: parent category ${parent} ("${parentChannel.name}") — ` +
          `controller effective perms: ${effective.toArray().join(', ')}`,
        );
        if (missingHere.length > 0) {
          console.error(
            `vessel: category-level DENY overrides guild perms for: ${missingHere.join(', ')}. ` +
            'Fix: server settings → the category → Permissions → add an override for the ' +
            'controller bot that Allows those perms, or remove the deny.',
          );
        }
      }
    }
    return;
  }

  cfg.db.prepare(`
    INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(guild.id, channel.id, member.id, Date.now());
  console.log(`vessel: created ${channel.name} (${channel.id}) for ${member.user.tag}`);

  // Post-create fleet grants:
  //   • Controller gets Connect added on top of its create-time overwrite
  //     so a subsequent Lock (`@everyone deny Connect`) doesn't lock the
  //     controller out of edits on its own vessel.
  //   • Each relay gets View+Connect+Speak so hails into locked
  //     channels still work (§6).
  // Split from the create body because setting these inline can 50013
  // in some category configurations; done one at a time so a single
  // per-relay failure is diagnosable in isolation.
  if (controllerUserId !== undefined) {
    await channel.permissionOverwrites.edit(controllerUserId, {
      Connect: true,
    }, {
      type: OverwriteType.Member,
      reason: 'Star Comms: controller Connect for lock-immunity',
    }).catch((err) => {
      console.warn(`vessel: controller Connect overwrite failed on ${channel.id}: ${errMsg(err)}`);
    });
  }
  for (const relayId of cfg.fleet.botUserIds()) {
    if (relayId === controllerUserId) continue;
    // Explicit `type: OverwriteType.Member` skips discord.js's
    // member/role lookup — the relay bot users aren't in the
    // controller Client's guild-members cache and the lookup would
    // otherwise 400 with "Supplied parameter is not a User nor a Role".
    await channel.permissionOverwrites.create(relayId, {
      ViewChannel: true,
      Connect: true,
      Speak: true,
    }, {
      type: OverwriteType.Member,
      reason: 'Star Comms: relay access for hails',
    }).catch((err) => {
      console.warn(`vessel: relay overwrite for ${relayId} failed on ${channel.id}: ${errMsg(err)}`);
    });
  }

  const moved = await moveOwnerIn(guild, member, channel).catch((err) => {
    console.error(`vessel: MOVE_MEMBERS failed for ${member.user.tag}: ${errMsg(err)}`);
    return false;
  });

  const state = getVesselState(cfg.db, channel.id);
  if (state === null) {
    console.error(`vessel: state lookup failed for freshly-created ${channel.id}`);
    return;
  }
  const s = cfg.strings(state.guildId);
  const panel = buildPanel(state, s);
  const notice = moved ? '' : s.vessel.cannotMoveNotice;
  const posted = await channel.send({
    content: `${panel.content}${notice}`, components: panel.components,
  }).catch((err) => {
    console.error(`vessel: panel post failed: ${errMsg(err)}`);
    return null;
  });
  // Persist the panel message id so background paths (ownership
  // transfer, others) can fetch + edit it without an interaction.
  if (posted !== null) {
    cfg.db.prepare(
      `UPDATE vessels SET panel_message_id = ? WHERE channel_id = ?`,
    ).run(posted.id, channel.id);
  }
}

async function moveOwnerIn(
  guild: Guild,
  member: GuildMember,
  channel: VoiceBasedChannel,
): Promise<boolean> {
  if (member.id === guild.ownerId) return false;
  await member.voice.setChannel(channel.id, `Star Comms: vessel activation`);
  return true;
}

async function onChannelLeave(
  cfg: VesselServiceConfig,
  state: VoiceState,
  pendingCleanups: Map<string, NodeJS.Timeout>,
  pendingTransfers: Map<string, NodeJS.Timeout>,
): Promise<void> {
  const channelId = state.channelId;
  if (channelId === null) return;

  const vessel = cfg.db.prepare(`
    SELECT id, guild_id, channel_id, owner_user_id
    FROM vessels
    WHERE channel_id = ? AND deleted_at IS NULL
  `).get(channelId) as VesselRow | undefined;
  if (vessel === undefined) return;

  // Owner-leaves side effect: force-close any hail this vessel is
  // currently part of.
  const ownerLeft = vessel.owner_user_id === state.id;
  if (ownerLeft && cfg.hails !== null) {
    await cfg.hails.handleOwnerLeft(state.guild.id, state.id, channelId).catch((err) => {
      console.error(`vessel: hail close on owner-leave failed: ${errMsg(err)}`);
    });
  }

  // Empty check. Uses the channel's live members map — voiceStateUpdate
  // fires after the cache is updated so this reflects the post-leave state.
  const channel = await state.guild.channels.fetch(channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;
  const remainingHumans = channel.members.filter((m) => !m.user.bot);

  if (remainingHumans.size === 0) {
    // Nobody left. Empty-cleanup path takes precedence: cancel any
    // pending transfer (others just left too), schedule the 30 s delete.
    const t = pendingTransfers.get(channelId);
    if (t !== undefined) { clearTimeout(t); pendingTransfers.delete(channelId); }
    scheduleCleanup(cfg, channel.client, channelId, pendingCleanups);
    return;
  }

  // Others remain. Owner absent → schedule a 30 s ownership transfer,
  // matching the empty-cleanup grace window. A rejoin within that
  // window cancels the transfer (see onChannelJoin). Only the founder
  // triggers a transfer schedule; a non-owner leaving with the owner
  // still around is a no-op.
  if (ownerLeft) {
    scheduleTransfer(cfg, channelId, pendingTransfers);
  }
}

function scheduleTransfer(
  cfg: VesselServiceConfig,
  channelId: string,
  pendingTransfers: Map<string, NodeJS.Timeout>,
): void {
  const existing = pendingTransfers.get(channelId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTransfers.delete(channelId);
    void transferIfOwnerStillAbsent(cfg, channelId).catch((err) => {
      console.error(`vessel: transfer check failed for ${channelId}: ${errMsg(err)}`);
    });
  }, CLEANUP_DELAY_MS);
  pendingTransfers.set(channelId, timer);
}

async function transferIfOwnerStillAbsent(
  cfg: VesselServiceConfig,
  channelId: string,
): Promise<void> {
  const vessel = cfg.db.prepare(`
    SELECT id, guild_id, channel_id, owner_user_id
    FROM vessels
    WHERE channel_id = ? AND deleted_at IS NULL
  `).get(channelId) as VesselRow | undefined;
  if (vessel === undefined) return;

  const controller = cfg.fleet.controllerClient();
  const channel = await controller.channels.fetch(channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;

  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) return; // empty-cleanup path will handle it
  if (humans.has(vessel.owner_user_id)) {
    // Owner came back inside the window; nothing to do.
    return;
  }
  const successor = humans.first();
  if (successor === undefined) return;
  await transferOwnership(cfg, channel, vessel.owner_user_id, successor).catch((err) => {
    console.error(`vessel: ownership transfer failed on ${channelId}: ${errMsg(err)}`);
  });
}

async function transferOwnership(
  cfg: VesselServiceConfig,
  channel: VoiceBasedChannel,
  oldOwnerUserId: string,
  successor: GuildMember,
): Promise<void> {
  cfg.db.prepare(
    `UPDATE vessels SET owner_user_id = ? WHERE channel_id = ? AND deleted_at IS NULL`,
  ).run(successor.id, channel.id);
  cfg.db.prepare(`DELETE FROM hail_registry WHERE channel_id = ?`).run(channel.id);

  // Best-effort rename to `🔊 <new owner display name>`. Discord's
  // ~2/10 min rename bucket may reject this; log the failure and move
  // on. The DB state is authoritative — the visual will follow the
  // next time the rename bucket has capacity, or on the next click.
  const newName = `🔊 ${successor.displayName}`.slice(0, 100);
  await channel.setName(newName, 'Star Comms: ownership transfer').catch((err) => {
    console.warn(`vessel: rename on ownership transfer 429/failed: ${errMsg(err)}`);
  });

  // Re-render the control panel so buttons + owner mention + hails
  // state reflect the transfer. We do NOT have an interaction here to
  // call `.update()` with, so fetch the persisted panel message by
  // its id and edit in place.
  const row = cfg.db.prepare(
    `SELECT panel_message_id FROM vessels WHERE channel_id = ?`,
  ).get(channel.id) as { panel_message_id: string | null } | undefined;
  const messageId = row?.panel_message_id ?? null;
  if (messageId !== null) {
    const freshState = getVesselState(cfg.db, channel.id);
    if (freshState !== null) {
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (message !== null) {
        const rendered = buildPanel(freshState, cfg.strings(freshState.guildId));
        await message.edit({
          content: rendered.content, components: rendered.components,
        }).catch((err) => {
          console.warn(`vessel: panel refresh on transfer failed: ${errMsg(err)}`);
        });
      }
    }
  }

  await channel.send({
    content: cfg.strings(channel.guildId).vessel.transferred(oldOwnerUserId, successor.toString()),
  }).catch((err) => {
    console.error(`vessel: transfer notice post failed: ${errMsg(err)}`);
  });

  console.log(
    `vessel: transferred ${channel.id} from ${oldOwnerUserId} → ${successor.id}`,
  );
}

function scheduleCleanup(
  cfg: VesselServiceConfig,
  client: Client,
  channelId: string,
  pendingCleanups: Map<string, NodeJS.Timeout>,
): void {
  const existing = pendingCleanups.get(channelId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingCleanups.delete(channelId);
    void cleanupIfStillEmpty(cfg, client, channelId).catch((err) => {
      console.error(`vessel: cleanup failed for ${channelId}: ${errMsg(err)}`);
    });
  }, CLEANUP_DELAY_MS);
  pendingCleanups.set(channelId, timer);
}

async function cleanupIfStillEmpty(
  cfg: VesselServiceConfig,
  client: Client,
  channelId: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    markDeleted(cfg.db, channelId);
    return;
  }
  const remainingHumans = channel.members.filter((m) => !m.user.bot).size;
  if (remainingHumans > 0) return; // someone joined during the grace window

  // Best-effort permission check: only delete if we have MANAGE_CHANNELS.
  const me = await channel.guild.members.fetchMe().catch(() => null);
  if (me !== null && !me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageChannels)) {
    console.error(`vessel: cannot delete ${channelId} — controller lacks ManageChannels`);
    return;
  }
  try {
    await channel.delete('Star Comms: vessel empty');
  } catch (err) {
    console.error(
      `vessel: delete ${channelId} failed: ${errMsg(err)} — DB row kept ` +
      `for the periodic reconcile pass to retry.`,
    );
    return;
  }
  cfg.db.prepare(`DELETE FROM hail_registry WHERE channel_id = ?`).run(channelId);
  markDeleted(cfg.db, channelId);
  console.log(`vessel: deleted empty ${channelId}`);
}

function markDeleted(db: DB, channelId: string): void {
  db.prepare(
    `UPDATE vessels SET deleted_at = ? WHERE channel_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), channelId);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
