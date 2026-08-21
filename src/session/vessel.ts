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
  type Client, type Guild, type GuildMember, type OverwriteResolvable,
  type VoiceBasedChannel, type VoiceState,
} from 'discord.js';
import type { DB } from '../lib/db.js';
import type { Fleet } from '../fleet/manager.js';
import { getJoinToCreateChannel } from './guild-row.js';

const CLEANUP_DELAY_MS = 30_000;

interface VesselServiceConfig {
  fleet: Fleet;
  db: DB;
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
  const pendingCleanups = new Map<string, NodeJS.Timeout>();

  const onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): void => {
    // We only care when the channel actually changed. A mute/deafen flip is
    // reported through voiceStateUpdate too, and we do not want to churn on it.
    if (oldState.channelId === newState.channelId) return;

    if (oldState.channelId !== null) {
      void onChannelLeave(cfg, oldState, pendingCleanups).catch((err) => {
        console.error(`vessel: onLeave failed: ${errMsg(err)}`);
      });
    }
    if (newState.channelId !== null) {
      void onChannelJoin(cfg, newState, pendingCleanups).catch((err) => {
        console.error(`vessel: onJoin failed: ${errMsg(err)}`);
      });
    }
  };

  controller.on(Events.VoiceStateUpdate, onVoiceStateUpdate);
  console.log('vessel: service armed on controller');

  return {
    stop(): void {
      controller.off(Events.VoiceStateUpdate, onVoiceStateUpdate);
      for (const timer of pendingCleanups.values()) clearTimeout(timer);
      pendingCleanups.clear();
    },
  };
}

async function onChannelJoin(
  cfg: VesselServiceConfig,
  state: VoiceState,
  pendingCleanups: Map<string, NodeJS.Timeout>,
): Promise<void> {
  const guild = state.guild;
  const channelId = state.channelId;
  if (channelId === null) return;

  // If joining a vessel we already know about, cancel any pending cleanup —
  // a rejoin should keep the channel alive.
  const cleanup = pendingCleanups.get(channelId);
  if (cleanup !== undefined) {
    clearTimeout(cleanup);
    pendingCleanups.delete(channelId);
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
  overwrites.push({
    id: member.id,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
    ],
  });

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
    console.error(`vessel: create failed for ${member.user.tag} in ${guild.id}: ${errMsg(err)}`);
    return;
  }

  cfg.db.prepare(`
    INSERT INTO vessels (guild_id, channel_id, owner_user_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(guild.id, channel.id, member.id, Date.now());
  console.log(`vessel: created ${channel.name} (${channel.id}) for ${member.user.tag}`);

  const moved = await moveOwnerIn(guild, member, channel).catch((err) => {
    console.error(`vessel: MOVE_MEMBERS failed for ${member.user.tag}: ${errMsg(err)}`);
    return false;
  });

  const welcomeLines = [
    `🛰️ **Welcome to your channel, ${member.toString()}.**`,
    moved
      ? 'The control panel — rename / lock / limit / kick / allow-hails / hail — arrives in a later step.'
      : 'Discord blocks the bot from moving you into voice channels ' +
        '(most often because you are the guild owner). Join this channel manually to activate it.',
  ];
  await channel.send({ content: welcomeLines.join('\n') }).catch((err) => {
    console.error(`vessel: welcome message failed: ${errMsg(err)}`);
  });
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
): Promise<void> {
  const channelId = state.channelId;
  if (channelId === null) return;

  const vessel = cfg.db.prepare(`
    SELECT id, guild_id, channel_id, owner_user_id
    FROM vessels
    WHERE channel_id = ? AND deleted_at IS NULL
  `).get(channelId) as VesselRow | undefined;
  if (vessel === undefined) return;

  // Owner-leaves side effect: drop hail_registry. Rename back to 🔊 waits
  // until the callsign registry lands (a later step).
  if (vessel.owner_user_id === state.id) {
    cfg.db.prepare(`DELETE FROM hail_registry WHERE channel_id = ?`).run(channelId);
  }

  // Empty check. Uses the channel's live members map — voiceStateUpdate
  // fires after the cache is updated so this reflects the post-leave state.
  const channel = await state.guild.channels.fetch(channelId).catch(() => null);
  if (channel === null || channel.type !== ChannelType.GuildVoice) return;
  const remainingHumans = channel.members.filter((m) => !m.user.bot).size;
  if (remainingHumans > 0) return;

  scheduleCleanup(cfg, channel.client, channelId, pendingCleanups);
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
  await channel.delete('Star Comms: vessel empty').catch((err) => {
    console.error(`vessel: delete ${channelId} failed: ${errMsg(err)}`);
  });
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
