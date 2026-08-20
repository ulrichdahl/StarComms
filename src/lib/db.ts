/**
 * SQLite database — schema per spec §11.
 *
 * All §11 tables are created here on first open, even the ones step 2 doesn't
 * yet write to. Deferring migrations until later steps risks churn on live
 * data; the schema is short and stable enough to lay down whole. The boot
 * sweep (spec §11) depends on four of these tables existing before the fleet
 * connects: mute_state, sessions, channel_pool, relays.
 *
 * WAL is set on every open because a stale journal_mode would silently fall
 * back to rollback journalling with worse crash behaviour under concurrent
 * transcript writes (spec §11).
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
-- licensing
CREATE TABLE IF NOT EXISTS guilds (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  added_at            INTEGER NOT NULL,
  added_by            TEXT NOT NULL,
  slot_quota          INTEGER NOT NULL,
  status              TEXT NOT NULL,
  mode_default        TEXT NOT NULL,
  locale              TEXT NOT NULL,
  mute_mode           TEXT NOT NULL,
  stt_driver          TEXT NOT NULL,
  trigger_role_id     TEXT,
  category_id         TEXT,
  control_channel_id  TEXT,
  cue_set             TEXT NOT NULL,
  cue_duration_ms     INTEGER NOT NULL,
  open_timeout_ms     INTEGER NOT NULL,
  silence_close_ms    INTEGER NOT NULL,
  max_hold_ms         INTEGER NOT NULL,
  close_cue_enabled   INTEGER NOT NULL
);

-- fleet
CREATE TABLE IF NOT EXISTS bots (
  id                   TEXT PRIMARY KEY,
  nato                 TEXT NOT NULL,
  application_id       TEXT NOT NULL UNIQUE,
  token_ref            TEXT NOT NULL,
  is_controller        INTEGER NOT NULL,
  invite_permissions   TEXT
);
CREATE TABLE IF NOT EXISTS guild_bots (
  guild_id   TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, bot_id)
);
CREATE TABLE IF NOT EXISTS channel_pool (
  guild_id    TEXT NOT NULL,
  nato        TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  PRIMARY KEY (guild_id, nato)
);

-- cue assets — equal-duration validated at startup (spec §5)
CREATE TABLE IF NOT EXISTS cue_sets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  locale       TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cue_assets (
  cue_set_id   INTEGER NOT NULL,
  cue          TEXT NOT NULL,       -- ready|attention|horn|negative|busy|out
  path         TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  PRIMARY KEY (cue_set_id, cue)
);

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  mode          TEXT NOT NULL,
  lead_user_id  TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  teardown_at   INTEGER,
  mute_others   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_nets (
  session_id  INTEGER NOT NULL,
  nato        TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  bot_id      TEXT NOT NULL,
  role        TEXT NOT NULL,       -- command|squad|ops
  PRIMARY KEY (session_id, nato)
);

-- traffic
CREATE TABLE IF NOT EXISTS relays (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          INTEGER NOT NULL,
  verb                TEXT NOT NULL,
  source_nato         TEXT NOT NULL,
  speaker_user_id     TEXT NOT NULL,
  state               TEXT NOT NULL,      -- opening|open|closing|closed
  opened_at           INTEGER NOT NULL,
  closed_at           INTEGER,
  close_reason        TEXT,               -- silence|terminator|max_hold|preempted|open_timeout|session_end
  duration_ms         INTEGER,
  callup_transcript   TEXT,
  callup_confidence   REAL,
  body_transcript     TEXT,
  source_message_id   TEXT
);
CREATE TABLE IF NOT EXISTS relay_targets (
  relay_id     INTEGER NOT NULL,
  target_nato  TEXT NOT NULL,
  message_id   TEXT,
  delivered    INTEGER NOT NULL,
  skip_reason  TEXT,               -- busy|unavailable
  PRIMARY KEY (relay_id, target_nato)
);
CREATE TABLE IF NOT EXISTS acks (
  relay_id     INTEGER NOT NULL,
  target_nato  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  acked_at     INTEGER NOT NULL,
  PRIMARY KEY (relay_id, target_nato, user_id)
);

-- recognition
CREATE TABLE IF NOT EXISTS alias_variants (
  guild_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- callsign|verb
  canonical  TEXT NOT NULL,
  variant    TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, kind, variant)
);
CREATE TABLE IF NOT EXISTS misses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  session_id  INTEGER,
  heard       TEXT NOT NULL,
  at          INTEGER NOT NULL
);

-- crash safety + stats
CREATE TABLE IF NOT EXISTS mute_state (
  session_id  INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  prev_mute   INTEGER NOT NULL,
  set_at      INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
CREATE TABLE IF NOT EXISTS usage_daily (
  guild_id       TEXT NOT NULL,
  day            TEXT NOT NULL,       -- ISO date
  sessions       INTEGER NOT NULL,
  relays         INTEGER NOT NULL,
  voice_minutes  REAL NOT NULL,
  acks           INTEGER NOT NULL,
  misses         INTEGER NOT NULL,
  PRIMARY KEY (guild_id, day)
);
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT NOT NULL,
  payload_json  TEXT,
  at            INTEGER NOT NULL
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
