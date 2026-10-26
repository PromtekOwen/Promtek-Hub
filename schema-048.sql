CREATE TABLE IF NOT EXISTS usage_daily (day TEXT NOT NULL, page TEXT NOT NULL, account TEXT NOT NULL, opens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, page, account));
ALTER TABLE employees ADD COLUMN last_seen_at TEXT;
