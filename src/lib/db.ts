/**
 * SQLite database — schema per Spec 1.0 §10.
 *
 * Star Comms owns per-guild config, member callsigns, vessels created via
 * join-to-create, the hail directory, and an audit trail of every hail.
 * No audio is ever persisted; every table here is text-only.
 *
 * WAL is set on every open because a stale journal_mode would silently
 * fall back to rollback journalling with worse crash behaviour under
 * concurrent audit writes.
 *
 * The DROP TABLE IF EXISTS list at the top is a one-time cleanup of tables
 * left behind by earlier development iterations that no longer serve the
 * design. On a fresh install these are no-ops. On an existing install they
 * clear stale rows before the CREATE TABLE statements set the current
 * schema up.
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
-- clean-slate: drop tables from earlier iterations that do not survive to v1
DROP TABLE IF EXISTS guild_bots;
DROP TABLE IF EXISTS channel_pool;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS session_nets;
DROP TABLE IF EXISTS relays;
DROP TABLE IF EXISTS relay_targets;
DROP TABLE IF EXISTS acks;
DROP TABLE IF EXISTS alias_variants;
DROP TABLE IF EXISTS misses;
DROP TABLE IF EXISTS mute_state;
DROP TABLE IF EXISTS usage_daily;

-- per-guild config
CREATE TABLE IF NOT EXISTS guilds (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  added_at                    INTEGER NOT NULL,
  added_by                    TEXT NOT NULL,
  join_to_create_channel_id   TEXT,
  locale                      TEXT NOT NULL,
  cue_set                     TEXT NOT NULL,
  cue_duration_ms             INTEGER NOT NULL,
  ring_interval_ms            INTEGER NOT NULL,
  ring_max_ms                 INTEGER NOT NULL,
  hail_silence_close_ms       INTEGER NOT NULL,
  hail_max_hold_ms            INTEGER NOT NULL,
  status                      TEXT NOT NULL           -- active | drained | suspended
);

-- fleet identity
CREATE TABLE IF NOT EXISTS bots (
  id                   TEXT PRIMARY KEY,
  application_id       TEXT NOT NULL UNIQUE,
  token_ref            TEXT NOT NULL,
  kind                 TEXT NOT NULL,                 -- controller | relay
  invite_permissions   TEXT
);

-- per-member callsigns, one row per (guild, user)
CREATE TABLE IF NOT EXISTS callsigns (
  guild_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  callsign       TEXT NOT NULL,
  registered_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  UNIQUE (guild_id, callsign)
);

-- vessels — voice channels created via join-to-create
CREATE TABLE IF NOT EXISTS vessels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT NOT NULL,
  channel_id     TEXT NOT NULL UNIQUE,
  owner_user_id  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  locked         INTEGER NOT NULL DEFAULT 0,
  user_limit     INTEGER NOT NULL DEFAULT 0
);

-- hail directory: vessels currently accepting incoming hails
CREATE TABLE IF NOT EXISTS hail_registry (
  channel_id     TEXT PRIMARY KEY,
  guild_id       TEXT NOT NULL,
  callsign       TEXT NOT NULL,
  registered_at  INTEGER NOT NULL
);

-- live and closed hails
CREATE TABLE IF NOT EXISTS active_hails (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id              TEXT NOT NULL,
  initiator_channel_id  TEXT NOT NULL,
  opened_at             INTEGER NOT NULL,
  closed_at             INTEGER,
  close_reason          TEXT,                        -- silence | button | initiator_left |
                                                    -- all_declined | drain
  peak_bots             INTEGER
);
CREATE TABLE IF NOT EXISTS hail_participants (
  hail_id      INTEGER NOT NULL,
  channel_id   TEXT NOT NULL,
  bot_id       TEXT NOT NULL,
  joined_at    INTEGER NOT NULL,
  left_at      INTEGER,
  decision     TEXT NOT NULL,                        -- accepted | declined | ended_early |
                                                    -- timed_out
  PRIMARY KEY (hail_id, channel_id)
);

-- audit trail
CREATE TABLE IF NOT EXISTS hail_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  hail_id            INTEGER,
  ts                 INTEGER NOT NULL,
  kind               TEXT NOT NULL,                  -- opened | ring_started | accepted
                                                    -- | declined | ended_channel |
                                                    -- ended_all | close_silence
  actor_user_id      TEXT,
  target_channel_id  TEXT,
  note               TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT NOT NULL,
  payload_json  TEXT,
  at            INTEGER NOT NULL
);

-- cue assets, validated at startup
CREATE TABLE IF NOT EXISTS cue_sets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  locale       TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cue_assets (
  cue_set_id   INTEGER NOT NULL,
  cue          TEXT NOT NULL,                       -- ready | attention | ring | busy | end
  path         TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  PRIMARY KEY (cue_set_id, cue)
);
`;

export function openDb(path: string): DB {
  // `:memory:` is a valid path for tests and does not want a directory.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export type { DB };
