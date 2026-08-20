/**
 * Star Bridge entrypoint — steps 2–5a of the build order (spec §16).
 *
 * config → db → boot sweep → cues → fleet → slash registrar → optional relay → status
 *
 * The order matters. The boot sweep must run before the fleet connects: an
 * open relay left by a crash needs to be recovered, and touching Discord
 * before then would double-serve the same net (spec §11).
 *
 * The blind relay is skipped when its two channel ids are unset — the
 * step 2 fleet manager continues to work without step 3 wiring. The
 * slash registrar always runs on the controller.
 */

import { MessageFlags } from 'discord.js';
import { intEnv, loadEnv, optionalEnv } from './lib/env.js';
import { loadConfig, redactMember } from './lib/config.js';
import { openDb } from './lib/db.js';
import { loadCueSet, resolveCuePaths, type CueSet } from './lib/cues.js';
import { bootSweep, formatSweep } from './fleet/boot-sweep.js';
import { Fleet } from './fleet/manager.js';
import { startStatusServer } from './fleet/status.js';
import { BlindRelay } from './relay/blind.js';
import { makeRegistrar, type SubcommandHandler } from './commands/registrar.js';
import { provisionGuild } from './pool/provisioning.js';
import { closeSession, openSession, SessionError } from './session/lifecycle.js';
import type { SessionMode } from './session/model.js';

