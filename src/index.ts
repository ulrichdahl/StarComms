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
import { runReconciliation } from './fleet/reconcile.js';
import { Fleet } from './fleet/manager.js';
import { startStatusServer } from './fleet/status.js';
import { Events } from 'discord.js';
import { makeRegistrar, type SubcommandHandler } from './commands/registrar.js';
import { makeInitHandler } from './commands/init.js';
import {
  makeCallsignHandler, makeRegisterHandler, makeUnregisterHandler,
} from './commands/callsigns.js';
import { makePanelDispatcher } from './commands/panel-handlers.js';
import {
  HAIL_ACCEPT_PREFIX, HAIL_DECLINE_PREFIX, HAIL_END_PREFIX, HailManager,
} from './session/hail.js';
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

  // Post-login reconciliation: with the controller connected we can now
  // ask Discord which of the tracked vessels still exist and drop rows
  // for those that don't. Runs once at boot and then every 5 minutes
  // as a safety net — if a live voiceStateUpdate is missed (bot
  // disconnected briefly, event lost, race with a crash), the periodic
  // pass eventually catches the orphan.
  const reconcileOnce = async (): Promise<void> => {
    try {
      const result = await runReconciliation(db, fleet.controllerClient());
      console.log(
        `reconcile: checked ${result.vesselsChecked} vessel(s), ` +
        `dropped ${result.vesselsMissing} gone, ` +
        `deleted ${result.vesselsDeletedEmpty} orphan empty`,
      );
    } catch (err) {
      console.warn(`reconcile: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await reconcileOnce();
  const reconcileInterval = setInterval(() => { void reconcileOnce(); }, 5 * 60_000);

  const handlers: Record<string, SubcommandHandler> = {
    init: makeInitHandler(config, db),
    register: makeRegisterHandler(db),
    unregister: makeUnregisterHandler(db),
    callsign: makeCallsignHandler(db),
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

  // Hail service. Requires cues; if cues never loaded, we surface a
  // hail-service-disabled state so a Hail click fails cleanly rather
  // than crashing at cue-lookup time.
  const hails = cues !== null
    ? new HailManager({
        db, fleet, cues,
        silenceCloseMs: config.defaults.hailSilenceCloseMs,
        maxHoldMs: config.defaults.hailMaxHoldMs,
        ringIntervalMs: config.defaults.ringIntervalMs,
        ringMaxMs: config.defaults.ringMaxMs,
      })
    : null;
  if (hails === null) {
    console.warn('hail: service disabled — cues did not load');
  }

  // Component + modal routing. `sc:panel:` and `sc:hail:` prefixes are
  // routed here; everything else falls through to the slash registrar's
  // own listener.
  const dispatchPanel = hails !== null ? makePanelDispatcher({ db, fleet, hails }) : null;
  fleet.controllerClient().on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) return;
    if (!('customId' in interaction) || typeof interaction.customId !== 'string') return;
    const id = interaction.customId;
    if (id.startsWith('sc:panel:')) {
      if (dispatchPanel !== null) {
        void dispatchPanel(interaction as Parameters<typeof dispatchPanel>[0]);
      }
      return;
    }
    if (id.startsWith(HAIL_END_PREFIX) && interaction.isButton()) {
      const hailId = Number(id.slice(HAIL_END_PREFIX.length));
      if (Number.isFinite(hailId) && hails !== null) {
        void interaction.deferUpdate().catch(() => {});
        void hails.handleEndButton(hailId, interaction.user.id).catch((err) => {
          console.error(`hail end button: ${err instanceof Error ? err.message : err}`);
        });
      }
      return;
    }
    if ((id.startsWith(HAIL_ACCEPT_PREFIX) || id.startsWith(HAIL_DECLINE_PREFIX))
        && interaction.isButton()) {
      if (hails === null) return;
      const accept = id.startsWith(HAIL_ACCEPT_PREFIX);
      const prefix = accept ? HAIL_ACCEPT_PREFIX : HAIL_DECLINE_PREFIX;
      const hailId = Number(id.slice(prefix.length));
      if (!Number.isFinite(hailId)) return;
      const status = hails.handleAcceptDecline(
        hailId, accept ? 'accepted' : 'declined', interaction.user.id,
      );
      if (status === 'not_owner') {
        void interaction.reply({
          content: 'Only the vessel owner can respond to this hail.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      } else if (status === 'not_ringing') {
        void interaction.reply({
          content: 'This hail is no longer waiting for a response.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      } else {
        void interaction.deferUpdate().catch(() => {});
      }
      return;
    }
  });

  const vessels = startVesselService({ fleet, db, hails });

  const server = startStatusServer({ port, fleet, sweep, startedAt });

  let exiting = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.log(`\n${signal} — shutting down`);
    clearInterval(reconcileInterval);
    server.close();
    vessels.stop();
    if (hails !== null) await hails.drain();
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
