CREATE TABLE IF NOT EXISTS active_timers (account_id TEXT PRIMARY KEY, job TEXT, current TEXT, state TEXT NOT NULL, dismissed TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tracker_stretches (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, issue_id TEXT, issue_key TEXT, kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, seconds INTEGER NOT NULL, description TEXT, call_id TEXT, status TEXT NOT NULL, worklog_id TEXT, error TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tracker_account ON tracker_stretches(account_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tracker_status ON tracker_stretches(status);
