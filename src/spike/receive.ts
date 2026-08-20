/**
 * Star Bridge — step 1 receive spike (spec §16.1).
 *
 * Single purpose: prove that this bot can obtain DECRYPTED, PER-SPEAKER PCM
 * from a real guild voice channel under Discord's mandatory DAVE end-to-end
 * encryption. Everything else in the project is downstream of this working,
 * so nothing else is built until it prints PASS.
 *
 * Failure signature to watch for (spec §15): @discordjs/voice 0.19.0–0.19.1
 * connect and can transmit, but never decrypt inbound audio — speaking events
 * fire and zero PCM arrives, with `DecryptionFailed(UnencryptedWhenPassthrough
 * Disabled)` in the debug stream. Fixed in 0.19.2. This spike distinguishes
 * that case from "nobody spoke" and says so.
 *
 * No audio is written to disk, here or anywhere else in the project (§1).
 */

import { createServer, type Server } from 'node:http';
import { Client, Events, GatewayIntentBits, ChannelType } from 'discord.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { dbfs, meter, rms } from '../lib/audio.js';
import { intEnv, floatEnv, loadEnv, requireEnv } from '../lib/env.js';
import { atLeast, packageVersion } from '../lib/pkg.js';

/** The first version of @discordjs/voice that can decrypt received audio. */
const MIN_VOICE_VERSION = { major: 0, minor: 19, patch: 2 };

interface SpikeConfig {
  token: string;
  guildId: string;
  channelId: string;
  runSeconds: number;
  port: number;
  minPackets: number;
  minRms: number;
}

/** Read after loadEnv(), inside main(), so a missing variable is reported as a
 *  one-line error rather than a module-scope stack trace. */
function readConfig(): SpikeConfig {
  loadEnv();
  return {
    token: requireEnv('SPIKE_TOKEN'),
    guildId: requireEnv('SPIKE_GUILD_ID'),
    channelId: requireEnv('SPIKE_CHANNEL_ID'),
    runSeconds: intEnv('SPIKE_RUN_SECONDS', 0),
    port: intEnv('SPIKE_PORT', 3000),
    minPackets: intEnv('SPIKE_MIN_PACKETS', 25),
    minRms: floatEnv('SPIKE_MIN_RMS', 0.005),
  };
}

let cfg: SpikeConfig;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface SpeakerStat {
  userId: string;
  label: string;
  isBot: boolean;
  segments: number;
  opusPackets: number;
  pcmBytes: number;
  peakRms: number;
  lastRms: number;
  firstAt: number | null;
  lastAt: number | null;
}

const speakers = new Map<string, SpeakerStat>();
const subscribed = new Set<string>();
const diagnostics: string[] = [];
let decryptionFailureSeen = false;
let speakingEventsSeen = 0;
let reconnects = 0;
let connectionState = 'init';

function note(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  diagnostics.push(stamped);
  if (diagnostics.length > 200) diagnostics.shift();
}

