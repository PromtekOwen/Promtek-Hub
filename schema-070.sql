CREATE TABLE IF NOT EXISTS tablet_pins (account_id TEXT PRIMARY KEY, pin_hash TEXT NOT NULL, salt TEXT NOT NULL, set_at TEXT, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER);
CREATE TABLE IF NOT EXISTS tablet_sessions (token TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
