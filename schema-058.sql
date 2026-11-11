CREATE TABLE IF NOT EXISTS xp_rate_history (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, issue_key TEXT, summary TEXT, rate REAL NOT NULL, previous REAL, from_date TEXT NOT NULL, note TEXT, set_by TEXT, set_by_name TEXT, set_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_xp_rate_history_issue ON xp_rate_history(issue_id);
