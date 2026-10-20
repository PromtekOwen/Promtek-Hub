CREATE TABLE IF NOT EXISTS staff_involved (issue_id TEXT NOT NULL, account_id TEXT NOT NULL, issue_key TEXT, status TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0, error TEXT, next_at INTEGER NOT NULL DEFAULT 0, queued_at TEXT NOT NULL, done_at TEXT, PRIMARY KEY (issue_id, account_id));
CREATE INDEX IF NOT EXISTS idx_staff_involved_due ON staff_involved(status, next_at);
