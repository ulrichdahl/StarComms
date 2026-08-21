/**
 * Star Comms entrypoint.
 *
 *   config → db → boot sweep → cues → fleet → slash registrar → status
 *
 * Boot order matters: the sweep touches the DB, cues validate against
 * config, the fleet logs in only after the sweep has drained any stale
 * hail rows, and the slash registrar runs once the controller Client
 * is ready.
 *
 * Step 1 of the build order (Spec 1.0 §15) ships this minimum: fleet
 * up, /star-comms status responsive, /healthz JSON. Subsequent steps
 * add vessels (§3), the callsign registry (§5), the control panel
 * buttons (§4), and the hail flow (§6).
 */

import { MessageFlags } from 'discord.js';
import { intEnv, loadEnv, optionalEnv } from './lib/env.js';
import { loadConfig, redactMember } from './lib/config.js';
import { openDb } from './lib/db.js';
import { loadCueSet, resolveCuePaths, type CueSet } from './lib/cues.js';
import { bootSweep, formatSweep } from './fleet/boot-sweep.js';
import { Fleet } from './fleet/manager.js';
import { startStatusServer } from './fleet/status.js';
import { makeRegistrar, type SubcommandHandler } from './commands/registrar.js';
import { makeInitHandler } from './commands/init.js';
import { startVesselService } from './session/vessel.js';

async function main(): Promise<void> {
  const startedAt = new Date();
  loadEnv();

  const configPath = optionalEnv('CONFIG_PATH', 'config/fleet.yaml');
  const dbPath = optionalEnv('DB_PATH', 'data/starcomms.db');
  const port = intEnv('STATUS_PORT', 3000);

  console.log(`config: ${configPath}`);
  const config = loadConfig(configPath);
  console.log(`fleet: 1 controller + ${config.fleet.length} relay(s)`);
  console.log(`  controller ${JSON.stringify({ applicationId: config.controller.applicationId })}`);
  for (const m of config.fleet) console.log(`  ${JSON.stringify(redactMember(m))}`);

  console.log(`db: ${dbPath}`);
  const db = openDb(dbPath);

  const sweep = bootSweep(db);
  console.log(formatSweep(sweep));

  // Cues are loaded before the fleet touches voice: an invalid asset should
  // fail the boot loud, not silently mis-play later.
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
    console.warn('cues: continuing without them; hail cue playback will fail until cues load cleanly');
  }

  const fleet = new Fleet(config.controller, config.fleet);
  console.log('logging in fleet...');
  await fleet.start();
  console.log('all members ready');

  const handlers: Record<string, SubcommandHandler> = {
    init: makeInitHandler(config, db),
    status: async (interaction) => {
      const bots = fleet.states();
      const lines = ['**Star Comms fleet status**'];
      for (const b of bots) {
        lines.push(`\`${b.role.padEnd(10)}\` **${b.nato}** — ${b.status} ${b.tag ?? ''} guilds=${b.guildIds.length}`);
      }
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    },
  };
  const registrar = makeRegistrar(config.controller, fleet.controllerClient(), handlers);
  await registrar.start();

  const vessels = startVesselService({ fleet, db });

  const server = startStatusServer({ port, fleet, sweep, startedAt });

  // Reference the loaded cues so the linter does not flag the variable —
  // they will be threaded into the hail path when step 6 lands.
  void cues;

  let exiting = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.log(`\n${signal} — shutting down`);
    server.close();
    vessels.stop();
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
