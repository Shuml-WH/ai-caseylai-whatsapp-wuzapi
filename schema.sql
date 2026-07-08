-- D1 Database Schema for WuzAPI Worker
-- Run: npx wrangler d1 execute wuzapi-db --file=schema.sql

-- User bots registered via wuzapi
CREATE TABLE IF NOT EXISTS userbots (
  id TEXT PRIMARY KEY,            -- wuzapi user UUID
  name TEXT NOT NULL,             -- display name (e.g. "wa-bot")
  token TEXT NOT NULL,            -- auth token
  phone TEXT DEFAULT '',          -- WhatsApp JID/phone
  connected INTEGER DEFAULT 0,    -- 0/1
  logged_in INTEGER DEFAULT 0,    -- 0/1
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Message history
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userbot_name TEXT NOT NULL,     -- which bot
  phone TEXT NOT NULL,            -- destination/source phone
  text TEXT NOT NULL,             -- message body
  direction TEXT DEFAULT 'out',   -- 'in' or 'out'
  status TEXT DEFAULT 'sent',     -- sent, delivered, read, failed
  created_at TEXT DEFAULT (datetime('now'))
);

-- API keys for accessing the send-message endpoint
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,       -- the API key value
  name TEXT DEFAULT '',           -- label for this key
  active INTEGER DEFAULT 1,      -- 0/1
  created_at TEXT DEFAULT (datetime('now'))
);

-- Insert default admin API key
INSERT OR IGNORE INTO api_keys (key, name) VALUES ('my-admin-secret-token', 'Default Admin Key');
