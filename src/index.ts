/**
 * Star Bridge entrypoint — step 2 of the build order (spec §16).
 *
 * config → db → boot sweep → fleet → status
 *
 * The order matters. The boot sweep must run before the fleet connects: an
 * open relay left by a crash needs to be recovered, and touching Discord
 * before then would double-serve the same net (spec §11).
 */

import { intEnv, loadEnv, optionalEnv } from './lib/env.js';
import { loadConfig, redactMember } from './lib/config.js';
import { openDb } from './lib/db.js';
import { bootSweep, formatSweep } from './fleet/boot-sweep.js';
import { Fleet } from './fleet/manager.js';
import { startStatusServer } from './fleet/status.js';

async function main(): Promise<void> {
  const startedAt = new Date();
  loadEnv();

  const configPath = optionalEnv('CONFIG_PATH', 'config/fleet.yaml');
  const dbPath = optionalEnv('DB_PATH', 'data/starbridge.db');
  const port = intEnv('STATUS_PORT', 3000);

  console.log(`config: ${configPath}`);
  const config = loadConfig(configPath);
  console.log(`fleet: ${config.fleet.length} member(s)`);
  for (const m of config.fleet) console.log(`  ${JSON.stringify(redactMember(m))}`);

  console.log(`db: ${dbPath}`);
  const db = openDb(dbPath);

  const sweep = bootSweep(db);
  console.log(formatSweep(sweep));

  const fleet = new Fleet(config.fleet);
  console.log('logging in fleet...');
  await fleet.start();
  console.log('all members ready');

  const server = startStatusServer({ port, fleet, sweep, startedAt });

  let exiting = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.log(`\n${signal} — shutting down`);
    server.close();
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
