// Database setup using Node's built-in SQLite (node:sqlite).
// The database file is created automatically at data/letssport.db
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// DB_PATH lets tools (like the demo video build) use a separate database file.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'letssport.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sport       TEXT    NOT NULL CHECK (sport IN ('badminton', 'basketball')),
    title       TEXT    NOT NULL,
    date        TEXT    NOT NULL,  -- YYYY-MM-DD
    time        TEXT    NOT NULL,  -- HH:MM
    venue       TEXT    NOT NULL,
    max_players INTEGER NOT NULL DEFAULT 4,
    skill_level TEXT    NOT NULL DEFAULT 'All levels',
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS interests (
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (activity_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date, time);
`);

// Map location columns (added in v1.1 — migrate older databases in place).
const cols = db.prepare('PRAGMA table_info(activities)').all().map((c) => c.name);
if (!cols.includes('map_url')) db.exec('ALTER TABLE activities ADD COLUMN map_url TEXT');
if (!cols.includes('lat')) db.exec('ALTER TABLE activities ADD COLUMN lat REAL');
if (!cols.includes('lng')) db.exec('ALTER TABLE activities ADD COLUMN lng REAL');

module.exports = db;
