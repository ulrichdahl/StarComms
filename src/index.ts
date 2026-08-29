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
import { loadConfig, redactMember, type Locale } from './lib/config.js';
import { stringsFor, type Strings } from './lib/i18n.js';
import { ownVersion } from './lib/pkg.js';
import { openDb } from './lib/db.js';
import { loadCueLibrary, type CueLibrary } from './lib/cues.js';
import { bootSweep, formatSweep } from './fleet/boot-sweep.js';
import { runReconciliation } from './fleet/reconcile.js';
import { Fleet } from './fleet/manager.js';
import { startStatusServer } from './fleet/status.js';
import { Events } from 'discord.js';
import { makeRegistrar, type SubcommandHandler } from './commands/registrar.js';
import { makeWatchChannelHandler } from './commands/watch-channel.js';
import { makeSetLanguageHandler } from './commands/set-language.js';
import { SUBCOMMANDS } from './commands/star-comms.js';
import { getGuildLocale } from './session/guild-row.js';
import { refreshAllPanels, refreshGuildPanels, refreshOwnerPanels } from './session/panel-refresh.js';
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

  console.log(`star-comms v${ownVersion()}`);
  console.log(`config: ${configPath}`);
  const config = loadConfig(configPath);
  console.log(`fleet: 1 controller + ${config.fleet.length} relay(s)`);
  console.log(`  controller ${JSON.stringify({ applicationId: config.controller.applicationId })}`);
  for (const m of config.fleet) console.log(`  ${JSON.stringify(redactMember(m))}`);

  console.log(`db: ${dbPath}`);
  const db = openDb(dbPath);

  const sweep = bootSweep(db);
  console.log(formatSweep(sweep));

  // Language is per guild (`/star-comms set-language`); every reply,
  // button label and cue lookup resolves through these two closures.
  const localeFor = (guildId: string): Locale => getGuildLocale(db, guildId, config.defaults.locale);
  const strings = (guildId: string): Strings => stringsFor(localeFor(guildId));

  // Cues are loaded before the fleet touches voice: an invalid asset should
  // fail the boot loud, not silently mis-play later. Every locale with a
  // cue block loads; the default locale is mandatory, the rest degrade to
  // it (with a warning) so a guild can pick a language before its WAVs
  // are installed.
  let cues: CueLibrary | null = null;
  try {
    cues = await loadCueLibrary(
      config.raw, config.defaults.cueSet, config.defaults.locale, configPath,
      (locale, reason) => console.warn(`cues: ${locale} skipped — ${reason}; falls back to ${config.defaults.locale}`),
    );
    for (const locale of cues.loadedLocales()) {
      const set = cues.forLocale(locale);
      console.log(`cues[${locale}]: loaded ${set.summary().length} assets`);
      for (const c of set.summary()) {
        console.log(`  ${c.name.padEnd(12)} ${String(c.durationMs).padStart(5)} ms  ${c.packets} packets  ${c.path}`);
      }
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
  // for those that don't. Runs:
  //   • once immediately after fleet.start() (boot pass),
  //   • every 5 minutes as a safety net,
  //   • on ShardResume / ShardReady of the controller — a PC suspend/
  //     wake, a network flap, or any missed voice-state event during
  //     the disconnect can leave stale rows; a reconnect is the right
  //     moment to reconcile against Discord's live state.
  const reconcileOnce = async (reason: string): Promise<void> => {
    try {
      const result = await runReconciliation(db, fleet.controllerClient());
      console.log(
        `reconcile[${reason}]: checked ${result.vesselsChecked} vessel(s), ` +
        `dropped ${result.vesselsMissing} gone, ` +
        `deleted ${result.vesselsDeletedEmpty} orphan empty`,
      );
    } catch (err) {
      console.warn(`reconcile[${reason}]: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await reconcileOnce('boot');

  // Re-render every live control panel so panels posted by the previous
  // version pick up this version's layout, labels and button set on
  // deploy rather than on the next click.
  try {
    const r = await refreshAllPanels(db, fleet.controllerClient(), strings);
    console.log(`panels[boot]: updated=${r.updated} skipped=${r.skipped}`);
  } catch (err) {
    console.warn(`panels[boot]: refresh failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  const reconcileInterval = setInterval(() => { void reconcileOnce('periodic'); }, 5 * 60_000);

  // Reconcile after a shard resume/reconnect. Delay by 3 s so
  // discord.js has time to replay VOICE_STATE_UPDATE events (RESUME)
  // or receive GUILD_CREATE with fresh voice_states (fresh IDENTIFY)
  // and the cache reflects reality before we probe it.
  const controllerClient = fleet.controllerClient();
  const onControllerReconnected = (label: string): void => {
    setTimeout(() => { void reconcileOnce(label); }, 3_000);
  };
  controllerClient.on(Events.ShardResume, () => onControllerReconnected('resume'));
  controllerClient.on(Events.ShardReady, () => onControllerReconnected('shard-ready'));

  // `set-language` re-registers the guild's slash commands so their
  // descriptions follow the new language, and re-renders every live
  // control panel in the guild; the registrar is created after the
  // handler map, hence the late binding.
  let registrar: ReturnType<typeof makeRegistrar> | null = null;
  // A member registering or removing a callsign changes what their own
  // vessel panels should offer (Allow hails, callsign hint, directory
  // state) — re-render those panels in place.
  const onCallsignChanged = async (guildId: string, userId: string): Promise<void> => {
    const r = await refreshOwnerPanels(db, fleet.controllerClient(), guildId, userId, strings(guildId));
    if (r.updated + r.skipped > 0) {
      console.log(`callsigns: ${userId} in ${guildId}; panels updated=${r.updated} skipped=${r.skipped}`);
    }
  };
  const handlers: Record<string, SubcommandHandler> = {
    [SUBCOMMANDS.watchChannel]: makeWatchChannelHandler(config, db, strings),
    [SUBCOMMANDS.setLanguage]: makeSetLanguageHandler({
      config, db, strings, cues,
      onChanged: async (guildId, locale) => {
        const panels = await refreshGuildPanels(db, fleet.controllerClient(), guildId, stringsFor(locale));
        console.log(`set-language: ${guildId} → ${locale}; panels updated=${panels.updated} skipped=${panels.skipped}`);
        await registrar?.reregister(guildId);
      },
    }),
    [SUBCOMMANDS.register]: makeRegisterHandler(db, strings, onCallsignChanged),
    [SUBCOMMANDS.unregister]: makeUnregisterHandler(db, strings, onCallsignChanged),
    [SUBCOMMANDS.callsign]: makeCallsignHandler(db, strings),
    [SUBCOMMANDS.status]: async (interaction) => {
      const bots = fleet.states();
      const lines = [`${strings(interaction.guildId ?? '').status.title} · v${ownVersion()}`];
      for (const b of bots) {
        lines.push(`\`${b.role.padEnd(10)}\` **${b.nato}** — ${b.status} ${b.tag ?? ''} guilds=${b.guildIds.length}`);
      }
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    },
  };
  registrar = makeRegistrar(config.controller, fleet.controllerClient(), handlers, localeFor);
  await registrar.start();

  // Hail service. Requires cues; if cues never loaded, we surface a
  // hail-service-disabled state so a Hail click fails cleanly rather
  // than crashing at cue-lookup time.
  const hails = cues !== null
    ? new HailManager({
        db, fleet, cues, localeFor,
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
  const dispatchPanel = hails !== null ? makePanelDispatcher({ db, fleet, hails, strings }) : null;
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
      const s = strings(interaction.guildId ?? '');
      if (status === 'not_owner') {
        void interaction.reply({ content: s.hail.onlyOwnerResponds, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else if (status === 'not_ringing') {
        void interaction.reply({ content: s.hail.notRinging, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        void interaction.deferUpdate().catch(() => {});
      }
      return;
    }
  });

  const vessels = startVesselService({ fleet, db, hails, strings });

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
