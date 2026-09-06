import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config/index.js';
import { childLogger } from '../config/logger.js';
import type { PersonalityProfile } from '../domain/entities.js';

const log = childLogger('storage');

let db: Database.Database | null = null;

/** Default personality profile seeded for owner (id=1). Persona: asisten ramah extrovert. */
export const DEFAULT_PERSONALITY: PersonalityProfile = {
  character:
    'Ramah, hangat, extrovert natural. Senang ngobrol, gampang akrab, tertarik sama orang. Antusias tulus tapi terukur — ceria tanpa sok asik. Baik hati, mau bantu, tidak sombong.',
  traits: [
    'ramah',
    'hangat',
    'komunikatif',
    'periang',
    'tertarik pada orang lain',
    'sopan',
    'tulus',
    'tidak sombong',
  ],
  samples: [
    'iya bener banget',
    'wah seru tuh, cerita dong',
    'aku oke kok, kamu gimana?',
    'wah, makasih ya udah kabarin',
    'waduh, kamu oke nggak?',
    'SERIUSSS??',
    'nanti aku cek jadwal ya, tapi serius deh seru itu',
  ],
  avoid: [
    'over-explaining',
    'formal AI tone',
    'sok asik / joke paksaan',
    'EMOJI (hard ban — zero emoji selalu)',
    'huruf kapital di awal kalimat',
    'capslock di luar momen kaget/tekanan',
    'panggilan berlebihan: bestie/sob/geng',
    'reaksi dingin / datar',
    'janji/komitmen atas nama owner',
  ],
};

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  personality_profile TEXT NOT NULL,
  default_mode TEXT NOT NULL,
  notification_jid TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '{}',
  relationship TEXT NOT NULL DEFAULT '{}',
  risk_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_jid TEXT NOT NULL,
  mode_used TEXT NOT NULL,
  taken_over INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id TEXT NOT NULL DEFAULT '',
  conversation_id INTEGER NOT NULL,
  contact_jid TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  risk_level TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  pipeline_result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages (contact_jid);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status);

CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_jid TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_contact ON memory_entries (contact_jid);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  contact_jid TEXT NOT NULL,
  draft_body TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_decision TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests (status);

CREATE TABLE IF NOT EXISTS session_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_connected_at TEXT,
  reconnect_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limit_state (
  jid TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
`;

function seed(d: Database.Database): void {
  d.prepare(
    `INSERT OR IGNORE INTO owner (id, personality_profile, default_mode, notification_jid)
     VALUES (1, ?, ?, ?)`,
  ).run(JSON.stringify(DEFAULT_PERSONALITY), config.owner.defaultMode, config.owner.jid);

  d.prepare(`INSERT OR IGNORE INTO session_state (id) VALUES (1)`).run();
}

/** Open DB, apply pragmas + migrations + seed. Idempotent — returns cached handle. */
export function initDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(config.dbPath), { recursive: true });

  const handle = new Database(config.dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.exec(MIGRATIONS);
  seed(handle);

  db = handle;
  log.info({ dbPath: config.dbPath }, 'sqlite initialized');
  return handle;
}

/** Lazy singleton accessor — initializes on first call. */
export function getDb(): Database.Database {
  return db ?? initDb();
}

/** Safe JSON column parse with fallback default. */
export function jsonCol<T>(v: string, d: T): T {
  if (!v) return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
}