function stat(userId: string, label: string, isBot: boolean): SpeakerStat {
  let s = speakers.get(userId);
  if (s === undefined) {
    s = {
      userId, label, isBot,
      segments: 0, opusPackets: 0, pcmBytes: 0,
      peakRms: 0, lastRms: 0, firstAt: null, lastAt: null,
    };
    speakers.set(userId, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

function verdict(): { result: Verdict; reason: string } {
  const humans = [...speakers.values()].filter((s) => !s.isBot);
  const proof = humans.filter(
    (s) => s.opusPackets >= cfg.minPackets && s.pcmBytes > 0 && s.peakRms >= cfg.minRms,
  );

  if (proof.length > 0) {
    return {
      result: 'PASS',
      reason: `${proof.length} speaker(s) produced decoded PCM above the noise floor`,
    };
  }
  if (speakingEventsSeen > 0 && humans.every((s) => s.pcmBytes === 0)) {
    return {
      result: 'FAIL',
      reason: decryptionFailureSeen
        ? 'speaking events fired, zero PCM decoded, decryption failure in the debug stream'
        : 'speaking events fired but zero PCM decoded',
    };
  }
  if (speakingEventsSeen === 0) {
    return { result: 'INCONCLUSIVE', reason: 'no speaking events — nobody transmitted' };
  }
  return {
    result: 'INCONCLUSIVE',
    reason: `PCM arrived but below thresholds (need >=${cfg.minPackets} packets and RMS >=${cfg.minRms})`,
  };
}

// ---------------------------------------------------------------------------
// receive
// ---------------------------------------------------------------------------

function attachReceiver(connection: VoiceConnection, client: Client): void {
  const receiver = connection.receiver;

  receiver.speaking.on('start', (userId: string) => {
    speakingEventsSeen++;
    if (subscribed.has(userId)) return;
    subscribed.add(userId);

    void (async () => {
      let label = userId;
      let isBot = false;
      try {
        const user = await client.users.fetch(userId);
        label = user.tag;
        isBot = user.bot;
      } catch {
        note(`could not resolve user ${userId}`);
      }

      const s = stat(userId, label, isBot);
      s.segments++;
      if (s.firstAt === null) s.firstAt = Date.now();

      // Fleet audio is suppressed before detection in the real router (§5).
      // The spike still meters it, so you can see what the loop would hear.
      const tag = isBot ? 'BOT (would be suppressed)' : 'user';
      console.log(`  + speaking: ${label} [${tag}]`);

      const opus = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });

      opus.on('data', () => { s.opusPackets++; });
      opus.on('error', (err: Error) => note(`opus stream error for ${label}: ${err.message}`));

      decoder.on('data', (chunk: Buffer) => {
        const level = rms(chunk);
        s.pcmBytes += chunk.length;
        s.lastRms = level;
        if (level > s.peakRms) s.peakRms = level;
        s.lastAt = Date.now();
      });
      decoder.on('error', (err: Error) => note(`decoder error for ${label}: ${err.message}`));

      const release = (): void => {
        subscribed.delete(userId);
        decoder.destroy();
      };
      opus.on('end', release);
      opus.on('close', release);

      opus.pipe(decoder);
    })();
  });

  receiver.speaking.on('end', (userId: string) => {
    const s = speakers.get(userId);
    console.log(`  - silent:   ${s?.label ?? userId}`);
  });
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function snapshot(): void {
  if (speakers.size === 0) {
    console.log(`[${connectionState}] waiting for someone to transmit...`);
    return;
  }
  console.log(`[${connectionState}] speakers=${speakers.size} reconnects=${reconnects}`);
  for (const s of speakers.values()) {
    const kind = s.isBot ? 'bot ' : 'user';
    const audible = s.pcmBytes > 0 ? meter(s.peakRms) : 'NO PCM DECODED    ';
    console.log(
      `  ${kind} ${s.label.padEnd(24)} pkts=${String(s.opusPackets).padStart(6)}` +
      ` pcm=${String(Math.round(s.pcmBytes / 1024)).padStart(6)}KiB` +
      ` peak=${dbfs(s.peakRms).toFixed(1).padStart(6)}dBFS  ${audible}`,
    );
  }
}

function report(): Verdict {
  const v = verdict();
  const line = '='.repeat(72);
  console.log(`\n${line}`);
  console.log(`  VERDICT: ${v.result} — ${v.reason}`);
  console.log(line);

  for (const s of speakers.values()) {
    console.log(
      `  ${s.isBot ? 'bot ' : 'user'} ${s.label}\n` +
      `       segments=${s.segments} opusPackets=${s.opusPackets}` +
      ` pcmBytes=${s.pcmBytes} peak=${dbfs(s.peakRms).toFixed(1)}dBFS`,
    );
  }

  if (v.result === 'FAIL') {
    console.log('\n  Remediation, in order:');
    console.log('   1. Confirm @discordjs/voice >= 0.19.2   (npm ls @discordjs/voice)');
    console.log('   2. Confirm @snazzah/davey is installed  (npm ls @snazzah/davey)');
    console.log('   3. Check the host clock — DAVE key exchange is intolerant of skew');
    console.log('   4. Re-read spec §15; the receive path is community-maintained');
  }
  if (v.result === 'INCONCLUSIVE' && speakingEventsSeen === 0) {
    console.log('\n  Nobody spoke. Join the channel, say something, run it again.');
  }
  if (decryptionFailureSeen) {
    console.log('\n  Decryption failures were logged. Last diagnostics:');
    for (const d of diagnostics.slice(-12)) console.log(`   ${d}`);
  }
  console.log('');
  return v.result;
}

// ---------------------------------------------------------------------------
// health endpoint — internal only, never published from the container
// ---------------------------------------------------------------------------

function startHealthServer(): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const v = verdict();
    const body = {
      connectionState,
      verdict: v.result,
      reason: v.reason,
      speakingEventsSeen,
      reconnects,
      decryptionFailureSeen,
      speakers: [...speakers.values()].map((s) => ({
        label: s.label,
        isBot: s.isBot,
        segments: s.segments,
        opusPackets: s.opusPackets,
        pcmBytes: s.pcmBytes,
        peakDbfs: Number(dbfs(s.peakRms).toFixed(1)),
      })),
      diagnostics: diagnostics.slice(-20),
    };
    const payload = JSON.stringify(body, null, 2);
    // Connected and receiving, or connected and idle, are both healthy.
    res.writeHead(v.result === 'FAIL' ? 503 : 200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  server.listen(cfg.port, '0.0.0.0', () =>
    console.log(`health: http://localhost:${cfg.port}/healthz`));
  return server;
}

// ---------------------------------------------------------------------------
// version assertion
// ---------------------------------------------------------------------------

function assertVoiceVersion(): void {
  const required = `${MIN_VOICE_VERSION.major}.${MIN_VOICE_VERSION.minor}.${MIN_VOICE_VERSION.patch}`;
  const version = packageVersion('@discordjs/voice');
  const davey = packageVersion('@snazzah/davey');

  if (version === null) {
    console.error(
      `\nfatal: could not determine the installed @discordjs/voice version.\n` +
      `       Refusing to run — a version below ${required} cannot decrypt received\n` +
      `       audio at all, and a false PASS here would be worse than no result.\n` +
      `       Run \`npm ls @discordjs/voice\` and check the install.\n`,
    );
    process.exit(1);
  }

  const ok = atLeast(version, MIN_VOICE_VERSION);
  console.log(`@discordjs/voice ${version} ${ok ? '(ok)' : '(TOO OLD)'}`);
  console.log(`@snazzah/davey   ${davey ?? 'NOT INSTALLED'}${davey === null ? ' — DAVE unavailable' : ''}`);

  if (!ok) {
    console.error(
      `\nfatal: @discordjs/voice ${version} cannot decrypt received audio under DAVE.\n` +
      `       0.19.0 and 0.19.1 fail with\n` +
      `       DecryptionFailed(UnencryptedWhenPassthroughDisabled).\n` +
      `       Install >= ${required} and re-run. See spec §15.\n`,
    );
    process.exit(1);
  }
  if (davey === null) {
    console.error(
      `\nfatal: @snazzah/davey is not installed, so DAVE cannot be negotiated.\n` +
      `       It is a direct dependency of @discordjs/voice — reinstall.\n`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  cfg = readConfig();
  assertVoiceVersion();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.on(Events.Error, (err) => note(`client error: ${err.message}`));
  client.on(Events.Warn, (msg) => note(`client warn: ${msg}`));

  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(cfg.token);
  await ready;
  console.log(`logged in as ${client.user?.tag}`);

  const guild = await client.guilds.fetch(cfg.guildId);
  const channel = await guild.channels.fetch(cfg.channelId);
  if (channel === null || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`channel ${cfg.channelId} is not a guild voice channel`);
  }
  console.log(`joining "${channel.name}" in "${guild.name}"`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must receive
    selfMute: true,  // the spike never transmits
  });

  connection.on('debug', (msg: string) => {
    if (/dave|decrypt|encryption|crypto/i.test(msg)) note(`voice: ${msg}`);
    if (/DecryptionFailed|UnencryptedWhenPassthroughDisabled/i.test(msg)) {
      decryptionFailureSeen = true;
      console.error(`  !! ${msg}`);
    }
  });
  connection.on('error', (err: Error) => {
    note(`voice error: ${err.message}`);
    if (/decrypt/i.test(err.message)) decryptionFailureSeen = true;
  });
  connection.on('stateChange', (from, to) => {
    connectionState = to.status;
    note(`voice state ${from.status} -> ${to.status}`);
    if (to.status === VoiceConnectionStatus.Disconnected) reconnects++;
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  connectionState = VoiceConnectionStatus.Ready;
  console.log('voice connection ready — talk in the channel now\n');

  attachReceiver(connection, client);
  const server = startHealthServer();
  const ticker = setInterval(snapshot, 3_000);

  let exiting = false;
  const shutdown = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    console.log(`\n${signal} — shutting down`);
    clearInterval(ticker);
    server.close();
    connection.destroy();
    const result = report();
    void client.destroy().finally(() => {
      process.exit(result === 'PASS' ? 0 : result === 'FAIL' ? 1 : 2);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (cfg.runSeconds > 0) {
    console.log(`auto-exit in ${cfg.runSeconds}s\n`);
    setTimeout(() => shutdown('timeout'), cfg.runSeconds * 1000);
  }
}

main().catch((err: unknown) => {
  console.error('\nfatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
