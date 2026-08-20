/**
 * Star Bridge entrypoint — steps 2 and 3 of the build order (spec §16).
 *
 * config → db → boot sweep → fleet → optional blind relay → status
 *
 * The order matters. The boot sweep must run before the fleet connects: an
 * open relay left by a crash needs to be recovered, and touching Discord
 * before then would double-serve the same net (spec §11).
 *
 * The blind relay is skipped when its two channel ids are unset — step 2's
 * healthz path continues to work without step 3 wiring, which keeps the
 * fleet manager useful on its own for diagnosing gateway problems.
 */

import { intEnv, loadEnv, optionalEnv } from './lib/env.js';
import { loadConfig, redactMember } from './lib/config.js';
import { openDb } from './lib/db.js';
import { loadCueSet, resolveCuePaths, type CueSet } from './lib/cues.js';
import { bootSweep, formatSweep } from './fleet/boot-sweep.js';
import { Fleet } from './fleet/manager.js';
import { startStatusServer } from './fleet/status.js';
import { BlindRelay } from './relay/blind.js';

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

  const fleet = new Fleet(config.fleet);
  console.log('logging in fleet...');
  await fleet.start();
  console.log('all members ready');

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
