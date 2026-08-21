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
import { closeSession, detectionFor, openSession, SessionError } from './session/lifecycle.js';
import type { SessionMode } from './session/model.js';
import { connectionFor, runSessionRelay } from './session/relay.js';
import { FakeDriver, WhisperLocalDriver, type SttDriver } from './detection/stt.js';

async function main(): Promise<void> {
  const startedAt = new Date();
  loadEnv();

  const configPath = optionalEnv('CONFIG_PATH', 'config/fleet.yaml');
  const dbPath = optionalEnv('DB_PATH', 'data/starbridge.db');
  const port = intEnv('STATUS_PORT', 3000);
  const relaySource = optionalEnv('RELAY_SOURCE_CHANNEL_ID', '');
  const relayTarget = optionalEnv('RELAY_TARGET_CHANNEL_ID', '');
  const relayEnabled = relaySource !== '' && relayTarget !== '';
  const sttDriverName = optionalEnv('STT_DRIVER', 'fake');
  const sttFakeResponse = optionalEnv('STT_FAKE_RESPONSE', 'command alpha');
  const sttUrl = optionalEnv('STT_URL', 'http://stt:8000/v1');
  const sttModel = optionalEnv('STT_MODEL', '');
  const sttLanguage = optionalEnv('STT_LANGUAGE', '');

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

  // STT driver — v1 default is fake so the fleet always boots even without
  // a Whisper container. whisper_local talks to a Speaches sidecar over
  // HTTP; if the sidecar is not reachable at boot we log a warning and
  // fall back to fake, so a misconfigured STT never blocks the fleet from
  // coming up and running /star-bridge open + hail.
  let stt: SttDriver | null = null;
  if (sttDriverName === 'whisper_local') {
    const whisper = new WhisperLocalDriver({
      url: sttUrl,
      ...(sttModel !== '' ? { model: sttModel } : {}),
      ...(sttLanguage !== '' ? { language: sttLanguage } : {}),
    });
    const ok = await whisper.ready();
    if (ok) {
      stt = whisper;
      console.log(`stt: driver=whisper_local url=${sttUrl}${sttModel !== '' ? ` model=${sttModel}` : ''}${sttLanguage !== '' ? ` language=${sttLanguage}` : ''}`);
    } else {
      console.warn(`stt: driver=whisper_local unreachable at ${sttUrl} — falling back to fake`);
      stt = new FakeDriver(sttFakeResponse);
    }
  } else if (sttDriverName === 'fake') {
    stt = new FakeDriver(sttFakeResponse);
    console.log(`stt: driver=fake canned="${sttFakeResponse}"`);
  } else {
    console.warn(`stt: driver=${sttDriverName} is not yet wired; detection will be silent`);
  }

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
      const squads = interaction.options.getInteger('squads', true);
      try {
        const result = await openSession({
          guild, ownerId: interaction.user.id, mode, squads, fleet, db,
          stt: stt ?? undefined,
          onDetection: (d) => {
            console.log(
              `detection: [${d.userId}] "${d.transcript.text}" ` +
              `(${d.transcript.durationMs.toFixed(0)} ms, peak=${(20 * Math.log10(d.peakRms || 1e-6)).toFixed(1)} dBFS)`,
            );
          },
        });
        const netLines = result.nets.map(
          (n) => `• ${n.callsign} — <#${n.channelId}> (bot: ${n.botKey})`,
        );
        const primary = result.nets[0]?.callsign ?? 'the primary net';
        const moveLine = result.moveOwner.moved
          ? `You have been moved into ${primary}.`
          : `⚠ Not moved into ${primary}: ${result.moveOwner.reason}`;
        const body = [
          `**Session ${result.sessionId} open** — mode \`${result.mode}\`, primary + ${squads} squad(s), ${result.nets.length} net(s) total`,
          ...netLines,
          '',
          moveLine,
          `Use \`/star-bridge close\` to end the session.`,
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
    hail: async (interaction) => {
      const guild = interaction.guild;
      if (guild === null) {
        await interaction.reply({ content: 'this command must be used in a guild', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (cues === null) {
        await interaction.editReply('hail failed: cue engine is not loaded');
        return;
      }
      const targetCallsign = interaction.options.getString('target', true).trim();

      const session = db.prepare(
        `SELECT id, lead_user_id FROM sessions WHERE guild_id = ? AND ended_at IS NULL`,
      ).get(guild.id) as { id: number; lead_user_id: string } | undefined;
      if (session === undefined) {
        await interaction.editReply('hail failed: no session is open in this guild — run /star-bridge open first.');
        return;
      }

      const netRows = db.prepare(
        `SELECT nato, bot_id FROM session_nets WHERE session_id = ?`,
      ).all(session.id) as { nato: string; bot_id: string }[];
      // Find the primary (bot_id === 'main') and the target by callsign
      // (nato slug = lowercased-callsign-with-dashes, as inserted by
      // openSession).
      const primary = netRows.find((r) => r.bot_id === 'main');
      const targetSlug = targetCallsign.toLowerCase().replace(/\s+/g, '-');
      const target = netRows.find((r) => r.nato === targetSlug);
      if (primary === undefined) {
        await interaction.editReply('hail failed: no primary net in the current session');
        return;
      }
      if (target === undefined) {
        const avail = netRows.filter((r) => r.bot_id !== 'main').map((r) => r.nato).join(', ');
        await interaction.editReply(`hail failed: unknown target \`${targetCallsign}\`. Available: ${avail}`);
        return;
      }
      if (target.bot_id === primary.bot_id) {
        await interaction.editReply('hail failed: primary net cannot be its own target');
        return;
      }

      const mainClient = fleet.controllerClient();
      const targetClient = fleet.clientFor(target.bot_id);
      const mainUserId = mainClient.user?.id;
      const targetUserId = targetClient.user?.id;
      if (mainUserId === undefined || targetUserId === undefined) {
        await interaction.editReply('hail failed: fleet not fully ready');
        return;
      }

      const sourceConn = connectionFor(guild.id, mainUserId);
      const targetConn = connectionFor(guild.id, targetUserId);
      if (sourceConn === null || targetConn === null) {
        await interaction.editReply('hail failed: session voice connections are not both live');
        return;
      }

      const gRow = db.prepare(
        `SELECT silence_close_ms, max_hold_ms FROM guilds WHERE id = ?`,
      ).get(guild.id) as { silence_close_ms: number; max_hold_ms: number } | undefined;
      const silenceCloseMs = gRow?.silence_close_ms ?? config.defaults.silenceCloseMs;
      const maxHoldMs = gRow?.max_hold_ms ?? config.defaults.maxHoldMs;

      await interaction.editReply(
        `**Opening hail** → \`${targetCallsign}\`\n` +
        `Cues play now; then speak in the primary. Route closes on ${silenceCloseMs} ms silence or ${maxHoldMs} ms max-hold.`,
      );

      // Detection and hail both need receiver.subscribe(commanderId) on the
      // same connection. `@discordjs/voice` returns the same underlying
      // AudioReceiveStream on repeat subscribes, and two consumers on that
      // one stream fight for flowing-mode 'data' events. Pausing detection
      // destroys the in-flight subscription so the hail gets a fresh stream.
      const detection = detectionFor(guild.id);
      detection?.pause();
      let result: Awaited<ReturnType<typeof runSessionRelay>>;
      try {
        result = await runSessionRelay({
          sourceConnection: sourceConn,
          targetConnection: targetConn,
          cues,
          commanderUserId: interaction.user.id,
          silenceCloseMs,
          maxHoldMs,
        });
      } finally {
        detection?.resume();
      }

      const summary = result.errorMessage !== null
        ? `hail closed with error: ${result.errorMessage} (packets=${result.opusPackets})`
        : `hail closed — ${result.closedBy} · ${result.opusPackets} opus packets · ${result.durationMs} ms`;
      await interaction.followUp({ content: summary, flags: MessageFlags.Ephemeral });
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
