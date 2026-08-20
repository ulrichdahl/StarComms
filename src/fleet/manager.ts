/**
 * Fleet manager — spec §16.2.
 *
 * One process, one discord.js Client per fleet member, all logged in with the
 * privileged GUILD_MEMBERS intent. §12 explains why: without it a member can
 * connect but cannot resolve net membership. If the intent toggle in the
 * developer portal is off, login itself fails with DisallowedIntents — so
 * successful login is the assertion (§12 risk box).
 *
 * Connection hygiene per §6:
 *
 *   • Park permanently — no idle disconnect timer.
 *   • Prefer session resume over rejoin. discord.js's WebSocketManager does
 *     this automatically as long as we do NOT call `client.destroy()` on a
 *     transient disconnect. We destroy only on process shutdown.
 *
 * The manager surfaces per-bot state so the /healthz endpoint can prove the
 * fleet is up without joining any voice channel — voice joining is step 3's
 * job (spec §16.3).
 */

import { Client, Events, GatewayIntentBits, Status } from 'discord.js';
import type { FleetMember } from '../lib/config.js';

export interface BotState {
  nato: string;
  applicationId: string;
  controller: boolean;
  loggedIn: boolean;
  /** discord.js Client status: READY, IDLE, CONNECTING, RECONNECTING, ... */
  status: string;
  /** From client.user after ready: `name#discriminator` or username. */
  tag: string | null;
  /** Guilds this client is a member of, resolved after ready. */
  guildIds: string[];
  /** Cumulative counts across the process lifetime. */
  resumes: number;
  reconnects: number;
  disconnects: number;
  errors: number;
  /** ISO timestamp of the last state change, for spotting stuck clients. */
  lastEventAt: string | null;
  lastEvent: string | null;
}

interface BotEntry {
  member: FleetMember;
  client: Client;
  state: BotState;
}

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers,
] as const;

function statusName(s: number): string {
  return Status[s] ?? String(s);
}

export class Fleet {
  private readonly bots: BotEntry[];
  private shuttingDown = false;

  constructor(members: FleetMember[]) {
    this.bots = members.map((m) => this.makeEntry(m));
  }

  private makeEntry(member: FleetMember): BotEntry {
    const client = new Client({ intents: [...INTENTS] });
    const state: BotState = {
      nato: member.nato,
      applicationId: member.applicationId,
      controller: member.controller,
      loggedIn: false,
      status: 'INIT',
      tag: null,
      guildIds: [],
      resumes: 0,
      reconnects: 0,
      disconnects: 0,
      errors: 0,
      lastEventAt: null,
      lastEvent: null,
    };
    const entry: BotEntry = { member, client, state };
    this.wire(entry);
    return entry;
  }

  private mark(entry: BotEntry, event: string): void {
    entry.state.lastEvent = event;
    entry.state.lastEventAt = new Date().toISOString();
    entry.state.status = statusName(entry.client.ws.status);
  }

  private wire(entry: BotEntry): void {
    const { client, member, state } = entry;
    const tag = `[${member.nato}]`;

    client.on(Events.ClientReady, (c) => {
      state.loggedIn = true;
      state.tag = c.user.tag;
      state.guildIds = [...c.guilds.cache.keys()];
      this.mark(entry, 'ready');
      console.log(`${tag} ready as ${c.user.tag} in ${state.guildIds.length} guild(s)`);
    });

    client.on(Events.ShardResume, () => {
      state.resumes++;
      this.mark(entry, 'resume');
      console.log(`${tag} resumed session (no rejoin, no chime)`);
    });

    client.on(Events.ShardReconnecting, () => {
      state.reconnects++;
      this.mark(entry, 'reconnecting');
      console.log(`${tag} reconnecting`);
    });

    client.on(Events.ShardDisconnect, (_ev, id) => {
      state.disconnects++;
      this.mark(entry, `disconnect(shard=${id})`);
      console.log(`${tag} shard ${id} disconnected — waiting for auto-resume`);
    });

    client.on(Events.ShardError, (err, id) => {
      state.errors++;
      this.mark(entry, `error: ${err.message}`);
      console.error(`${tag} shard ${id} error: ${err.message}`);
    });

    client.on(Events.Error, (err) => {
      state.errors++;
      this.mark(entry, `error: ${err.message}`);
      console.error(`${tag} client error: ${err.message}`);
    });

    // Guild membership updates while the process is up.
    client.on(Events.GuildCreate, (g) => {
      if (!state.guildIds.includes(g.id)) state.guildIds.push(g.id);
      this.mark(entry, `guildCreate(${g.id})`);
    });
    client.on(Events.GuildDelete, (g) => {
      state.guildIds = state.guildIds.filter((id) => id !== g.id);
      this.mark(entry, `guildDelete(${g.id})`);
    });
  }

  /**
   * Log every bot in and resolve when they have all fired ClientReady.
   * A single failed login (bad token, disallowed intents) aborts start-up —
   * a fleet missing a callsign is broken by definition (spec §2).
   */
  async start(readyTimeoutMs = 30_000): Promise<void> {
    const readies = this.bots.map((entry) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `[${entry.member.nato}] did not reach ready within ${readyTimeoutMs}ms`,
      )), readyTimeoutMs);
      entry.client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
      entry.client.once(Events.Error, (err) => { clearTimeout(timer); reject(err); });
    }));

    await Promise.all(this.bots.map((e) => e.client.login(e.member.token)));
    await Promise.all(readies);
  }

  states(): BotState[] {
    // Refresh live status before returning; it changes without an event.
    for (const e of this.bots) e.state.status = statusName(e.client.ws.status);
    return this.bots.map((e) => ({ ...e.state, guildIds: [...e.state.guildIds] }));
  }

  get size(): number { return this.bots.length; }

  isShuttingDown(): boolean { return this.shuttingDown; }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await Promise.allSettled(this.bots.map((e) => e.client.destroy()));
  }
}
