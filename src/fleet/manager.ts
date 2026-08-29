/**
 * Fleet manager — spec §16.2 with the 4-bot divergence from CLAUDE.md.
 *
 * One process, one discord.js Client per squad member, and one additional
 * client for the controller application. All logged in with GUILDS +
 * GUILD_VOICE_STATES + GUILD_MEMBERS. §12 explains why the privileged
 * intent is needed: without it a client cannot resolve net membership. If
 * the developer-portal toggle is off, login fails with DisallowedIntents,
 * so successful login is the assertion (§12 risk box).
 *
 * Connection hygiene per §6:
 *
 *   • Park permanently — no idle disconnect timer.
 *   • Prefer session resume over rejoin. discord.js's WebSocketManager does
 *     this automatically as long as we do NOT call `client.destroy()` on a
 *     transient disconnect. We destroy only on process shutdown.
 *
 * The manager surfaces per-bot state so /healthz can prove the fleet is up
 * without joining any voice channel — voice joining is the relay's job
 * (spec §16.3) and provisioning is the controller's (spec §16.5).
 */

import { Client, Events, GatewayIntentBits, Status } from 'discord.js';
import { rejectChannelPatchRateLimit } from '../lib/rate-limit.js';
import type { ControllerConfig, FleetMember } from '../lib/config.js';

export interface BotState {
  /** 'controller' for the standalone command bot; nato name for squad. */
  nato: string;
  role: 'controller' | 'squad';
  applicationId: string;
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
  nato: string;
  role: 'controller' | 'squad';
  applicationId: string;
  token: string;
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
  private readonly controller: BotEntry;
  private readonly squad: BotEntry[];
  private shuttingDown = false;

  constructor(controller: ControllerConfig, members: FleetMember[]) {
    this.controller = this.makeEntry({
      nato: 'controller',
      role: 'controller',
      applicationId: controller.applicationId,
      token: controller.token,
    });
    this.squad = members.map((m) => this.makeEntry({
      nato: m.nato,
      role: 'squad',
      applicationId: m.applicationId,
      token: m.token,
    }));
  }

  private makeEntry(spec: { nato: string; role: 'controller' | 'squad'; applicationId: string; token: string }): BotEntry {
    // Channel-name PATCH 429s must throw, not queue for 10 min — the
    // rename-gated transfer and the panel's rename paths depend on it.
    const client = new Client({
      intents: [...INTENTS],
      rest: { rejectOnRateLimit: rejectChannelPatchRateLimit },
    });
    const state: BotState = {
      nato: spec.nato,
      role: spec.role,
      applicationId: spec.applicationId,
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
    const entry: BotEntry = { ...spec, client, state };
    this.wire(entry);
    return entry;
  }

  private mark(entry: BotEntry, event: string): void {
    entry.state.lastEvent = event;
    entry.state.lastEventAt = new Date().toISOString();
    entry.state.status = statusName(entry.client.ws.status);
  }

  private wire(entry: BotEntry): void {
    const { client, state } = entry;
    const tag = `[${entry.nato}]`;

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

  private allEntries(): BotEntry[] { return [this.controller, ...this.squad]; }

  /**
   * Log every bot in (controller + squad) and resolve when they have all
   * fired ClientReady. A single failed login (bad token, disallowed
   * intents) aborts start-up — a fleet missing a callsign, or a controller
   * that never logs in, is broken by definition.
   */
  async start(readyTimeoutMs = 30_000): Promise<void> {
    const entries = this.allEntries();
    const readies = entries.map((entry) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `[${entry.nato}] did not reach ready within ${readyTimeoutMs}ms`,
      )), readyTimeoutMs);
      entry.client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
      entry.client.once(Events.Error, (err) => { clearTimeout(timer); reject(err); });
    }));

    await Promise.all(entries.map((e) => e.client.login(e.token)));
    await Promise.all(readies);
  }

  states(): BotState[] {
    // Refresh live status before returning; it changes without an event.
    for (const e of this.allEntries()) e.state.status = statusName(e.client.ws.status);
    return this.allEntries().map((e) => ({ ...e.state, guildIds: [...e.state.guildIds] }));
  }

  get size(): number { return this.allEntries().length; }

  isShuttingDown(): boolean { return this.shuttingDown; }

  /**
   * The Client for a squad member by NATO name — used by the relay to
   * attach receive/transmit paths to specific bots (spec §16.3).
   */
  clientFor(nato: string): Client {
    const e = this.squad.find((b) => b.nato === nato);
    if (e === undefined) throw new Error(`no squad member with nato=${nato}`);
    return e.client;
  }

  /** The controller Client — registrar for /star-comms, holder of channel-management perms. */
  controllerClient(): Client { return this.controller.client; }

  /**
   * User IDs of every fleet member (controller + squad) that has finished
   * login. Used to drop the fleet's own audio *before* any detection path
   * — spec §5, the highest-consequence bug in the product: without this
   * the fleet talks to itself. A client that has not reached ready has no
   * user yet and is skipped; that is safe because its audio cannot appear
   * in any voice channel yet either.
   */
  botUserIds(): Set<string> {
    const s = new Set<string>();
    for (const e of this.allEntries()) {
      const id = e.client.user?.id;
      if (id !== undefined) s.add(id);
    }
    return s;
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await Promise.allSettled(this.allEntries().map((e) => e.client.destroy()));
  }
}