async function main(): Promise<void> {
  const startedAt = new Date();
  loadEnv();

  const configPath = optionalEnv('CONFIG_PATH', 'config/fleet.yaml');
  const dbPath = optionalEnv('DB_PATH', 'data/starbridge.db');
  const port = intEnv('STATUS_PORT', 3000);
  const relaySource = optionalEnv('RELAY_SOURCE_CHANNEL_ID', '');
  const relayTarget = optionalEnv('RELAY_TARGET_CHANNEL_ID', '');
  const relayEnabled = relaySource !== '' && relayTarget !== '';

  console.log(`config: ${configPath}`);
  const config = loadConfig(configPath);
  console.log(`fleet: ${config.fleet.length} member(s)`);
  for (const m of config.fleet) console.log(`  ${JSON.stringify(redactMember(m))}`);

  console.log(`db: ${dbPath}`);
  const db = openDb(dbPath);

  const sweep = bootSweep(db);
  console.log(formatSweep(sweep));

  // Cues are loaded before the fleet touches voice: an invalid asset should
  // fail the boot loud, not silently disable the trigger endpoint later.
  // See spec §5. If the yaml has no cue_sets, the fleet still comes up
  // without cues — but /trigger will 503.
  let cues: CueSet | null = null;
  try {
    const paths = resolveCuePaths(config.raw, config.defaults.cueSet, config.defaults.locale, configPath);
    cues = await loadCueSet(paths, config.defaults.cueDurationMs);
    console.log(`cues: loaded ${cues.summary().length} at ~${config.defaults.cueDurationMs} ms each`);
    for (const c of cues.summary()) {
      console.log(`  ${c.name.padEnd(10)} ${String(c.durationMs).padStart(5)} ms  ${c.packets} packets  ${c.path}`);
    }
  } catch (err) {
    console.warn(`cues: not loaded — ${err instanceof Error ? err.message : String(err)}`);
    console.warn('cues: continuing without them; /trigger will 503 until cues load cleanly');
  }

  const fleet = new Fleet(config.controller, config.fleet);
  console.log('logging in fleet...');
  await fleet.start();
  console.log('all members ready');

  // Slash registrar runs on the controller only (see CLAUDE.md 4-bot layout).
  // Handlers close over fleet, config and db so provisioning has everything it
  // needs without a global lookup service.
  const handlers: Record<string, SubcommandHandler> = {
    init: async (interaction) => {
      const guild = interaction.guild;
      if (guild === null) {
        await interaction.reply({ content: 'this command must be used in a guild', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const summary = await provisionGuild(guild, config.defaults, db);
      const line = (label: string, id: string, created: boolean): string =>
        `${label}: <#${id}>${created ? ' (created)' : ' (reused)'}`;
      const body = [
        `**Star Bridge init in ${summary.guildName}**`,
        line('category', summary.categoryId, summary.categoryCreated),
        line('control channel', summary.controlChannelId, summary.controlChannelCreated),
        '',
        'Voice channels are created per session; run `/star-bridge open` (step 5b) to start one.',
      ];
      await interaction.editReply(body.join('\n'));
    },
    status: async (interaction) => {
      const bots = fleet.states();
      const lines = ['**Star Bridge fleet status**'];
      for (const b of bots) {
        lines.push(`\`${b.role.padEnd(10)}\` **${b.nato}** — ${b.status} ${b.tag ?? ''} guilds=${b.guildIds.length}`);
      }
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    },
    open: async (interaction) => {
      const guild = interaction.guild;
      if (guild === null) {
        await interaction.reply({ content: 'this command must be used in a guild', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mode = interaction.options.getString('mode', true) as SessionMode;
      const squads = interaction.options.getInteger('squads') ?? 3;
      try {
        const result = await openSession({
          guild, ownerId: interaction.user.id, mode, squads, fleet, db,
        });
        const netLines = result.nets.map(
          (n) => `• ${n.callsign} — <#${n.channelId}> (bot: ${n.botKey})`,
        );
        const body = [
          `**Session ${result.sessionId} open** — mode ${result.mode}, ${result.nets.length} net(s)`,
          ...netLines,
          '',
          `You have been moved into ${result.nets[0]?.callsign ?? 'the primary net'}. Use \`/star-bridge close\` to end the session.`,
        ];
        await interaction.editReply(body.join('\n'));
      } catch (err) {
        if (err instanceof SessionError) {
          await interaction.editReply(`open failed: ${err.message}`);
          return;
        }
        throw err;
      }
    },
    close: async (interaction) => {
      const guild = interaction.guild;
      if (guild === null) {
        await interaction.reply({ content: 'this command must be used in a guild', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await closeSession({ guild, fleet, db });
        const line = `**Session ${result.sessionId} closed** — ${result.netsClosed} net(s)`
          + (result.strandedMoved > 0 ? `, moved ${result.strandedMoved} straggler(s) to AFK` : '');
        await interaction.editReply(line);
      } catch (err) {
        if (err instanceof SessionError) {
          await interaction.editReply(`close failed: ${err.message}`);
          return;
        }
        throw err;
      }
    },
  };
  const registrar = makeRegistrar(config.controller, fleet.controllerClient(), handlers);
  await registrar.start();

  let relay: BlindRelay | null = null;
  if (relayEnabled) {
    console.log(`relay: bravo -> charlie (${relaySource} -> ${relayTarget})`);
    relay = new BlindRelay({
      sourceClient: fleet.clientFor('bravo'),
      targetClient: fleet.clientFor('charlie'),
      sourceChannelId: relaySource,
      targetChannelId: relayTarget,
      fleetUserIds: () => fleet.botUserIds(),
      cues: cues ?? undefined,
    });
    try {
      await relay.start();
      console.log(`relay: bridge open${cues !== null ? ' — cues armed' : ''}`);
    } catch (err) {
      console.error(`relay: failed to start — ${err instanceof Error ? err.message : String(err)}`);
      // Do not exit — the fleet is still useful for diagnostics without the relay.
      await relay.stop();
      relay = null;
    }
  } else {
    console.log('relay: not configured (set RELAY_SOURCE_CHANNEL_ID and RELAY_TARGET_CHANNEL_ID to enable)');
  }

  const server = startStatusServer({ port, fleet, sweep, relay, startedAt });

  let exiting = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.log(`\n${signal} — shutting down`);
    server.close();
    if (relay !== null) await relay.stop();
    await fleet.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((err: unknown) => {
  console.error('\nfatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
