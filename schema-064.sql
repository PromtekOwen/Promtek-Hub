CREATE TABLE IF NOT EXISTS deleted_worklogs (worklog_id TEXT PRIMARY KEY, account_id TEXT, deleted_at TEXT NOT NULL);
ALTER TABLE xp_ledger ADD COLUMN tempo_updated_at TEXT;
